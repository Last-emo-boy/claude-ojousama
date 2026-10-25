'use strict'
// Autonomy loop. Every 5 s she checks the foreground window (and every 2 s the clipboard) and
// decides, in priority order: hide for fullscreen, hush in meetings, guard focus time,
// suggest a break after a long session, write the daily summary, react to music, rescue
// errors seen on screen, look when you switch to something new, look now and then, or do a
// small idle action (incl. sitting on the taskbar edge or climbing onto your window).
// Talking is rate-limited per autonomy level and backs off when she keeps being ignored.
const senses = require('./senses')
const { LINES, pick } = require('./persona')

const SEC = 1000
const MIN = 60 * SEC
const rand = (a, b) => a + Math.random() * (b - a)
// perHour: proactive remarks/offers; looksPerHour: model looks started on her own (cost cap).
const LEVELS = {
  quiet: { periodic: null, switchGap: 0, errorScan: 0, perHour: 1, looksPerHour: 0, idleEvery: [8, 14] },
  normal: { periodic: [18, 26], switchGap: 6 * MIN, errorScan: 75 * SEC, perHour: 4, looksPerHour: 5, idleEvery: [4, 8] },
  active: { periodic: [8, 12], switchGap: 3 * MIN, errorScan: 45 * SEC, perHour: 8, looksPerHour: 12, idleEvery: [2.5, 5] },
}
const MEETING_PROCS = ['Zoom', 'Teams', 'ms-teams', 'wemeetapp', 'WeMeet', 'TencentMeeting', 'VooVMeeting', 'webex', 'CiscoWebexStart']

class Brain {
  constructor(pet) {
    this.pet = pet
    this.timer = null
    this.clipTimer = null
    this.running = false
    this.fg = null
    this.fgKey = ''
    this.fgSince = 0
    this.switchHandledKey = ''
    this.lastSwitchLook = 0
    this.nextPeriodic = Date.now() + rand(2, 4) * MIN
    this.nextErrorScan = Date.now() + 30 * SEC
    this.nextMeetingCheck = 0
    this.meetingByProc = false
    this.seenErrors = new Map() // signature -> first seen
    this.lastError = null // { sig, line, info, at, offered, accepted, researched }
    this.session = { proc: '', since: 0, lastSeen: 0, nagged: false }
    this.spoke = [] // timestamps of proactive remarks/offers
    this.ignoredRow = 0
    this.backoffUntil = 0
    this.nextIdle = Date.now() + rand(1.5, 3) * MIN
    this.nextMusic = Date.now() + 20 * SEC
    this.lastSong = ''
    this.lastSongSaid = 0
    this.lastClip = null
    this.lastClipOffer = 0
    this.focusNudged = new Map()
    this.quiet = false // meeting
    this.hidden = false // fullscreen
    this.nextMoodDecay = Date.now() + 15 * MIN
  }

  start() {
    this.timer = setInterval(() => this.tick(), 5000)
    this.clipTimer = setInterval(() => this.checkClipboard().catch(() => {}), 2000)
    setTimeout(() => this.tick(), 6000)
  }

  stop() {
    clearInterval(this.timer)
    clearInterval(this.clipTimer)
  }

  level() {
    return LEVELS[this.pet.settings().autonomy] || LEVELS.active
  }

  /** Meetings and fullscreen keep her quiet (alerts still show). */
  isQuiet() {
    return this.quiet || this.hidden
  }

  async tick() {
    if (this.running) return
    this.running = true
    try {
      await this.step()
    } catch (e) {
      console.error('[brain]', e)
    } finally {
      this.running = false
    }
  }

  async step() {
    const pet = this.pet
    const now = Date.now()
    const info = await pet.screen.foreground().catch(() => null)
    this.fg = info
    this.handleFullscreen(info)
    await this.handleMeeting(info, now)
    // Background work she starts herself (memories, brief, workspace pulse, tips) and the weather.
    pet.agendaTick(now)
    pet.weatherTick(now).catch(() => {})
    if (!info) return
    if (info.key !== this.fgKey) {
      this.fgKey = info.key
      this.fgSince = now
    }
    if (!info.own && !info.shell) this.lastUser = { info, at: now } // the window the user really works in
    const idle = pet.idleSec()
    if (idle >= 300) this.session = { proc: '', since: 0, lastSeen: 0, nagged: false } // that was a break
    else this.trackSession(info, now)
    if (!pet.userPresent()) {
      this.maybePreResearch(now, idle)
      return
    }
    if (now >= this.nextMoodDecay) {
      this.nextMoodDecay = now + 15 * MIN
      pet.decayMood()
      pet.screen.sweep() // stray screenshots never linger
    }
    if (this.isQuiet()) return
    if (this.focusGuard(info, now)) return
    if (this.longSession(now)) return
    if (this.dailySummary()) return
    if (this.suggest(now)) return
    if (await this.music(now)) return
    if (await this.errorScan(info, now)) return
    if (this.switchLook(info, now)) return
    if (this.periodicLook(info, now)) return
    this.idleAction(info, now)
  }

