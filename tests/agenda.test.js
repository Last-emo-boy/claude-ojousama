// Unit checks for src/main/agenda.js: which background job is due, and the daily budget.
const { Agenda, repoStatus } = require('../src/main/agenda')
const { Growth } = require('../src/main/growth')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const MIN = 60000
const at = (h, m = 0) => new Date(2026, 9, 26, h, m).getTime() // a Monday, local time
const greet = (t) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

function fakePet({ settings = {}, growth = {}, idle = 30, acts = 0, actsAt = at(8), greetDay = '' } = {}) {
  const data = {
    settings: { agendaPerDay: 6, morningBrief: true, workspacePulse: true, cwd: 'C:\\work', rules: { agenda: 'auto' }, ...settings },
    growth: { xp: 0, level: 1, notes: [], diary: [], insights: [], learned: [], ...growth },
    stats: {},
    memories: [],
    activity: Array.from({ length: acts }, (_, i) => ({ ts: actsAt + i * 1000, icon: '•', text: 'x' + i })),
    pet: { lastGreetDay: greetDay },
    chat: { messages: [] },
  }
  const store = {
    get: (k) => data[k],
    set: (k, v) => (data[k] = v),
    patch: (k, p) => (data[k] = { ...data[k], ...p }),
  }
  return {
    store,
    growth: new Growth(store),
    settings: () => data.settings,
    rule: (n) => data.settings.rules[n] || 'auto',
    idleSec: () => idle,
    hasDsh: () => true,
    isQuiet: () => false,
    chatBusy: () => false,
    bgBusy: () => false,
  }
}

const cases = []
const check = (name, got, want) => cases.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
const due = (opts, t) => new Agenda(fakePet(opts)).dueJob(t)

// morning brief: right after the first activity of the day (greeting written in proactive.js format)
check('brief after greeting', due({ greetDay: greet(at(9)) }, at(9)), 'brief')
check('no brief before greeting', due({ greetDay: '' }, at(9)), null)
check('no brief twice', due({ greetDay: greet(at(9)), growth: { lastBriefDay: new Date(at(9)).toDateString() } }, at(9)), null)
check('no brief in the afternoon', due({ greetDay: greet(at(15)) }, at(15)), null)
check('brief can be switched off', due({ greetDay: greet(at(9)), settings: { morningBrief: false } }, at(9)), null)

// reflection: enough new activity, user away for a while
check('reflect while away', due({ idle: 9 * 60, acts: 12 }, at(15)), 'reflect')
check('no reflect with little new', due({ idle: 9 * 60, acts: 5 }, at(13)), null)
check('no reflect while present', due({ idle: 30, acts: 12 }, at(15)), null)
check('reflect late evening even if present', due({ idle: 30, acts: 12 }, at(22, 30)), 'reflect')
check('no reflect right after the last one', due({ idle: 9 * 60, acts: 12, growth: { lastReflectAt: at(14) } }, at(15)), 'tip')

// workspace pulse: once a day while away; can be switched off
const away = { idle: 11 * 60, acts: 12, growth: { lastReflectAt: at(14) } }
check('pulse while away', due(away, at(15)), 'pulse')
check('pulse off -> tip', due({ ...away, settings: { workspacePulse: false } }, at(15)), 'tip')
check('no pulse before 10', due({ ...away, acts: 0 }, at(9)), null)

// daily budget: 0 means none; tick never starts a job then
const p0 = fakePet({ idle: 11 * 60, acts: 12, settings: { agendaPerDay: 0 } })
const a0 = new Agenda(p0)
let started = null
a0.run = (job) => (started = job)
a0.tick(at(15))
check('budget 0 -> nothing starts', started, null)
check('budget 0 left', a0.budgetLeft() <= 0, true)
const p6 = fakePet({ idle: 11 * 60, acts: 12 })
const a6 = new Agenda(p6)
a6.run = (job) => (started = job)
a6.tick(at(15))
check('budget 6 -> reflect starts', started, 'reflect')
check('agenda rule off -> nothing', (() => {
  const p = fakePet({ idle: 11 * 60, acts: 12, settings: { rules: { agenda: 'off' } } })
  const a = new Agenda(p)
  let s = null
  a.run = (job) => (s = job)
  a.tick(at(15))
  return s
})(), null)

;(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ojousama-git-filter-'))
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:path.join(root,'empty-config') }
  delete env.GIT_TEMPLATE_DIR
  const git = (...args) => execFileSync('git', args, { cwd:root, env, encoding:'utf8', stdio:['ignore','pipe','pipe'] })
  try {
    git('init','-q')
    fs.writeFileSync(path.join(root,'.gitattributes'),'*.txt filter=fixture\n')
    fs.writeFileSync(path.join(root,'filter.sh'),'#!/bin/sh\nprintf invoked > filter-marker\ncat\n')
    git('config','filter.fixture.clean','sh filter.sh')
    fs.writeFileSync(path.join(root,'file.txt'),'before\n')
    git('add','file.txt','.gitattributes')
    git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','controlled baseline')
    fs.rmSync(path.join(root,'filter-marker'),{force:true})
    fs.writeFileSync(path.join(root,'file.txt'),'after!\n')
    git('-c','core.fsmonitor=false','status','--porcelain=v1')
    check('matched-length control invokes configured clean filter',fs.existsSync(path.join(root,'filter-marker')),true)
    fs.rmSync(path.join(root,'filter-marker'),{force:true})
    const plain = await repoStatus(root)
    check('read-only status reports changed file',plain.includes('file.txt'),true)
    check('read-only status does not execute clean filter',fs.existsSync(path.join(root,'filter-marker')),false)
    check('filter-limited status is labelled',plain.includes('未运行仓库过滤器'),true)
    git('config','filter.fixture.process','sh filter.sh')
    git('config','filter.fixture.required','true')
    const process = await repoStatus(root)
    check('required process filter can stay disabled without losing status',process.includes('file.txt'),true)
    check('process filter is not launched',fs.existsSync(path.join(root,'filter-marker')),false)
    check('repository filter settings stay unchanged',git('config','filter.fixture.required').trim(),'true')
    fs.writeFileSync(path.join(root,'.gitattributes'),'*.txt filter=fixture=odd\n')
    git('config','filter.fixture=odd.clean','sh filter.sh')
    git('config','filter.fixture=odd.process','sh filter.sh')
    git('config','filter.fixture=odd.required','true')
    const unusual = await repoStatus(root)
    check('literal equals in driver names cannot escape overrides',fs.existsSync(path.join(root,'filter-marker')),false)
    check('unusual driver still returns useful status',unusual.includes('file.txt'),true)
  } finally {
    fs.rmSync(root,{recursive:true,force:true})
  }
  const bad = cases.filter((c) => !c.ok)
  for (const c of bad) console.log('FAIL', c.name, 'got', JSON.stringify(c.got), 'want', JSON.stringify(c.want))
  console.log(`${cases.length - bad.length}/${cases.length} passed`)
  process.exitCode = bad.length ? 1 : 0
})().catch((error) => { console.error(error); process.exitCode=1 })
