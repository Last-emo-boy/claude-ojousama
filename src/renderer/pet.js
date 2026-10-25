'use strict'
/* global pet */
// Sprite stage, speech bubble, input box, hit-test rects, drag/click/drop handling.

const $ = (id) => document.getElementById(id)
const canvas = $('stage')
const ctx = canvas.getContext('2d')
const root = $('root')
const topEl = $('top')
const bubble = $('bubble')
const bubbleText = $('bubble-text')
const bubbleButtons = $('bubble-buttons')
const inputBox = $('input')
const inputText = $('input-text')
const chipEl = $('chip')
const timerEl = $('timer')

let cfg = null // { manifest, scale, size, maxW, maxH, bubbleH }
const sheets = {} // name -> { img, alpha: Uint8ClampedArray, w, h, frames, bands: [[{y0,y1,x0,x1}]] }
let base = { name: 'idle', start: performance.now() }
let override = null // { name, mode: 'once' | 'hold', loops, start }
let face = 1
let carryItem = null
let carryIcon = null
let lastKey = ''
let lastRects = ''
let bubbleTimer = null
let typeTimer = null
let currentBubbleId = null

// ------------------------------------------------------------ loading

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

async function loadSheets() {
  const entries = Object.entries(cfg.manifest)
  await Promise.all(
    entries.map(async ([name, a]) => {
      if (sheets[name]) return
      const img = await loadImage(cfg.images[name])
      const off = document.createElement('canvas')
      off.width = img.width
      off.height = img.height
      const octx = off.getContext('2d', { willReadFrequently: true })
      octx.drawImage(img, 0, 0)
      const data = octx.getImageData(0, 0, img.width, img.height).data
      const alpha = new Uint8ClampedArray(img.width * img.height)
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
      const bands = []
      const BAND = 6
      for (let f = 0; f < a.frames; f++) {
        const list = []
        for (let y0 = 0; y0 < a.h; y0 += BAND) {
          let x0 = Infinity
          let x1 = -1
          for (let y = y0; y < Math.min(a.h, y0 + BAND); y++) {
            for (let x = 0; x < a.w; x++) {
              if (alpha[y * img.width + f * a.w + x] > 0) {
                if (x < x0) x0 = x
                if (x > x1) x1 = x
              }
            }
          }
          if (x1 >= 0) list.push({ y0, y1: Math.min(a.h, y0 + BAND), x0, x1: x1 + 1 })
        }
        bands.push(list)
      }
      sheets[name] = { img, alpha, stride: img.width, ...a, bands }
    }),
  )
}

// ------------------------------------------------------------ layout

function layout() {
  const [W, H] = cfg.size
  const s = cfg.scale
  const dpr = window.devicePixelRatio || 1
  const ch = Math.round(cfg.maxH * s)
  canvas.style.width = W + 'px'
  canvas.style.height = ch + 'px'
  canvas.width = Math.round(W * dpr)
  canvas.height = Math.round(ch * dpr)
  topEl.dataset.bottom = ''
  lastKey = ''
}

// ------------------------------------------------------------ animation state

function activeAnim(now) {
  if (override) {
    const a = sheets[override.name]
    if (!a) return { name: base.name, start: base.start, mode: 'base' }
    if (override.mode === 'once') {
      const idx = Math.floor(((now - override.start) / 1000) * a.fps)
      if (idx >= a.frames * (override.loops || 1)) {
        override = null
        return { name: base.name, start: base.start, mode: 'base' }
      }
    }
    return override
  }
  return { name: base.name, start: base.start, mode: 'base' }
}

function frameIndex(anim, now) {
  const a = sheets[anim.name]
  const i = Math.floor(((now - anim.start) / 1000) * a.fps)
  if (!a.loop && anim.mode !== 'once') return Math.min(i, a.frames - 1)
  return i % a.frames
}

/** Sprite placement in CSS pixels relative to the window. */
function placement(a) {
  const [W, H] = cfg.size
  const s = cfg.scale
  const w = a.w * s
  const h = a.h * s
  const x = a.anchor === 'right' ? W - w : Math.round(W / 2 - w / 2)
  return { x, y: H - h, w, h, s }
}

function drawFileIcon(c, x, y, size) {
  // Procedural pixel "document" icon for fake files.
  const p = size / 16
  c.fillStyle = '#3b2a20'
  c.fillRect(x + 2 * p, y, 9 * p, 16 * p)
  c.fillRect(x + 2 * p, y, 12 * p, 16 * p)
  c.fillStyle = '#fffaf2'
  c.fillRect(x + 3 * p, y + p, 7 * p, 14 * p)
  c.fillRect(x + 3 * p, y + 4 * p, 10 * p, 11 * p)
  c.fillStyle = '#d9c7ad'
  c.fillRect(x + 10 * p, y + p, p, 3 * p)
  c.fillRect(x + 10 * p, y + 3 * p, 3 * p, p)
  c.fillStyle = '#ff9a3c'
  for (let i = 0; i < 4; i++) c.fillRect(x + 4 * p, y + (6 + i * 2) * p, (i % 2 ? 5 : 7) * p, p)
}

