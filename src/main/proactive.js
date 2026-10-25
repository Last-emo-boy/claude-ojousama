'use strict'
// Proactive behaviour. Every 15 s the scheduler decides, in priority order:
//   alerts (reminders, due todos, goal questions) that come back when ignored,
//   a catch-up when the user returns, goal check-ins and their reports,
//   watch-folder tidying, the daily sticky note, greetings, water breaks,
//   mischief, LLM remarks and wandering.
// The tick never waits for the user: bubbles resolve in the background.
const { LINES, pick, fmtTime } = require('./persona')

const MIN = 60000
const NAG_MAX = 3 // an ignored alert is shown at most this many times
const LATER_MIN = [60, 180, 1440] // "晚点再说" back-off
const AWAY_SEC = 120
const rand = (a, b) => a + Math.random() * (b - a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dayKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
const clip = (s, n = 30) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s))

function inQuietHours(settings, d = new Date()) {
  const toMin = (s) => {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/)
    return m ? Number(m[1]) * 60 + Number(m[2]) : null
  }
  const a = toMin(settings.quietStart)
  const b = toMin(settings.quietEnd)
  if (a == null || b == null || a === b) return false
  const now = d.getHours() * 60 + d.getMinutes()
  return a < b ? now >= a && now < b : now >= a || now < b
}

/** Mean minutes between pranks for each mischief level. */
const PRANK_MEAN = { 1: 55, 2: 28, 3: 11 }

const ALERT_ICON = { reminder: '⏰', 'todo-soon': '📌', 'todo-overdue': '⚠️', 'goal-ask': '🎯' }
const ALERT_TITLE = { reminder: 'Claude Ojousama 提醒你', 'todo-soon': '待办快到时间啦', 'todo-overdue': '待办过期啦', 'goal-ask': '需要你拍板' }
const ALERT_BUTTONS = {
  reminder: [
    { id: 'ok', label: '知道啦' },
    { id: 'snooze', label: '10 分钟后' },
  ],
  'todo-soon': [
    { id: 'done', label: '已经完成' },
    { id: 'ok', label: '马上做' },
  ],
  'todo-overdue': [
    { id: 'done', label: '完成了' },
    { id: 'later', label: '推迟 1 小时' },
  ],
}

class Proactive {
  constructor(pet) {
    this.pet = pet
    this.timer = null
    this.running = false
    this.sleeping = false
    this.away = false
    this.awaySince = 0
    this.showing = null // id of the alert (or 'catchup') currently in the bubble
    this.activeMs = 0
    this.lastTick = Date.now()
    this.nextPrank = Date.now() + rand(6, 14) * MIN
    this.nextWander = Date.now() + rand(3, 7) * MIN
    this.nextMutter = Date.now() + rand(15, 30) * MIN
    this.nextRemark = Date.now() + rand(0.5, 1) * (pet.settings().llmRemarkMinutes || 90) * MIN
    this.nextWatch = Date.now() + 20000
  }

  start() {
    this.timer = setInterval(() => this.tick(), 15000)
    setTimeout(() => this.tick(), 4000)
  }

  stop() {
    clearInterval(this.timer)
  }

  schedulePrank() {
    const lvl = this.pet.settings().mischief
    const mean = PRANK_MEAN[lvl]
    this.nextPrank = mean ? Date.now() + rand(0.5, 1.5) * mean * MIN : Infinity
  }

  async tick() {
    if (this.running) return
    this.running = true
    try {
      await this.step()
    } catch (e) {
      console.error('[proactive]', e)
    } finally {
      this.running = false
    }
  }

