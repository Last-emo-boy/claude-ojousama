'use strict'
// Tiny JSON-file store with debounced atomic writes. One file per app.
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  settings: {
    backend: 'codex',
    codexExe: '',
    codexModel: '',
    codexEffort: '',
    codexGlanceModel: '',
    codexGlanceEffort: '',
    scale: 1.5,
    permission: 'read-only', // read-only | workspace-write | danger-full-access
    provider: '', // empty -> inherit from the source DSH profile
    model: '',
    reasoningEffort: '', // empty -> inherit from the source DSH profile
    sourceProfile: 'desktop',
    cwd: '',
    dshExe: '',
    dshWebUrl: 'http://127.0.0.1:31787',
    loadAgentsMd: false,
    loadSkills: false,
    hotkey: 'CommandOrControl+Alt+Q',
    gravity: true,
    wander: true,
    proactive: true,
    mischief: 2, // 0 off .. 3 very naughty
    waterMinutes: 60,
    llmRemarkMinutes: 90, // 0 disables LLM-generated proactive remarks
    quietStart: '23:30',
    quietEnd: '08:00',
    userName: '',
    autoStart: false,
    nagMinutes: 5, // come back about an ignored alert after N minutes (0 = never)
    watchFolders: null, // null -> the Downloads folder
    // Rules for things she does on her own: auto | ask | off
    rules: { fileMove: 'ask', tidy: 'ask', open: 'auto', goals: 'auto', note: 'auto', screen: 'auto', research: 'auto', agenda: 'auto' },
    // Autonomy: quiet | normal | active
    autonomy: 'active',
    screenBlock: null, // null -> senses.DEFAULT_BLOCK
    distractions: null, // null -> senses.DEFAULT_DISTRACT
    quietInMeetings: true,
    hideOnFullscreen: true,
    clipboardWatch: true,
    focusGuard: true,
    climbWindows: true,
    idleActions: true,
    summaryTime: '18:30', // '' disables the daily summary
    glanceModel: '', // 'provider::model' for screen looks and autonomy decisions; '' = same as chat
    glanceEffort: '',
    weatherCity: '', // '' = no weather (nothing is fetched)
    agendaPerDay: 6, // background jobs she may start on her own per day (0 = none)
    morningBrief: true,
    workspacePulse: true, // read-only look at recently changed projects in the work folder while away
  },
  pet: { x: null, y: null, affection: 0, mood: 0, lastGreetDay: '', lastNightNag: '', lastNoteDay: '', lastSummaryDay: '', screenPauseUntil: 0, lastRainDay: '', lastGiftAt: 0 },
  growth: { xp: 0, level: 1, notes: [], diary: [], insights: [], learned: [], lastReflectAt: 0, reflectCursor: 0, reflectDay: '', reflectsToday: 0, lastBriefDay: '', lastPulseDay: '', lastTipDay: '', agendaDay: '', agendaRuns: 0 },
  stats: {}, // help kind -> { offered, accepted, declined, ignored }
  inbox: [], // suggestions waiting to be shown once
  chat: { sessionId: null, messages: [] },
  note: { pinned: true },
  watch: { seen: {}, pending: {} },
  tidyLog: { at: 0, moves: [], dirs: [] },
  todos: [],
  reminders: [],
  tasks: [],
  alerts: [], // things waiting for the user's acknowledgement (re-shown when ignored)
  goals: [],
  memories: [],
  activity: [],
}

const DEFAULT_RULES = DEFAULTS.settings.rules

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'pet-data.json')
    fs.mkdirSync(dir, { recursive: true })
    let data = {}
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {}
    this.data = {}
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (Array.isArray(v)) this.data[k] = Array.isArray(data[k]) ? data[k] : []
      else this.data[k] = { ...v, ...(data[k] || {}) }
    }
    // Upgrading an existing installation must not switch its agent or model.
    if (data.settings && !data.settings.backend) {
      this.data.settings.backend = 'dsh'
      if (!data.settings.permission) this.data.settings.permission = 'workspace-write'
    }
    // Nested defaults: keep rules added in newer versions.
    this.data.settings.rules = { ...DEFAULT_RULES, ...(this.data.settings.rules || {}) }
    this.timer = null
  }

  get(key) {
    return this.data[key]
  }

  set(key, value) {
    this.data[key] = value
    this.save()
  }

  patch(key, partial) {
    this.data[key] = { ...this.data[key], ...partial }
    this.save()
    return this.data[key]
  }

  save() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 300)
  }

  flush() {
    clearTimeout(this.timer)
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }
}

module.exports = { Store, DEFAULTS, DEFAULT_RULES }