function drawNoteIcon(c, x, y, size, paper) {
  // Pixel sticky note with a strip of tape and scribbled lines.
  const p = size / 16
  c.fillStyle = '#3b2a20'
  c.fillRect(x + p, y + 2 * p, 14 * p, 14 * p)
  c.fillStyle = paper || '#ffe873'
  c.fillRect(x + 2 * p, y + 3 * p, 12 * p, 12 * p)
  c.fillStyle = 'rgba(255,154,60,0.9)'
  c.fillRect(x + 5 * p, y + p, 6 * p, 3 * p)
  c.fillStyle = '#3b2a20'
  for (let i = 0; i < 4; i++) c.fillRect(x + 4 * p, y + (6 + i * 2) * p, (i % 2 ? 5 : 8) * p, p)
  c.fillStyle = '#d64828'
  c.fillRect(x + 3 * p, y + 6 * p, p, p)
}

function drawBoxIcon(c, x, y, size) {
  // Cardboard box for "many files at once".
  const p = size / 16
  c.fillStyle = '#3b2a20'
  c.fillRect(x + p, y + 4 * p, 14 * p, 12 * p)
  c.fillStyle = '#c98a4b'
  c.fillRect(x + 2 * p, y + 5 * p, 12 * p, 10 * p)
  c.fillStyle = '#e0a868'
  c.fillRect(x + 2 * p, y + 5 * p, 12 * p, 3 * p)
  c.fillStyle = '#3b2a20'
  c.fillRect(x + 7 * p, y + 5 * p, 2 * p, 3 * p)
  c.fillStyle = '#fffaf2'
  c.fillRect(x + 4 * p, y + 10 * p, 8 * p, 3 * p)
}

function draw(now) {
  if (!cfg) return
  const anim = activeAnim(now)
  const a = sheets[anim.name]
  if (!a) return
  const idx = frameIndex(anim, now)
  const showCarry = carryItem && anim.name === 'drag'
  const key = `${anim.name}|${idx}|${face}|${showCarry ? carryItem.label : ''}|${cfg.scale}`
  if (key === lastKey) return
  lastKey = key
  const dpr = window.devicePixelRatio || 1
  const [W] = cfg.size
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.imageSmoothingEnabled = false
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const pl = placement(a)
  // Keep the bubble just above the current head (desk scenes are shorter than standing ones).
  const bottom = Math.round(a.h * pl.s - 6 * pl.s)
  if (topEl.dataset.bottom !== String(bottom)) {
    topEl.dataset.bottom = String(bottom)
    topEl.style.bottom = bottom + 'px'
    topEl.style.maxHeight = cfg.size[1] - bottom - 4 + 'px'
    bubble.style.maxHeight = cfg.size[1] - bottom - 40 + 'px'
  }
  const canvasTop = cfg.size[1] - canvas.height / dpr
  const y = pl.y - canvasTop
  ctx.save()
  if (face < 0) {
    ctx.translate(pl.x + pl.w / 2, 0)
    ctx.scale(-1, 1)
    ctx.translate(-(pl.x + pl.w / 2), 0)
  }
  ctx.drawImage(a.img, idx * a.w, 0, a.w, a.h, pl.x, y, pl.w, pl.h)
  ctx.restore()

  if (showCarry) {
    const rope = (a.rope && a.rope[idx]) || a.h * 0.68
    const size = Math.round(20 * pl.s)
    const cy = y + rope * pl.s
    const ix = face > 0 ? pl.x - size + pl.s : pl.x + pl.w - pl.s
    const iy = Math.round(cy - size / 2)
    // rope knot
    ctx.fillStyle = '#7a4a26'
    ctx.fillRect(face > 0 ? ix + size - 2 * pl.s : ix, Math.round(cy - pl.s), 3 * pl.s, 2 * pl.s)
    if (carryIcon) ctx.drawImage(carryIcon, ix, iy, size, size)
    else if (carryItem.kind === 'note') drawNoteIcon(ctx, ix, iy, size)
    else if (carryItem.kind === 'memo') drawNoteIcon(ctx, ix, iy, size, '#ffd6e7')
    else if (carryItem.kind === 'box') drawBoxIcon(ctx, ix, iy, size)
    else drawFileIcon(ctx, ix, iy, size)
    const label = carryItem.label.length > 10 ? carryItem.label.slice(0, 9) + '…' : carryItem.label
    ctx.font = '11px "Microsoft YaHei UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.lineWidth = 3
    ctx.strokeStyle = 'rgba(255,250,242,0.95)'
    const lx = Math.max(30, Math.min(W - 30, ix + size / 2))
    ctx.strokeText(label, lx, iy + size + 1)
    ctx.fillStyle = '#3b2a20'
    ctx.fillText(label, lx, iy + size + 1)
  }
  sendRects(a, idx, pl)
}

