'use strict'
/* global pet */
// Sticky note window: the live todo list ("kind=todo") or a short prank memo ("kind=memo").
const $ = (id) => document.getElementById(id)
const pad = (n) => String(n).padStart(2, '0')
let known = null // todo ids already shown, to animate only new lines
let todos = []

function fmtDue(ts) {
  const d = new Date(ts)
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}-${pad(d.getDate())} ${t}`
}

function reportSize() {
  requestAnimationFrame(() => {
    const r = $('paper').getBoundingClientRect()
    pet.send('note:resize', Math.ceil(r.height + 24))
  })
}

function renderTodos(data, writing) {
  todos = data.todos || []
  $('pin').classList.toggle('off', !data.pinned)
  const d = new Date()
  $('date').textContent = `${d.getMonth() + 1}月${d.getDate()}日`
  const now = Date.now()
  const today = d.toDateString()
  const open = todos.filter((t) => !t.done).sort((a, b) => (a.due || 9e15) - (b.due || 9e15))
  const doneToday = todos.filter((t) => t.done && t.doneAt && new Date(t.doneAt).toDateString() === today).slice(-3)
  const list = $('items')
  list.innerHTML = ''
  const items = [...open, ...doneToday]
  if (!items.length) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = '今天没有待办，轻松一下～'
    list.append(li)
  }
  items.forEach((t, i) => {
    const li = document.createElement('li')
    if (t.done) li.classList.add('done')
    const box = document.createElement('span')
    box.className = 'box'
    box.title = t.done ? '标记为未完成' : '完成！'
    box.addEventListener('click', () => pet.invoke('note:toggle', { id: t.id, done: !t.done }))
    const txt = document.createElement('span')
    txt.className = 'txt'
    txt.textContent = t.text
    li.append(box, txt)
    if (t.due && !t.done) {
      const due = document.createElement('span')
      due.className = 'due' + (t.due < now ? ' late' : t.due - now < 3600e3 ? ' soon' : '')
      due.textContent = fmtDue(t.due)
      li.append(due)
    }
    list.append(li)
    if (writing) {
      // "Handwrite" the lines one by one right after the pet pins the note.
      li.classList.add('writing')
      setTimeout(() => {
        li.classList.remove('writing')
        li.classList.add('new')
      }, 300 + i * 420)
    } else if (known && !known.has(t.id)) li.classList.add('new')
  })
  known = new Set(todos.map((t) => t.id))
  reportSize()
}

function flash() {
  document.body.classList.remove('flash')
  void document.body.offsetWidth
  document.body.classList.add('flash')
  setTimeout(() => document.body.classList.remove('flash'), 1100)
}

async function init() {
  const data = await pet.invoke('note:init')
  $('paper').classList.remove('hidden')
  if (data.kind === 'memo') {
    document.body.classList.add('memo')
    $('memo-view').classList.remove('hidden')
    $('memo-text').textContent = data.text || ''
    $('paper').addEventListener('click', () => pet.send('note:close'))
    $('paper').title = '点一下撕掉'
    return
  }
  $('todo-view').classList.remove('hidden')
  renderTodos(data, data.writing)
  pet.on('note:state', (s) => {
    renderTodos(s, false)
    if (s.flash) flash()
  })
  $('close').addEventListener('click', () => pet.send('note:close'))
  $('pin').addEventListener('click', () => pet.send('note:pin'))
  $('add').addEventListener('submit', (e) => {
    e.preventDefault()
    const text = $('add-text').value.trim()
    if (!text) return
    $('add-text').value = ''
    pet.invoke('note:add', text)
  })
}

init()