  async step() {
    const pet = this.pet
    const s = pet.settings()
    const now = Date.now()
    const dt = now - this.lastTick
    this.lastTick = now
    const idle = pet.idleSec()

    this.checkReminders(now)
    this.checkTodos(now)
    this.validateAlerts()
    pet.checkGoals(now) // background follow-through runs even while the user is away

    // Presence: doze off when the user is gone, catch them up when they return.
    const away = idle >= AWAY_SEC
    if (away && !this.away) {
      this.away = true
      this.awaySince = now - idle * 1000
    }
    if (idle >= 300 && !this.sleeping && !pet.isBusy()) {
      this.sleeping = true
      pet.setSleeping(true)
    }
    // Gone for a long time (or it is night): she curls up on her cushion for a proper nap.
    if (this.sleeping && this.sleeping !== 'nap' && (idle >= 20 * 60 || inQuietHours(s))) {
      this.sleeping = 'nap'
      pet.setSleeping('nap')
    }
    if (!away && this.away) {
      this.away = false
      const gone = now - this.awaySince
      if (this.sleeping) {
        this.sleeping = false
        pet.setSleeping(false)
      }
      if (this.catchUp(gone)) return
      if (s.proactive && gone > 10 * MIN && !inQuietHours(s) && pet.canInterrupt()) {
        pet.once('surprise', 1)
        const soon = pet.store.get('todos').filter((t) => !t.done && t.due && t.due - now < 3 * 60 * MIN)
        pet.say(pick(LINES.welcome) + (soon.length ? `\n别忘了「${soon[0].text}」（${fmtTime(soon[0].due)}）～` : ''), { ttl: 7000 })
        return
      }
    }
    if (idle < 60) this.activeMs += dt
    if (away) return

    // Things the user has to acknowledge come first.
    if (this.deliverAlerts(now)) return
    if (pet.unreadGoals().length && pet.canInterrupt() && !pet.isBusy()) {
      pet.deliverGoalReports()
      return
    }

    if (!s.proactive || pet.isBusy() || this.sleeping || idle > 60 || pet.isQuiet()) return
    const quiet = inQuietHours(s)
    const petState = pet.store.get('pet')

    // First activity of the day.
    const today = dayKey()
    if (petState.lastGreetDay !== today && new Date().getHours() >= 5 && !quiet) {
      pet.store.patch('pet', { lastGreetDay: today })
      pet.gainXp(5, '新的一天')
      const open = pet.store.get('todos').filter((t) => !t.done)
      pet.once('wave', 2)
      const weather = pet.weatherLine()
      const list = (open.length ? `\n还没做完的：${open.slice(0, 3).map((t) => `「${t.text}」`).join('、')}` : '') + (weather ? `\n今天：${weather}` : '')
      const buttons = [{ id: 'plan', label: '帮我规划今天' }]
      if (open.length) buttons.push({ id: 'note', label: '贴成便签' })
      buttons.push({ id: 'later', label: '等会儿' })
      pet.say(pick(LINES.morning) + list, { ttl: 20000, buttons }).then((choice) => {
        if (choice === 'plan') pet.planToday()
        if (choice === 'note') pet.postTodoNote()
      })
      return
    }

    // Late-night nag, once per night.
    if (quiet) {
      const night = dayKey(new Date(now - 8 * 60 * MIN))
      if (petState.lastNightNag !== night) {
        pet.store.patch('pet', { lastNightNag: night })
        pet.once('sleep', 2)
        pet.say(`已经 ${fmtTime(now, false)} 啦。` + pick(LINES.night), { ttl: 8000 })
      }
      return
    }

    // Proactive attention: new downloads waiting to be tidied.
    if (now >= this.nextWatch) {
      this.nextWatch = now + MIN
      const files = await pet.scanWatch(now)
      if (files.length) {
        pet.offerTidy(files)
        return
      }
    }

    // Once a day, pin today's todos to the desktop as a sticky note.
    const noteRule = pet.rule('note')
    const todayStr = new Date().toDateString()
    if (noteRule !== 'off' && !pet.noteOpen() && petState.lastNoteDay !== todayStr && new Date().getHours() >= 9) {
      const open = pet.store.get('todos').filter((t) => !t.done)
      if (open.length >= 2) {
        pet.store.patch('pet', { lastNoteDay: todayStr })
        if (noteRule === 'auto') pet.postTodoNote({ line: `今天有 ${open.length} 件事要做，我写成便签贴出来～` })
        else
          pet
            .say(`今天有 ${open.length} 件待办，要我写成便签贴到桌面上吗？`, {
              ttl: 20000,
              buttons: [
                { id: 'yes', label: '贴吧' },
                { id: 'no', label: '不用' },
              ],
            })
            .then((c) => c === 'yes' && pet.postTodoNote())
        return
      }
    }

    if (s.waterMinutes > 0 && this.activeMs >= s.waterMinutes * MIN) {
      this.activeMs = 0
      pet.once('water', 3)
      pet.say(pick(LINES.water), { ttl: 7000 })
      return
    }

    if (now >= this.nextPrank) {
      this.schedulePrank()
      if (s.mischief > 0) {
        pet.prank()
        return
      }
    }

    if (s.llmRemarkMinutes > 0 && now >= this.nextRemark) {
      this.nextRemark = now + rand(0.8, 1.2) * s.llmRemarkMinutes * MIN
      pet.remark()
      return
    }

    if (now >= this.nextMutter) {
      this.nextMutter = now + rand(20, 45) * MIN
      pet.say(pick(LINES.mutter), { ttl: 5000 })
      return
    }

    if (s.wander && now >= this.nextWander) {
      this.nextWander = now + rand(4, 10) * MIN
      if (!pet.isPerched()) pet.wander() // sitting on a window: stay put
    }
  }