function sendRects(a, idx, pl) {
  const rects = []
  for (const b of a.bands[idx] || []) {
    const x0 = face > 0 ? b.x0 : a.w - b.x1
    rects.push({ k: 's', x: Math.floor(pl.x + x0 * pl.s), y: Math.floor(pl.y + b.y0 * pl.s), w: Math.ceil((b.x1 - b.x0) * pl.s), h: Math.ceil((b.y1 - b.y0) * pl.s) })
  }
  for (const [el, k] of [
    [bubble, 'b'],
    [inputBox, 'i'],
  ]) {
    if (el.classList.contains('hidden')) continue
    const r = el.getBoundingClientRect()
    rects.push({ k, x: Math.floor(r.left) - 4, y: Math.floor(r.top) - 4, w: Math.ceil(r.width) + 8, h: Math.ceil(r.height) + 12 })
  }
  const json = JSON.stringify(rects)
  if (json !== lastRects) {
    lastRects = json
    pet.send('pet:rects', rects)
  }
}

function loop(now) {
  draw(now)
  requestAnimationFrame(loop)
}

function isOpaqueAt(clientX, clientY) {
  const now = performance.now()
  const anim = activeAnim(now)
  const a = sheets[anim.name]
  if (!a) return false
  const idx = frameIndex(anim, now)
  const pl = placement(a)
  let fx = Math.floor((clientX - pl.x) / pl.s)
  const fy = Math.floor((clientY - pl.y) / pl.s)
  if (face < 0) fx = a.w - 1 - fx
  if (fx < 0 || fy < 0 || fx >= a.w || fy >= a.h) return false
  // Accept a small neighbourhood so thin hair strands are still grabbable.
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = fx + dx
      const y = fy + dy
      if (x >= 0 && y >= 0 && x < a.w && y < a.h && a.alpha[y * a.stride + idx * a.w + x] > 0) return true
    }
  return false
}

// ------------------------------------------------------------ bubble

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

function formatText(raw) {
  const parts = String(raw).split(/```[\w-]*\n?([\s\S]*?)(?:```|$)/g)
  let html = ''
  parts.forEach((p, i) => {
    if (i % 2 === 1) html += `<pre>${escapeHtml(p.replace(/\n$/, ''))}</pre>`
    else
      html += escapeHtml(p)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,4}\s*(.+)$/gm, '<b>$1</b>')
        .replace(/^\s*[-*]\s+/gm, '• ')
        .replace(/\n/g, '<br>')
  })
  return html.replace(/^(<br>)+|(<br>)+$/g, '')
}

function showBubble({ id, text, buttons, ttl }) {
  clearTimeout(bubbleTimer)
  clearInterval(typeTimer)
  currentBubbleId = id
  bubble.classList.remove('hidden')
  bubble.style.animation = 'none'
  void bubble.offsetWidth
  bubble.style.animation = ''
  bubble.dataset.long = text.length > 140 ? '1' : ''
  bubbleButtons.innerHTML = ''
  for (const b of buttons || []) {
    const el = document.createElement('button')
    el.textContent = b.label
    if (b.title && b.title !== b.label) el.title = b.title
    el.addEventListener('click', (e) => {
      e.stopPropagation()
      pet.send('pet:button', { id, value: b.id })
    })
    bubbleButtons.appendChild(el)
  }
  const plain = text.length <= 120 && !text.includes('```')
  if (plain) {
    let n = 0
    const step = Math.max(1, Math.ceil(text.length / 40))
    bubbleText.innerHTML = ''
    typeTimer = setInterval(() => {
      n = Math.min(text.length, n + step)
      bubbleText.innerHTML = formatText(text.slice(0, n))
      lastKey = ''
      if (n >= text.length) clearInterval(typeTimer)
    }, 30)
  } else {
    bubbleText.innerHTML = formatText(text)
    bubbleText.scrollTop = 0
  }
  if (ttl > 0) bubbleTimer = setTimeout(hideBubble, ttl)
  lastKey = ''
}

function hideBubble() {
  clearTimeout(bubbleTimer)
  clearInterval(typeTimer)
  bubble.classList.add('hidden')
  currentBubbleId = null
  lastKey = ''
}

bubble.addEventListener('click', () => {
  if (window.getSelection().toString()) return
  if (bubble.dataset.long) pet.send('pet:bubble-click')
  else if (!bubbleButtons.children.length) {
    hideBubble()
    pet.send('pet:bubble-closed')
  }
})