  /** Results of her background work wait in an inbox; show one every couple of minutes. */
  suggest(now) {
    const pet = this.pet
    if (!pet.inboxCount() || now - (this.lastSuggest || 0) < 2 * MIN || !this.canSpeak(true)) return false
    this.lastSuggest = now
    pet.deliverSuggestion()
    return true
  }

  /** Scale a probability or an interval by how welcome this kind of help has been. */
  wants(kind) {
    return Math.random() < Math.min(1, this.pet.helpFactor(kind))
  }

  // ------------------------------------------------------------ talking budget

  canSpeak(urgent = false) {
    const pet = this.pet
    if (this.isQuiet() || pet.isBusy() || !pet.userPresent()) return false
    if (!urgent && Date.now() < this.backoffUntil) return false
    const hourAgo = Date.now() - 60 * MIN
    this.spoke = this.spoke.filter((t) => t > hourAgo)
    return urgent || this.spoke.length < this.level().perHour
  }

  noteSpoke() {
    this.spoke.push(Date.now())
  }

  /** Model looks she starts by herself are capped per hour (each one costs a model call). */
  canLook() {
    const hourAgo = Date.now() - 60 * MIN
    this.looks = (this.looks || []).filter((t) => t > hourAgo)
    return this.looks.length < this.level().looksPerHour
  }

  noteLook() {
    this.looks = this.looks || []
    this.looks.push(Date.now())
  }

  /** How the user answered something she started: 'accepted' | 'declined' | 'ignored'. */
  noteResponse(kind) {
    if (kind === 'ignored') {
      this.ignoredRow++
      if (this.ignoredRow >= 3) {
        // Three in a row without a reply: talk half as often for an hour.
        this.ignoredRow = 0
        this.backoffUntil = Date.now() + 60 * MIN
        this.pet.changeMood(-1, '一直没人理')
        this.pet.logActivity('look', '连续几次没人理我，接下来一小时少说点话')
      }
    } else this.ignoredRow = 0
  }

  backoff() {
    return Date.now() < this.backoffUntil ? 2 : 1
  }

  // ------------------------------------------------------------ situations

  handleFullscreen(info) {
    const pet = this.pet
    const want = !!(pet.settings().hideOnFullscreen && info && info.fullscreen && !info.own && pet.onDisplay(info.display.id))
    if (want !== this.hidden) {
      this.hidden = want
      pet.setHidden(want)
      if (want) pet.logActivity('look', `${info.process} 全屏了，我先躲起来`)
    }
  }

  async handleMeeting(info, now) {
    const pet = this.pet
    if (!pet.settings().quietInMeetings) {
      this.quiet = false
      return
    }
    if (now >= this.nextMeetingCheck) {
      this.nextMeetingCheck = now + 30 * SEC
      const wins = await pet.screen.processWindows(MEETING_PROCS).catch(() => [])
      this.meetingByProc = wins.some((w) => senses.MEETING_TITLE.test(w.title || ''))
    }
    const want = this.meetingByProc || !!(info && senses.isMeeting(info))
    if (want !== this.quiet) {
      this.quiet = want
      if (want) {
        pet.once('shush', 2) // no bubble: the screen may be shared
        pet.logActivity('look', '你在开会，我先安静')
      } else pet.logActivity('look', '会开完了')
    }
  }

  trackSession(info, now) {
    if (info.own || info.shell) return
    const s = this.session
    if (info.process === s.proc) {
      s.lastSeen = now
      return
    }
    // Short detours (< 3 min) to other apps keep the session going.
    if (s.proc && now - s.lastSeen < 3 * MIN) return
    this.session = { proc: info.process, since: now, lastSeen: now, nagged: false }
  }

