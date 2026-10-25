'use strict'
// Sticky notes the pet drags onto the desktop: one live todo list and short-lived prank memos.
const { BrowserWindow, screen } = require('electron')
const path = require('path')

const NOTE_W = 236
const MEMO_W = 170
const MAX_MEMOS = 3

class Notes {
  /**
   * @param {object} o
   * @param {string} o.preload
   * @param {string} o.html
   * @param {() => object} o.todoState  data sent to the todo note ({ todos })
   * @param {object} o.store
   */
  constructor(o) {
    this.o = o
    this.todo = null // BrowserWindow
    this.memos = new Set()
    this.meta = new WeakMap() // win -> { kind, text, writing }
  }

  get pinned() {
    return this.o.store.get('note').pinned !== false
  }

  _create(kind, { x, y, w, h, pinned }) {
    const win = new BrowserWindow({
      width: w,
      height: h,
      x: Math.round(x),
      y: Math.round(y),
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !!pinned,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: { preload: this.o.preload, contextIsolation: true, nodeIntegration: false },
    })
    if (pinned) win.setAlwaysOnTop(true, 'floating')
    win.loadFile(this.o.html, { query: { kind } })
    win.once('ready-to-show', () => win.showInactive())
    return win
  }

  /** Clamp a window rect into the work area of the display that contains its centre. */
  _fit(x, y, w, h) {
    const wa = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + h / 2) }).workArea
    return {
      x: Math.max(wa.x + 4, Math.min(wa.x + wa.width - w - 4, x)),
      y: Math.max(wa.y + 4, Math.min(wa.y + wa.height - h - 4, y)),
    }
  }

  /** Fit a new note on screen without covering the ones already pinned: stack it above them. */
  _place(x, y, w, h) {
    const others = this.windows().map((win) => win.getBounds())
    let pos = this._fit(x, y, w, h)
    for (let i = 0; i < others.length + 1; i++) {
      const hit = others.find((b) => pos.x < b.x + b.width && pos.x + w > b.x && pos.y < b.y + b.height && pos.y + h > b.y)
      if (!hit) break
      pos = this._fit(pos.x, hit.y - h - 6, w, h)
    }
    return pos
  }

  isTodoOpen() {
    return !!(this.todo && !this.todo.isDestroyed())
  }

  /** Open the todo note with its bottom-centre at (cx, bottom). */
  openTodo(cx, bottom, { writing = true, exact = false } = {}) {
    if (this.isTodoOpen()) {
      this.flash()
      return this.todo
    }
    const open = (this.o.todoState().todos || []).filter((t) => !t.done).length
    const h = Math.min(420, 118 + Math.max(1, open) * 24)
    const pos = exact ? this._fit(cx - NOTE_W / 2, bottom - h, NOTE_W, h) : this._place(cx - NOTE_W / 2, bottom - h, NOTE_W, h)
    const win = this._create('todo', { ...pos, w: NOTE_W, h, pinned: this.pinned })
    this.meta.set(win, { kind: 'todo', writing })
    const remember = () => {
      if (win.isDestroyed()) return
      const b = win.getBounds()
      this.o.store.patch('note', { open: true, cx: b.x + b.width / 2, bottom: b.y + b.height })
    }
    win.on('moved', remember)
    win.once('ready-to-show', remember)
    win.on('closed', () => {
      if (this.todo === win) this.todo = null
      // Closing because the app quits keeps the note for next time.
      if (!this.quitting) this.o.store.patch('note', { open: false })
      if (this.o.onChange) this.o.onChange()
    })
    this.todo = win
    if (this.o.onChange) this.o.onChange()
    return win
  }

  /** Put the todo note back where it was when the app last quit. */
  restore() {
    const n = this.o.store.get('note')
    if (!n.open || n.cx == null || n.bottom == null) return null
    return this.openTodo(n.cx, n.bottom, { writing: false, exact: true })
  }

  closeTodo() {
    if (this.isTodoOpen()) this.todo.close()
  }

  flash() {
    if (this.isTodoOpen()) this.todo.webContents.send('note:state', { ...this.o.todoState(), flash: true })
  }

  /** Send the list only when it changed: rebuilding it under the cursor can swallow a click. */
  pushTodos() {
    if (!this.isTodoOpen()) return
    const data = this.o.todoState()
    const sig = JSON.stringify(data)
    if (sig === this.lastSig) return
    this.lastSig = sig
    this.todo.webContents.send('note:state', data)
  }

  setPinned(pinned) {
    this.o.store.patch('note', { pinned })
    for (const win of [this.todo, ...this.memos]) {
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned, 'floating')
    }
    this.pushTodos()
  }

  /** A prank memo: bottom-centre at (cx, bottom); closes by itself after ttl ms. */
  openMemo(cx, bottom, text, ttl = 120000) {
    if (this.memos.size >= MAX_MEMOS) {
      const oldest = this.memos.values().next().value
      if (oldest && !oldest.isDestroyed()) oldest.close()
    }
    const h = 128
    const pos = this._place(cx - MEMO_W / 2, bottom - h, MEMO_W, h)
    const win = this._create('memo', { ...pos, w: MEMO_W, h, pinned: true })
    this.meta.set(win, { kind: 'memo', text })
    this.memos.add(win)
    const timer = setTimeout(() => !win.isDestroyed() && win.close(), ttl)
    win.on('closed', () => {
      clearTimeout(timer)
      this.memos.delete(win)
    })
    return win
  }

  /** Data for a note renderer asking `note:init`. */
  initFor(webContents) {
    const win = BrowserWindow.fromWebContents(webContents)
    const meta = (win && this.meta.get(win)) || { kind: 'todo' }
    const data = { kind: meta.kind, pinned: this.pinned }
    if (meta.kind === 'memo') data.text = meta.text
    else {
      Object.assign(data, this.o.todoState(), { writing: !!meta.writing })
      meta.writing = false
    }
    return data
  }

  /** Grow/shrink a note to its content while keeping its bottom edge in place. */
  resize(webContents, height) {
    const win = BrowserWindow.fromWebContents(webContents)
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    const h = Math.max(90, Math.min(460, Math.round(height)))
    if (Math.abs(h - b.height) < 2) return
    const pos = this._fit(b.x, b.y + b.height - h, b.width, h)
    win.setBounds({ x: b.x, y: Math.round(pos.y), width: b.width, height: h })
  }

  closeFrom(webContents) {
    const win = BrowserWindow.fromWebContents(webContents)
    if (win && !win.isDestroyed()) win.close()
  }

  closeAll() {
    for (const win of [this.todo, ...this.memos]) if (win && !win.isDestroyed()) win.close()
  }

  windows() {
    return [this.todo, ...this.memos].filter((w) => w && !w.isDestroyed())
  }
}

module.exports = { Notes, NOTE_W, MEMO_W, notePath: (dir) => path.join(dir, 'note.html') }
