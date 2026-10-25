'use strict'
/* global pet */
const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]
let snap = null
let renderedChatCount = -1

// ------------------------------------------------------------ helpers

const pad = (n) => String(n).padStart(2, '0')
function fmt(ts, withDate = true) {
  if (!ts) return ''
  const d = new Date(ts)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (!withDate) return t
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return `今天 ${t}`
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${t}`
}
function toLocalInput(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(v) {
  return v ? v.replace('T', ' ') : null
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
function formatText(raw) {
  return String(raw)
    .split(/```[\w-]*\n?([\s\S]*?)(?:```|$)/g)
    .map((p, i) => (i % 2 ? `<pre>${escapeHtml(p.replace(/\n$/, ''))}</pre>` : escapeHtml(p).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')))
    .join('')
}
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else if (k === 'html') e.innerHTML = v
    else e.setAttribute(k, v)
  }
  for (const c of children) if (c != null) e.append(c)
  return e
}

// ------------------------------------------------------------ tabs

function showTab(name) {
  $$('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name))
  if (name === 'chat') setTimeout(() => $('#chat-input').focus(), 30)
}
$$('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)))
pet.on('panel:tab', showTab)

// ------------------------------------------------------------ render

function renderChat() {
  const msgs = snap.chat.messages
  const box = $('#messages')
  if (msgs.length === renderedChatCount) return
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40
  box.innerHTML = ''
  if (!msgs.length) box.append(el('div', { class: 'empty' }, '还没有聊天记录～在下面说点什么吧'))
  for (const m of msgs) {
    box.append(el('div', { class: 'msg ' + m.role, html: formatText(m.text) + `<time>${fmt(m.ts)}</time>` }))
  }
  if (atBottom || renderedChatCount < 0) box.scrollTop = box.scrollHeight
  renderedChatCount = msgs.length
}

function renderTodos() {
  const list = $('#todo-list')
  list.innerHTML = ''
  const todos = [...snap.todos].sort((a, b) => a.done - b.done || (a.due || 9e15) - (b.due || 9e15))
  if (!todos.length) list.append(el('li', { class: 'empty' }, '没有待办，轻松一下～'))
  for (const t of todos) {
    const late = !t.done && t.due && t.due < Date.now()
    list.append(
      el(
        'li',
        { class: t.done ? 'done' : '' },
        el('input', { type: 'checkbox', ...(t.done ? { checked: '' } : {}), onchange: (e) => pet.invoke('todo:update', { id: t.id, patch: { done: e.target.checked, doneAt: Date.now() } }) }),
        el('span', { class: 'txt' }, t.text),
        t.due ? el('span', { class: 'due' + (late ? ' late' : '') }, fmt(t.due)) : null,
        el('button', { title: '删除', onclick: () => pet.invoke('todo:remove', t.id) }, '✕'),
      ),
    )
  }
  const rl = $('#rem-list')
  rl.innerHTML = ''
  const rems = snap.reminders.filter((r) => !r.fired).sort((a, b) => a.at - b.at)
  if (!rems.length) rl.append(el('li', { class: 'empty' }, '没有提醒'))
  for (const r of rems) {
    rl.append(el('li', {}, el('span', { class: 'txt' }, r.text), el('span', { class: 'due' }, fmt(r.at) + (r.repeat ? ' · 每天' : '')), el('button', { onclick: () => pet.invoke('reminder:remove', r.id) }, '✕')))
  }
  const p = snap.pomodoro
  $('#pomo-state').textContent = p ? `${p.phase === 'focus' ? '专注中' : '休息中'}，${fmt(p.endsAt, false)} 结束` : ''
}

function renderTasks() {
  const list = $('#task-list')
  list.innerHTML = ''
  if (!snap.tasks.length) list.append(el('li', { class: 'empty' }, '还没有后台任务'))
  for (const t of snap.tasks) {
    const label = { running: '进行中', done: '完成', error: '失败' }[t.status] || t.status
    list.append(
      el(
        'li',
        {},
        el(
          'div',
          { class: 'head' },
          el('span', { class: 'badge ' + t.status }, label),
          el('b', { class: 'grow' }, t.title),
          el('span', { class: 'muted' }, fmt(t.startedAt)),
          t.status === 'running' ? el('button', { onclick: () => pet.invoke('task:cancel', t.id) }, '取消') : el('button', { onclick: () => pet.invoke('task:remove', t.id) }, '删除'),
        ),
        t.activity ? el('div', { class: 'muted' }, t.activity) : null,
        t.result ? el('div', { class: 'result', html: formatText(t.result) }) : null,
      ),
    )
  }
}

const EVERY_LABEL = { hourly: '每小时', '3h': '每 3 小时', daily: '每天' }

function goalStatus(g) {
  if (g.running) return ['running', '跟进中…']
  if (g.status === 'done') return ['done', '完成']
  if (g.status === 'paused') return ['paused', '暂停']
  if (g.question) return ['ask', '等你拍板']
  return ['active', '进行中']
}

function renderGoals() {
  const list = $('#goal-list')
  // Don't wipe an answer the user is typing.
  if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return
  list.innerHTML = ''
  const goals = snap.goals || []
  if (!goals.length) list.append(el('li', { class: 'empty' }, '还没有目标～交给她一件需要长期跟进的事吧'))
  for (const g of [...goals].reverse()) {
    const [cls, label] = goalStatus(g)
    const sched = g.every === 'daily' ? `每天 ${g.at || '09:00'}` : EVERY_LABEL[g.every] || ''
    const busy = g.running || snap.goalBusy
    list.append(
      el(
        'li',
        {},
        el('div', { class: 'head' }, el('span', { class: 'badge ' + cls }, label), el('b', { class: 'grow' }, g.title), el('span', { class: 'muted' }, sched)),
        g.detail ? el('div', { class: 'muted' }, g.detail) : null,
        g.running && g.activity ? el('div', { class: 'muted' }, g.activity) : null,
        g.question
          ? el(
              'div',
              { class: 'question' },
              el('div', {}, '❓ ' + g.question.text),
              el(
                'div',
                { class: 'row' },
                ...(g.question.options || []).map((o) => el('button', { class: 'primary', onclick: () => pet.invoke('goal:answer', { id: g.id, answer: o }) }, o)),
                el('button', { onclick: () => pet.invoke('goal:answer', { id: g.id, answer: '__auto' }) }, '你决定吧'),
              ),
              el(
                'form',
                {
                  class: 'row',
                  onsubmit: (e) => {
                    e.preventDefault()
                    const v = e.target.querySelector('input').value.trim()
                    if (v) pet.invoke('goal:answer', { id: g.id, answer: v })
                  },
                },
                el('input', { placeholder: '或者直接写下你的想法…', maxlength: '300' }),
                el('button', { class: 'primary' }, '回答'),
              ),
            )
          : null,
        g.log && g.log.length
          ? el('div', { class: 'result' }, ...g.log.slice(-4).reverse().map((l) => el('div', { class: 'log' }, el('time', {}, fmt(l.ts)), ' ', l.text)))
          : null,
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'muted grow' }, g.status === 'active' && g.nextAt && !g.running ? `下次跟进：${fmt(g.nextAt)}` : ''),
          el('button', { onclick: () => pet.invoke('goal:run', g.id), ...(busy ? { disabled: '' } : {}) }, '立即跟进'),
          g.status === 'active'
            ? el('button', { onclick: () => pet.invoke('goal:update', { id: g.id, patch: { status: 'paused' } }) }, '暂停')
            : el('button', { onclick: () => pet.invoke('goal:update', { id: g.id, patch: { status: 'active' } }) }, g.status === 'done' ? '重新开始' : '继续'),
          g.status !== 'done' ? el('button', { onclick: () => pet.invoke('goal:update', { id: g.id, patch: { status: 'done' } }) }, '完成') : null,
          el('button', { onclick: () => pet.invoke('goal:remove', g.id) }, '删除'),
        ),
      ),
    )
  }
}

function renderActivity() {
  const list = $('#act-list')
  list.innerHTML = ''
  const acts = snap.activity || []
  if (!acts.length) list.append(el('li', { class: 'empty' }, '她还没有自己做过什么～'))
  for (const a of acts.slice(0, 80)) list.append(el('li', {}, el('span', { class: 'icon' }, a.icon || '•'), el('span', { class: 'txt' }, a.text), el('span', { class: 'due' }, fmt(a.ts))))
  const ml = $('#mem-list')
  ml.innerHTML = ''
  const mems = snap.memories || []
  if (!mems.length) ml.append(el('li', { class: 'empty' }, '还没有记住什么'))
  for (const m of [...mems].reverse()) {
    ml.append(el('li', {}, el('span', { class: 'txt' }, '🧠 ' + m.text), el('span', { class: 'due' }, fmt(m.ts)), el('button', { title: '让她忘掉', onclick: () => pet.invoke('memory:remove', m.id) }, '✕')))
  }
}

function renderSettings() {
  const s = snap.settings
  for (const input of $$('[data-key]')) {
    if (document.activeElement === input) continue
    const v = s[input.dataset.key]
    if (input.type === 'checkbox') input.checked = !!v
    else input.value = v == null ? '' : String(v)
  }
  for (const sel of $$('[data-rule]')) {
    if (document.activeElement !== sel) sel.value = (s.rules || {})[sel.dataset.rule] || sel.options[0].value
  }
  for (const ta of $$('[data-list]')) {
    if (document.activeElement !== ta) ta.value = (s[ta.dataset.list] || []).join('\n')
  }
  const gsel = $('#glance-model')
  if (document.activeElement !== gsel) {
    gsel.innerHTML = ''
    gsel.append(el('option', { value: '' }, '跟随聊天用的模型'))
    for (const [prov, models] of Object.entries(snap.models || {})) {
      const g = el('optgroup', { label: prov })
      for (const m of models) g.append(el('option', { value: `${prov}::${m}` }, m))
      gsel.append(g)
    }
    gsel.value = s.glanceModel || ''
  }
  const paused = snap.screenPausedUntil > Date.now()
  $('#screen-pause').textContent = paused ? '恢复看屏幕' : '1 小时内别看'
  $('#screen-state').textContent = paused ? `暂停到 ${fmt(snap.screenPausedUntil, false)}` : ''
  $('#scale-val').textContent = `×${s.scale}`
  const sel = $('#model-select')
  sel.innerHTML = ''
  const dm = snap.defaultModel || {}
  sel.append(el('option', { value: '' }, `跟随 DSH 默认（${dm.provider || '?'} / ${dm.model || '?'}）`))
  for (const [prov, models] of Object.entries(snap.models || {})) {
    const g = el('optgroup', { label: prov })
    for (const m of models) g.append(el('option', { value: `${prov}::${m}` }, m))
    sel.append(g)
  }
  sel.value = s.provider && s.model ? `${s.provider}::${s.model}` : ''
  $('#dsh-status').textContent = snap.dshFound ? `✅ 已找到：${snap.dshPath}` : '❌ 没找到 DeepSeek Harness，请填写路径'
}

function render() {
  if (!snap) return
  $('#status').textContent = snap.busy ? '正在思考…' : '在线'
  $('#status').classList.toggle('busy', snap.busy)
  const MOOD = ['😢', '😟', '😐', '🙂', '😊', '😄', '🥰']
  $('#mood').textContent = `${MOOD[Math.max(0, Math.min(6, (snap.mood || 0) + 3))]} ❤ ${snap.affection || 0}`
  renderChat()
  renderTodos()
  renderGoals()
  renderTasks()
  renderActivity()
  renderSettings()
  $('#note-post').textContent = snap.noteOpen ? '📌 便签已贴出' : '📌 贴到桌面'
}

pet.on('state', (s) => {
  snap = s
  render()
})

// ------------------------------------------------------------ actions

function sendChat() {
  const t = $('#chat-input').value.trim()
  if (!t) return
  $('#chat-input').value = ''
  pet.invoke('chat:send', t)
}
$('#chat-send').addEventListener('click', sendChat)
$('#chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    sendChat()
  }
})
$('#chat-cancel').addEventListener('click', () => pet.invoke('chat:cancel'))
$('#chat-new').addEventListener('click', () => {
  renderedChatCount = -1
  pet.invoke('chat:new')
})
$('#open-web').addEventListener('click', () => pet.invoke('open:web'))

$('#todo-form').addEventListener('submit', (e) => {
  e.preventDefault()
  pet.invoke('todo:add', { text: $('#todo-text').value.trim(), due: fromLocalInput($('#todo-due').value) })
  $('#todo-text').value = ''
  $('#todo-due').value = ''
})
$('#todo-clear').addEventListener('click', () => pet.invoke('todo:clear-done'))
$('#plan-today').addEventListener('click', () => {
  pet.invoke('plan:today')
  showTab('chat')
})
$('#rem-form').addEventListener('submit', (e) => {
  e.preventDefault()
  pet.invoke('reminder:add', { text: $('#rem-text').value.trim(), at: fromLocalInput($('#rem-at').value), repeat: $('#rem-daily').checked ? 'daily' : null })
  $('#rem-text').value = ''
})
$('#rem-at').value = toLocalInput(Date.now() + 30 * 60000)
$('#pomo-25').addEventListener('click', () => pet.invoke('pomodoro:start', 25))
$('#pomo-50').addEventListener('click', () => pet.invoke('pomodoro:start', 50))
$('#pomo-stop').addEventListener('click', () => pet.invoke('pomodoro:stop'))

$('#task-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const prompt = $('#task-text').value.trim()
  if (!prompt) return
  pet.invoke('task:start', { prompt })
  $('#task-text').value = ''
})

for (const input of $$('[data-key]')) {
  const ev = input.type === 'range' || input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'change'
  input.addEventListener(ev, () => {
    const key = input.dataset.key
    let v = input.type === 'checkbox' ? input.checked : input.value
    if (['scale'].includes(key)) v = Number(v)
    if (['mischief', 'waterMinutes', 'llmRemarkMinutes', 'nagMinutes'].includes(key)) v = Math.max(0, Number(v) || 0)
    pet.invoke('settings:set', { [key]: v })
  })
}
for (const sel of $$('[data-rule]')) {
  sel.addEventListener('change', () => pet.invoke('settings:set', { rules: { [sel.dataset.rule]: sel.value } }))
}
for (const ta of $$('[data-list]')) {
  ta.addEventListener('change', () => pet.invoke('settings:set', { [ta.dataset.list]: ta.value }))
}
$('#tidy-now').addEventListener('click', () => pet.invoke('tidy:now'))
$('#note-post').addEventListener('click', () => pet.invoke('note:post'))
$('#act-clear').addEventListener('click', () => pet.invoke('activity:clear'))
$('#mem-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const t = $('#mem-text').value.trim()
  if (t) pet.invoke('memory:add', t)
  $('#mem-text').value = ''
})
$('#goal-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const title = $('#goal-title').value.trim()
  if (!title) return
  pet.invoke('goal:add', { title, detail: $('#goal-detail').value.trim(), every: $('#goal-every').value, at: $('#goal-at').value })
  $('#goal-title').value = ''
  $('#goal-detail').value = ''
})
$('#goal-every').addEventListener('change', () => {
  $('#goal-at').style.display = $('#goal-every').value === 'daily' ? '' : 'none'
})
$('#model-select').addEventListener('change', (e) => {
  const [provider, model] = e.target.value ? e.target.value.split('::') : ['', '']
  pet.invoke('settings:set', { provider, model })
})
$('#pick-cwd').addEventListener('click', async () => {
  const d = await pet.invoke('pick:dir')
  if (d) pet.invoke('settings:set', { cwd: d })
})
$('#pick-exe').addEventListener('click', async () => {
  const f = await pet.invoke('pick:exe')
  if (f) pet.invoke('settings:set', { dshExe: f })
})
$('#prank-run').addEventListener('click', () => {
  const v = $('#prank-select').value
  if (v === 'climb') pet.invoke('climb:now')
  else pet.invoke('prank', v || undefined)
})
$('#look-now').addEventListener('click', () => pet.invoke('look:now'))
$('#screen-pause').addEventListener('click', () => pet.invoke('screen:pause', snap && snap.screenPausedUntil > Date.now() ? 0 : 60))
$('#glance-model').addEventListener('change', (e) => pet.invoke('settings:set', { glanceModel: e.target.value }))

;(async () => {
  snap = await pet.invoke('panel:state')
  render()
  const tab = new URLSearchParams(location.search).get('tab')
  showTab(tab || 'chat')
})()