  focusGuard(info, now) {
    const pet = this.pet
    if (!pet.settings().focusGuard || !pet.inFocus() || info.own) return false
    const hit = senses.isDistraction(info, pet.settings().distractions)
    if (!hit) return false
    const key = `${info.process}|${hit}`
    const last = this.focusNudged.get(key) || 0
    if (now - last < 5 * MIN || !this.canSpeak(true) || !this.wants('focus')) return false
    this.focusNudged.set(key, now)
    this.noteSpoke()
    const again = now - last < 15 * MIN // caught twice in a row: she gets properly cross
    pet.once(again ? 'angry' : 'sulk', 2)
    pet.logActivity('look', `专注时间看到「${hit}」，提醒了一下${again ? '（第二次）' : ''}`)
    pet
      .say(again ? `又是「${hit}」！番茄钟还没结束呢，快回去！` : `说好专注的呢～「${hit}」先放一放吧！`, {
        ttl: 15000,
        buttons: [
          { id: 'back', label: '马上回去' },
          { id: 'rest', label: '我想休息' },
        ],
      })
      .then((c) => {
        if (c === 'rest') pet.restNow()
        if (c === 'back') pet.changeMood(+1, '听话回去专注')
        if (c !== pet.REPLACED) pet.recordHelp('focus', c ? 'accepted' : 'ignored')
      })
    return true
  }

  longSession(now) {
    const pet = this.pet
    const s = this.session
    // 50 minutes by default; later if you usually wave the break reminder away.
    const after = Math.min(120, 50 / pet.helpFactor('break'))
    if (!s.proc || s.nagged || now - s.since < after * MIN || !this.canSpeak()) return false
    s.nagged = true
    this.noteSpoke()
    const mins = Math.round((now - s.since) / MIN)
    pet.once('stretch', 3)
    pet.logActivity('look', `你已经连续用 ${s.proc} ${mins} 分钟了，提醒休息`)
    pet
      .say(`已经连续用 ${pet.appName(s.proc)} ${mins} 分钟啦，起来伸个懒腰吧～`, {
        ttl: 20000,
        buttons: [
          { id: 'rest', label: '休息 5 分钟' },
          { id: 'no', label: '再干会儿' },
        ],
      })
      .then((c) => {
        if (c === 'rest') pet.restNow()
        if (c === pet.REPLACED) return
        const outcome = c === 'rest' ? 'accepted' : c === 'no' ? 'declined' : 'ignored'
        this.noteResponse(outcome)
        pet.recordHelp('break', outcome)
      })
    return true
  }

  dailySummary() {
    const pet = this.pet
    const t = String(pet.settings().summaryTime || '')
    const m = t.match(/^(\d{1,2}):(\d{2})$/)
    if (!m) return false
    const d = new Date()
    if (d.getHours() * 60 + d.getMinutes() < Number(m[1]) * 60 + Number(m[2])) return false
    if (pet.store.get('pet').lastSummaryDay === d.toDateString() || pet.isBusy()) return false
    pet.dailySummary()
    return true
  }

  async music(now) {
    const pet = this.pet
    if (now < this.nextMusic) return false
    this.nextMusic = now + 45 * SEC
    const wins = await pet.screen.processWindows(senses.MUSIC_PROCS).catch(() => [])
    const song = wins.map(senses.musicTitle).find(Boolean) || ''
    if (song === this.lastSong) return false
    this.lastSong = song
    if (!song || pet.isBusy() || pet.isPerched()) return false
    pet.once(pet.hasUnlock('dance') && Math.random() < 0.4 ? 'dance' : 'music', 4)
    if (now - this.lastSongSaid > 20 * MIN && Math.random() < 0.6 && this.canSpeak()) {
      this.lastSongSaid = now
      this.noteSpoke()
      pet.say(`在听《${song}》呀～我也跟着晃一晃♪`, { ttl: 5000 })
    }
    return true
  }

  /** Cheap local OCR scan; only a fresh, real-looking error wakes the model. */
  async errorScan(info, now) {
    const pet = this.pet
    const L = this.level()
    if (!L.errorScan || now < this.nextErrorScan || pet.isBusy()) return false // busy: scan again next time
    this.nextErrorScan = now + L.errorScan * this.backoff()
    if (info.own || info.shell || info.fullscreen || !pet.screenAllowed(info)) return false
    let img
    try {
      img = await pet.screen.capture(info)
    } catch {
      return false
    }
    const text = await pet.screen.ocr(img, 'en').catch(() => '')
    const err = senses.findError(text)
    if (!err) return false
    const sig = senses.errorSignature(err.line)
    for (const [k, t] of this.seenErrors) if (now - t > 6 * 3600e3) this.seenErrors.delete(k)
    if (this.seenErrors.has(sig)) return false
    if (!this.canSpeak(true)) return false // not now: the same error is found again on a later scan
    this.seenErrors.set(sig, now)
    if (!this.wants('rescue')) return false // she has learned you usually handle errors yourself
    this.lastError = { sig, line: err.line, ocr: text.slice(0, 2000), info, at: now, offered: true, accepted: false, declined: false, researched: false }
    pet.rescueError(this.lastError)
    return true
  }