// ------------------------------------------------------------ input

function openInput(prefill) {
  inputBox.classList.remove('hidden')
  inputText.value = prefill || ''
  autoGrow()
  setTimeout(() => {
    inputText.focus()
    inputText.setSelectionRange(inputText.value.length, inputText.value.length)
  }, 30)
  pet.send('pet:input-state', true)
  lastKey = ''
}
function closeInput() {
  if (inputBox.classList.contains('hidden')) return
  inputBox.classList.add('hidden')
  inputText.blur()
  pet.send('pet:input-state', false)
  lastKey = ''
}
function autoGrow() {
  inputText.style.height = 'auto'
  inputText.style.height = Math.min(64, inputText.scrollHeight) + 'px'
  lastKey = ''
}
function submitInput() {
  const text = inputText.value.trim()
  if (!text) return closeInput()
  pet.send('pet:send', text)
  inputText.value = ''
  closeInput()
}
inputText.addEventListener('input', autoGrow)
inputText.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    submitInput()
  } else if (e.key === 'Escape') closeInput()
})
$('input-send').addEventListener('click', submitInput)
window.addEventListener('blur', () => {
  if (!inputText.value.trim()) closeInput()
})

// ------------------------------------------------------------ pointer: drag / click / menu

let press = null
let clicks = 0
let clickTimer = null

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !isOpaqueAt(e.clientX, e.clientY)) return
  press = { x: e.screenX, y: e.screenY, dragging: false }
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (!press) {
    canvas.style.cursor = isOpaqueAt(e.clientX, e.clientY) ? 'grab' : 'default'
    return
  }
  if (!press.dragging && Math.hypot(e.screenX - press.x, e.screenY - press.y) > 4) {
    press.dragging = true
    canvas.style.cursor = 'grabbing'
    pet.send('pet:drag-start')
  }
})
canvas.addEventListener('pointerup', (e) => {
  if (!press) return
  const wasDragging = press.dragging
  press = null
  try {
    canvas.releasePointerCapture(e.pointerId)
  } catch {}
  canvas.style.cursor = 'grab'
  if (wasDragging) return pet.send('pet:drag-end')
  clicks++
  clearTimeout(clickTimer)
  clickTimer = setTimeout(() => {
    pet.send('pet:click', clicks)
    clicks = 0
  }, 260)
})
canvas.addEventListener('pointercancel', () => {
  if (press && press.dragging) pet.send('pet:drag-end')
  press = null
})
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (isOpaqueAt(e.clientX, e.clientY)) pet.send('pet:context-menu')
})

// ------------------------------------------------------------ drop files / text

document.addEventListener('dragover', (e) => {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
  document.body.classList.add('dropping')
})
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dropping')
})
document.addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dropping')
  const files = [...(e.dataTransfer.files || [])].map((f) => pet.pathForFile(f)).filter(Boolean)
  const text = files.length ? '' : e.dataTransfer.getData('text/plain') || ''
  if (files.length || text) pet.send('pet:drop', { files, text })
})

// ------------------------------------------------------------ commands from main

async function applyInit(data) {
  cfg = data
  await loadSheets()
  layout()
}

pet.on('pet:cmd', async (cmd) => {
  switch (cmd.type) {
    case 'init':
      await applyInit(cmd)
      break
    case 'anim': {
      const now = performance.now()
      if (cmd.mode === 'base') {
        if (base.name !== cmd.name) base = { name: cmd.name, start: now }
      } else if (cmd.mode === 'release') override = null
      else if (sheets[cmd.name]) override = { name: cmd.name, mode: cmd.mode, loops: cmd.loops || 1, start: now }
      lastKey = ''
      break
    }
    case 'face':
      face = cmd.dir < 0 ? -1 : 1
      lastKey = ''
      break
    case 'say':
      showBubble(cmd)
      break
    case 'hush':
      hideBubble()
      break
    case 'chip':
      chipEl.textContent = cmd.text || ''
      chipEl.classList.toggle('hidden', !cmd.text)
      break
    case 'timer':
      timerEl.textContent = cmd.text || ''
      timerEl.classList.toggle('hidden', !cmd.text)
      break
    case 'fade':
      root.style.opacity = String(cmd.to)
      break
    case 'carry':
      carryItem = cmd.item || null
      carryIcon = null
      if (carryItem && carryItem.icon) carryIcon = await loadImage(carryItem.icon).catch(() => null)
      lastKey = ''
      break
    case 'input':
      if (cmd.open) openInput(cmd.prefill)
      else closeInput()
      break
  }
})

;(async () => {
  await applyInit(await pet.invoke('pet:init'))
  requestAnimationFrame(loop)
  pet.send('pet:ready')
})()