  // ------------------------------------------------------------ alerts

  /** Queue something the user must acknowledge; shown now if possible, re-shown if ignored. */
  raise({ kind, refId, text, buttons, options, toast }) {
    const pet = this.pet
    const same = (a) => a.refId === refId && (a.kind === kind || (a.kind.startsWith('todo') && kind.startsWith('todo')))
    const alerts = pet.store.get('alerts').filter((a) => !same(a) || a.id === this.showing)
    const a = { id: pet.uid('al'), kind, refId, text, buttons: buttons || null, options: options || null, count: 0, nextAt: Date.now(), createdAt: Date.now() }
    alerts.push(a)
    pet.store.set('alerts', alerts)
    if (toast !== false) pet.notify(ALERT_TITLE[kind] || 'Claude Ojousama', String(text).replace(/^[^\n]*\n❓/, '❓'))
    pet.logActivity(kind === 'goal-ask' ? 'ask' : 'remind', text)
    setTimeout(() => this.deliverAlerts(Date.now()), 50)
    return a
  }

  patchAlert(id, patch) {
    const st = this.pet.store
    st.set('alerts', st.get('alerts').map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  removeAlert(id) {
    const st = this.pet.store
    st.set('alerts', st.get('alerts').filter((a) => a.id !== id))
  }

  /** Drop alerts whose todo/reminder/goal is gone or already handled. */
  validateAlerts() {
    const st = this.pet.store
    const todos = new Map(st.get('todos').map((t) => [t.id, t]))
    const reminders = new Set(st.get('reminders').map((r) => r.id))
    const goals = new Map(st.get('goals').map((g) => [g.id, g]))
    const alerts = st.get('alerts')
    const keep = alerts.filter((a) => {
      if (a.id === this.showing) return true
      if (a.kind === 'reminder') return reminders.has(a.refId)
      if (a.kind.startsWith('todo')) {
        const t = todos.get(a.refId)
        return !!t && !t.done
      }
      if (a.kind === 'goal-ask') {
        const g = goals.get(a.refId)
        return !!g && !!g.question && g.status === 'active'
      }
      return true
    })
    if (keep.length !== alerts.length) st.set('alerts', keep)
  }

  /** Show the oldest due alert if the user is here and the pet can talk. */
  deliverAlerts(now = Date.now()) {
    const pet = this.pet
    if (this.showing || !pet.canInterrupt() || !pet.userPresent()) return false
    const due = pet.store
      .get('alerts')
      .filter((a) => a.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt || a.createdAt - b.createdAt)
    if (!due.length) return false
    this.deliver(due[0]).catch((e) => {
      this.showing = null
      console.error('[alert]', e)
    })
    return true
  }

  async deliver(a) {
    const pet = this.pet
    this.showing = a.id
    const count = (a.count || 0) + 1
    this.patchAlert(a.id, { count, nextAt: Date.now() + 3600e3 })
    const icon = ALERT_ICON[a.kind] || '🔔'
    const urgent = a.kind !== 'goal-ask' // a pending decision is never worth a shaking screen
    let text = a.kind === 'goal-ask' ? a.text : `${icon} ${a.text}`
    // Escalate when ignored: knock on the screen, then knock harder.
    if (urgent && count === 2) {
      text = pick(LINES.nag2) + '\n' + text
      await pet.motion.shake(450, 5)
    } else if (urgent && count >= 3) {
      text = pick(LINES.nag3) + '\n' + text
      await pet.motion.shake(450, 6)
      await sleep(200)
      await pet.motion.shake(450, 6)
      pet.notify('还在等你回应', String(a.text).replace(/^[^\n]*\n❓/, '❓'))
    }
    pet.once(count === 1 || !urgent ? 'wave' : 'sulk', 2)
    const buttons = a.buttons || ALERT_BUTTONS[a.kind] || [{ id: 'ok', label: '知道啦' }]
    const choice = await pet.say(text, { ttl: 45000, buttons })
    this.showing = null
    if (choice === pet.REPLACED) {
      // Something else took the bubble before the user could answer: that is not "ignored".
      this.patchAlert(a.id, { count: count - 1, nextAt: Date.now() + 20000 })
      return
    }
    if (choice && choice !== 'later') {
      this.removeAlert(a.id)
      this.applyChoice(a, choice)
      const label = (buttons.find((b) => b.id === choice) || {}).label || choice
      pet.logActivity(a.kind === 'goal-ask' ? 'ask' : 'remind', `${clip(a.text, 40)} → ${label}`)
      setTimeout(() => this.deliverAlerts(Date.now()), 600) // something else may be waiting
      return
    }
    if (choice === 'later') {
      if (a.kind === 'todo-overdue') {
        this.removeAlert(a.id)
        this.applyChoice(a, choice)
        pet.logActivity('remind', `${clip(a.text, 40)} → 推迟 1 小时`)
      } else {
        // Deferred on purpose: calm re-asks that back off (1 h, 3 h, then daily).
        const later = (a.later || 0) + 1
        this.patchAlert(a.id, { count: 0, later, nextAt: Date.now() + LATER_MIN[Math.min(later, LATER_MIN.length) - 1] * MIN })
        pet.logActivity('nag', `「${clip(a.text, 40)}」稍后再问`)
      }
      return
    }
    const nag = Number(pet.settings().nagMinutes) || 0
    if (!urgent) {
      // Unanswered decision: ask again later a couple of times, then leave it in the panel.
      if (count < NAG_MAX) this.patchAlert(a.id, { nextAt: Date.now() + Math.max(30, nag) * MIN })
      else {
        this.removeAlert(a.id)
        pet.logActivity('ask', `「${clip(a.text, 40)}」先放在面板的「目标」里等你回答`)
      }
      return
    }
    if (nag > 0 && count < NAG_MAX) {
      this.patchAlert(a.id, { nextAt: Date.now() + nag * MIN })
      pet.logActivity('nag', `「${clip(a.text, 40)}」没回应，${nag} 分钟后再来提醒（第 ${count} 次）`)
    } else {
      this.removeAlert(a.id)
      pet.logActivity('nag', `「${clip(a.text, 40)}」提醒了 ${count} 次都没回应，先放下了`)
      pet.changeMood(-1, '提醒了三次都没人理')
      pet.once('cry', 2)
    }
  }

  applyChoice(a, c) {
    const pet = this.pet
    switch (a.kind) {
      case 'reminder':
        if (c === 'snooze') pet.addReminder(a.text, Date.now() + 10 * MIN)
        break
      case 'todo-soon':
        if (c === 'done') pet.updateTodo(a.refId, { done: true, doneAt: Date.now() })
        break
      case 'todo-overdue':
        if (c === 'done') pet.updateTodo(a.refId, { done: true, doneAt: Date.now() })
        if (c === 'later') pet.updateTodo(a.refId, { due: Date.now() + 60 * MIN, warned: false, overdue: false })
        break
      default:
        pet.onAlertChoice(a, c)
    }
  }

  /** The user is back: summarise what happened meanwhile. Returns true if she spoke. */
  catchUp(gone) {
    const pet = this.pet
    if (this.showing || !pet.canInterrupt()) return false
    const now = Date.now()
    const pending = pet.store.get('alerts').filter((a) => a.nextAt <= now + MIN)
    const reports = pet.unreadGoals()
    const inbox = pet.inboxCount() // things she prepared in the background while you were away
    const total = pending.length + reports.length + (inbox ? 1 : 0)
    if (!total || (total === 1 && gone < 10 * MIN)) return false // a single item is shown normally
    const lines = [
      ...pending.map((a) => `${ALERT_ICON[a.kind] || '🔔'} ${clip(String(a.text).split('\n').pop().replace(/^❓\s*/, ''), 26)}`),
      ...reports.map((g) => `🎯「${clip(g.title, 14)}」有新进展`),
      ...(inbox ? [`💡 我在你不在时准备了 ${inbox} 件事，等下慢慢说`] : []),
    ]
    this.showing = 'catchup'
    pet.once('wave', 2)
    pet
      .say(`欢迎回来！你不在的时候：\n${lines.slice(0, 5).join('\n')}${lines.length > 5 ? `\n…还有 ${lines.length - 5} 条` : ''}`, {
        ttl: 40000,
        buttons: [
          { id: 'one', label: '一条条看' },
          { id: 'ack', label: '都知道了' },
        ],
      })
      .then((c) => {
        this.showing = null
        if (c === 'ack') {
          // Reminders and todo alerts are acknowledged; goal questions stay open.
          const ids = new Set(pending.filter((a) => a.kind !== 'goal-ask').map((a) => a.id))
          pet.store.set('alerts', pet.store.get('alerts').filter((a) => !ids.has(a.id)))
          for (const g of reports) pet.markGoalRead(g.id)
          pet.logActivity('catchup', `回来后一次确认了 ${ids.size} 条提醒`)
        } else if (c === 'one') {
          for (const a of pending) this.patchAlert(a.id, { nextAt: now })
          setTimeout(() => this.deliverAlerts(Date.now()), 400)
        }
      })
    pet.logActivity('catchup', `你离开了 ${Math.round(gone / MIN)} 分钟，回来后汇报了 ${total} 件事`)
    return true
  }

  checkReminders(now) {
    const pet = this.pet
    const due = pet.store.get('reminders').filter((r) => !r.fired && r.at <= now)
    for (const r of due) {
      if (r.repeat === 'daily') {
        let next = r.at
        while (next <= now) next += 24 * 60 * MIN
        pet.updateReminder(r.id, { at: next })
      } else pet.updateReminder(r.id, { fired: true })
      const late = now - r.at > 5 * MIN ? `（原定 ${fmtTime(r.at, false)}）` : ''
      this.raise({ kind: 'reminder', refId: r.id, text: r.text + late })
    }
  }

  checkTodos(now) {
    const pet = this.pet
    for (const t of pet.store.get('todos')) {
      if (t.done || !t.due) continue
      if (!t.warned && t.due - now <= 10 * MIN && t.due > now) {
        pet.updateTodo(t.id, { warned: true })
        this.raise({ kind: 'todo-soon', refId: t.id, text: `「${t.text}」快到截止时间啦（${fmtTime(t.due, false)}）！` })
      } else if (!t.overdue && now > t.due) {
        pet.updateTodo(t.id, { overdue: true, warned: true })
        this.raise({ kind: 'todo-overdue', refId: t.id, text: `「${t.text}」已经过了截止时间（${fmtTime(t.due, false)}）……要改个时间还是标记完成？` })
      }
    }
  }
}

module.exports = { Proactive, inQuietHours, NAG_MAX }