  switchLook(info, now) {
    const L = this.level()
    if (!L.switchGap || info.own || info.shell || info.key === this.switchHandledKey) return false
    if (now - this.fgSince < 20 * SEC) return false // stayed on it for a moment
    this.switchHandledKey = info.key
    if (now - this.lastSwitchLook < (L.switchGap * this.backoff()) / this.pet.helpFactor('remark')) return false
    if (!this.pet.screenAllowed(info) || !this.canSpeak() || !this.canLook()) return false
    this.lastSwitchLook = now
    this.noteLook()
    this.pet.autoLook('switch', info)
    return true
  }

  periodicLook(info, now) {
    const L = this.level()
    if (!L.periodic || now < this.nextPeriodic) return false
    this.nextPeriodic = now + (rand(L.periodic[0], L.periodic[1]) * MIN * this.backoff()) / this.pet.helpFactor('remark')
    if (info.own || info.shell || !this.pet.screenAllowed(info) || !this.canSpeak() || !this.canLook()) return false
    this.noteLook()
    this.pet.autoLook('periodic', info)
    return true
  }

  idleAction(info, now) {
    const pet = this.pet
    const s = pet.settings()
    // While she sits on a window she just sits (desk scenes would float in mid-air).
    if (!s.idleActions || now < this.nextIdle || pet.isBusy() || pet.isPerched()) return false
    const L = this.level()
    this.nextIdle = now + rand(L.idleEvery[0], L.idleEvery[1]) * MIN
    const mood = pet.mood()
    const d = new Date()
    const h = d.getHours()
    const weekend = d.getDay() === 0 || d.getDay() === 6
    const pool = ['read', 'eat', 'water', 'stretch', 'phone', 'write', 'clean', 'sit']
    if ((h >= 13 && h <= 16) || h >= 22 || h < 6) pool.push('yawn', 'yawn')
    if (h >= 18 || weekend) pool.push('relax', 'relax', 'phone')
    if (this.lastSong) pool.push('music', 'music', ...(pet.hasUnlock('dance') ? ['dance', 'dance'] : []))
    if (pet.raining()) pool.push('umbrella', 'umbrella', 'umbrella')
    if (mood <= -2) pool.push('sulk', 'sulk', 'cry')
    if (mood >= 2) pool.push('cheer', 'giggle', 'laugh')
    // Sitting on your windows is her favourite; the taskbar edge is the fallback.
    if (s.climbWindows) pool.push('climb', 'climb', 'climb', 'climb')
    if (pet.hasUnlock('kitten')) pool.push('kitten')
    if (pet.hasUnlock('magic')) pool.push('magic')
    if (pet.hasUnlock('cheersign') && this.session.proc && now - this.session.since > 30 * MIN) pool.push('cheersign', 'cheersign')
    if (pet.hasUnlock('gift') && now - (pet.store.get('pet').lastGiftAt || 0) > 3 * 864e5) pool.push('gift')
    const act = pick(pool)
    if (act === 'sit') pet.perchOnTaskbar(rand(30, 75) * SEC)
    else if (act === 'climb') pet.climbAuto()
    else if (['kitten', 'magic', 'cheersign', 'gift'].includes(act)) pet.idleScene(act)
    else {
      pet.once(act, ['read', 'music', 'phone', 'write', 'relax', 'clean', 'umbrella'].includes(act) ? 4 : 2)
      const lines = LINES.idle[act]
      if (lines && Math.random() < 0.3) pet.say(pick(lines), { ttl: 4000 })
    }
    return true
  }

  /** The user left right after an error showed up: look into it while they are away. */
  maybePreResearch(now, idle) {
    const e = this.lastError
    if (!e || e.accepted || e.declined || e.researched || idle < 180 || now - e.at > 15 * MIN) return
    // Sending screen content while the user is away needs both rules on "auto".
    if (this.pet.rule('research') === 'off' || this.pet.rule('screen') !== 'auto') return
    e.researched = true
    this.pet.preResearch(e)
  }

  async checkClipboard() {
    const pet = this.pet
    if (!pet.settings().clipboardWatch) return
    const text = String((await pet.readClipboard()) || '')
    if (this.lastClip === null || text === this.lastClip) {
      this.lastClip = text // first read is only a baseline
      return
    }
    this.lastClip = text
    // Copies made in a blocked window (password manager, bank…) or during a pause are never touched.
    if (pet.screenPaused() || (this.fg && senses.isBlocked(this.fg, pet.settings().screenBlock))) return
    const kind = senses.classifyClip(text)
    if (!kind) return
    const now = Date.now()
    if (now - this.lastClipOffer < 2 * MIN || !this.canSpeak(true)) return
    this.lastClipOffer = now
    if (!this.wants('clip')) return // learned: you rarely want help with what you copy
    this.noteSpoke()
    pet.clipOffer(text, kind)
  }
}

module.exports = { Brain, LEVELS }
