'use strict'
// Screen sense: what window is in front, a picture of it, and the text on it.
// Native helpers answer window/OCR questions; Electron owns capture and OS screen-sharing consent.
const { spawn } = require('child_process')
const { desktopCapturer, screen, systemPreferences } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TMP_PREFIX = 'claude-ojousama-look-'
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow', 'Windows.UI.Core.CoreWindow'])

const unpacked = (file) => file.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')

function helperCommand(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return { exe: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', unpacked(path.join(__dirname, 'screen-helper.ps1'))] }
  if (platform === 'darwin') {
    const base = path.join(__dirname, 'platform', 'bin')
    const candidates = [path.join(base, `darwin-${arch}`, 'screen-helper'), path.join(base, 'darwin-universal', 'screen-helper')].map(unpacked)
    const exe = candidates.find((file) => fs.existsSync(file))
    return exe ? { exe, args: [] } : null
  }
  if (platform === 'linux') return { exe: 'python3', args: [unpacked(path.join(__dirname, 'platform', 'screen-helper-linux.py'))] }
  return null
}

function initialCapabilities(platform = process.platform, env = process.env) {
  const session = platform === 'linux' ? ((env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || env.WAYLAND_DISPLAY ? 'wayland' : env.DISPLAY ? 'x11' : 'headless') : platform === 'darwin' ? 'aqua' : platform === 'win32' ? 'win32' : 'unsupported'
  return {
    platform, session, foreground: platform === 'win32', windows: platform === 'win32', ocr: false,
    manualCapture: !['headless', 'unsupported'].includes(session), screenCapture: platform === 'win32',
    reason: session === 'wayland' ? 'Wayland 不提供全局窗口信息，请使用手动选屏；桌宠移动需要 XWayland' : session === 'headless' ? '没有图形桌面会话' : '正在检测屏幕能力',
    permissions: {}, dependencies: {},
  }
}

const cjkRatio = (s) => {
  const letters = s.replace(/\s/g, '')
  if (!letters.length) return 0
  return (letters.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length / letters.length
}
/** Windows' Chinese OCR puts spaces between characters; glue them back. */
const tidyOcr = (s) =>
  String(s || '')
    .replace(/([\u3400-\u9fff\uff00-\uffef])[ \t]+(?=[\u3400-\u9fff\uff00-\uffef])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim()

class ScreenSense {
  constructor({ ownPid } = {}) {
    this.ownPid = ownPid || process.pid
    this.proc = null
    this.seq = 0
    this.pending = new Map()
    this._capabilities = initialCapabilities()
    this.cleanupLeftovers()
  }

  capabilities() {
    return { ...this._capabilities, permissions: { ...this._capabilities.permissions }, dependencies: { ...this._capabilities.dependencies } }
  }

  async refreshCapabilities() {
    // soft: a slow answer (cold PowerShell / WinRT) must not restart the helper
    const result = await this.request('capabilities', {}, 10000, { soft: true })
    if (result.ok) {
      const { ok, id, ...value } = result
      this._capabilities = { ...this._capabilities, ...value, helperAvailable: true, reason: value.reason || '' }
      if (this._capabilities.session === 'wayland') this._capabilities.reason = 'Wayland 不提供全局窗口信息，请使用手动选屏；桌宠移动需要 XWayland'
    } else if (process.platform === 'win32') {
      // Windows always has window info; a slow cold start (WinRT OCR loading) must not switch it off.
      this._capabilities = { ...this._capabilities, helperAvailable: false, reason: result.error }
    } else {
      this._capabilities = { ...this._capabilities, foreground: false, windows: false, ocr: false, helperAvailable: false, reason: result.error }
    }
    if (process.platform === 'darwin' && systemPreferences) {
      const status = systemPreferences.getMediaAccessStatus('screen')
      this._capabilities.permissions = { ...this._capabilities.permissions, screenCapture: status }
      this._capabilities.screenCapture = status === 'granted'
      if (status !== 'granted') {
        this._capabilities.foreground = false
        this._capabilities.reason = '请在系统设置 → 隐私与安全性 → 屏幕与系统音频录制中允许桌宠；开发运行时允许启动它的终端或 IDE'
      }
    }
    return this.capabilities()
  }

  // ------------------------------------------------------------ helper process

  _ensure() {
    if (this.proc && this.proc.exitCode == null && !this.proc.killed) return true
    if (Date.now() < (this.retryAt || 0)) return false
    const helper = helperCommand()
    if (!helper) {
      this.helperError = process.platform === 'darwin' ? '缺少 macOS 屏幕助手，请先运行 npm run build:helpers 或重新安装应用' : '当前平台没有屏幕助手'
      return false
    }
    let buf = '' // per process: a killed helper's late output never mixes into the new one's
    let p
    try {
      p = spawn(helper.exe, helper.args, { windowsHide: true })
      this.helperError = null
    } catch (e) {
      this.retryAt = Date.now() + 5 * 60000
      this.helperError = `无法启动屏幕助手：${e.message}`
      console.warn('[screen-helper] cannot start', e.message)
      return false
    }
    p.on('error', (e) => {
      console.warn('[screen-helper]', e.message)
      this.helperError = process.platform === 'linux' && e.code === 'ENOENT' ? '未找到 Python 3；安装后重启应用以启用窗口检测和 OCR' : `无法启动屏幕助手：${e.message}`
      this.retryAt = Date.now() + 5 * 60000
      if (this.proc === p) this.proc = null
      this._failPending(this.helperError)
    })
    p.stdout.setEncoding('utf8')
    p.stdout.on('data', (chunk) => {
      if (this.proc !== p) return // replaced: its requests were settled already
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        let r
        try {
          r = JSON.parse(line)
        } catch {
          continue
        }
        const job = this.pending.get(r.id)
        if (job) {
          this.pending.delete(r.id)
          clearTimeout(job.timer)
          job.resolve(r)
        }
      }
    })
    p.stderr.on('data', (d) => console.warn('[screen-helper]', String(d).trim().slice(0, 300)))
    p.on('exit', () => {
      if (this.proc !== p && this.proc) return // an old, replaced helper: its requests were settled already
      this._failPending(this.helperError || '屏幕助手已退出')
      if (this.proc === p) this.proc = null
    })
    p.stdin.on('error', () => {})
    this.proc = p
    return true
  }

  /** Requests are answered one at a time; true while any is waiting. */
  get busy() {
    return this.pending.size > 0
  }

  _failPending(error) {
    for (const [, job] of this.pending) {
      clearTimeout(job.timer)
      job.resolve({ ok: false, error })
    }
    this.pending.clear()
  }

  /**
   * soft: a timeout never restarts the helper (light polls such as rect/wins). Otherwise the helper
   * is restarted only when the timed-out request was the one it was working on, not when it was
   * merely queued behind a slow one (OCR).
   */
  request(cmd, args = {}, timeout = 10000, { soft = false } = {}) {
    if (!this._ensure()) return Promise.resolve({ ok: false, error: this.helperError || '屏幕助手不可用' })
    const id = ++this.seq
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const stuck = !soft && this.pending.keys().next().value === id // oldest pending = in progress
        this.pending.delete(id)
        resolve({ ok: false, error: 'timeout' })
        if (!stuck) return // a late answer is ignored by the reader
        // A hung WinRT call would block every later request: restart the helper.
        for (const [, job] of this.pending) {
          clearTimeout(job.timer)
          job.resolve({ ok: false, error: 'helper restarted' })
        }
        this.pending.clear()
        try {
          if (this.proc) this.proc.kill()
        } catch {}
        this.proc = null
      }, timeout)
      this.pending.set(id, { resolve, timer })
      try {
        this.proc.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, error: e.message })
      }
    })
  }

  dispose() {
    try {
      if (this.proc) this.proc.kill()
    } catch {}
    this.proc = null
    this._failPending('屏幕助手已停止')
  }

  // ------------------------------------------------------------ window info

  /**
   * The foreground window, with bounds in DIPs and a few derived flags:
   * own (one of the pet's windows), shell (desktop/taskbar), fullscreen.
   */
  async foreground() {
    if (['wayland', 'headless', 'unsupported'].includes(this._capabilities.session)) return null
    const r = await this.request('fg', {}, 5000)
    if (!r.ok || r.none) return null
    const phys = { x: r.x, y: r.y, width: Math.max(1, r.w), height: Math.max(1, r.h) }
    const dip = r.coordinates === 'dip' ? phys : this._dip(r.x, r.y, r.w, r.h)
    const display = screen.getDisplayMatching(dip)
    const b = display.bounds
    const fullscreen = !r.minimized && dip.x <= b.x + 1 && dip.y <= b.y + 1 && dip.x + dip.width >= b.x + b.width - 1 && dip.y + dip.height >= b.y + b.height - 1
    return {
      title: r.title || '',
      process: r.process || '',
      cls: r.cls || '',
      pid: r.pid,
      hwnd: r.hwnd,
      bounds: dip,
      display: { id: display.id, bounds: b, workArea: display.workArea, scaleFactor: display.scaleFactor },
      minimized: !!r.minimized,
      maximized: !!r.maximized,
      own: r.pid === this.ownPid || /^(ClaudeOjousama|ClaudePet)$/i.test(r.process || ''),
      shell: !!r.shell || SHELL_CLASSES.has(r.cls),
      fullscreen: fullscreen && !r.shell && !SHELL_CLASSES.has(r.cls),
      key: `${r.process}|${r.title}`,
    }
  }

  _dip(x, y, w, h) {
    const phys = { x, y, width: Math.max(1, w), height: Math.max(1, h) }
    if (process.platform === 'darwin') return phys
    if (process.platform === 'linux') {
      const point = screen.screenToDipPoint({ x, y })
      const scale = screen.getDisplayNearestPoint(point).scaleFactor || 1
      return { ...point, width: phys.width / scale, height: phys.height / scale }
    }
    try {
      return screen.screenToDipRect(null, phys)
    } catch {
      return phys
    }
  }

  /** Visible top-level windows, topmost first: { hwnd, title, process, cls, bounds (DIP), maximized, own, shell }. */
  async windows() {
    if (['wayland', 'headless', 'unsupported'].includes(this._capabilities.session)) return []
    const r = await this.request('wins', {}, 5000, { soft: true })
    if (!r.ok) return []
    return (r.windows || []).map((w) => ({
      hwnd: w.hwnd,
      title: w.title || '',
      process: w.process || '',
      cls: w.cls || '',
      pid: w.pid,
      bounds: this._dip(w.x, w.y, w.w, w.h),
      maximized: !!w.maximized,
      own: w.pid === this.ownPid || /^(ClaudeOjousama|ClaudePet)$/i.test(w.process || ''),
      shell: !!w.shell || SHELL_CLASSES.has(w.cls),
    }))
  }

  /** One window's current state: { gone } or { bounds (DIP), minimized, maximized }. */
  async rect(hwnd) {
    if (['wayland', 'headless', 'unsupported'].includes(this._capabilities.session)) return null
    const r = await this.request('rect', { hwnd }, 3000, { soft: true })
    if (!r.ok) return null
    if (r.gone) return { gone: true }
    return { gone: false, bounds: this._dip(r.x, r.y, r.w, r.h), minimized: !!r.minimized, maximized: !!r.maximized }
  }

  /** Main window titles of the given processes (music players etc.). */
  async processWindows(names) {
    if (['wayland', 'headless', 'unsupported'].includes(this._capabilities.session)) return []
    const r = await this.request('procs', { names }, 5000)
    return r.ok ? r.windows || [] : []
  }

  // ------------------------------------------------------------ pictures and text

  _checkCapture(manual = false) {
    if (!manual && this._capabilities.session === 'wayland') throw new Error('Wayland 看屏需要用户手动选择共享画面')
    if (process.platform === 'darwin' && systemPreferences) {
      const status = systemPreferences.getMediaAccessStatus('screen')
      if (status !== 'granted' && (!manual || status === 'denied' || status === 'restricted')) throw new Error('尚未获得 macOS 屏幕录制权限，请在系统设置中允许桌宠')
    }
  }

  /** User-triggered only. PipeWire displays its own picker; elsewhere the caller chooses a source. */
  async captureManual({ chooseSource } = {}) {
    this._checkCapture(true)
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 2560, height: 1600 }, fetchWindowIcons: false })
    const available = sources.filter((source) => source.thumbnail && !source.thumbnail.isEmpty())
    if (!available.length) throw new Error('没有选中共享画面，或系统拒绝了屏幕录制权限')
    const id = available.length === 1 ? available[0].id : chooseSource ? await chooseSource(available.map(({ id, name }) => ({ id, name }))) : null
    if (!id) throw new Error('已取消选择共享画面')
    const source = available.find((value) => value.id === id)
    if (!source) throw new Error('选择的共享画面已不可用')
    const display = screen.getAllDisplays().find((value) => String(value.id) === String(source.display_id)) || screen.getPrimaryDisplay()
    const size = source.thumbnail.getSize()
    return {
      image: source.thumbnail,
      info: {
        manual: true, hwnd: source.id, title: source.name || '共享画面', process: '用户选择的画面', cls: '', pid: 0,
        bounds: { x: 0, y: 0, width: size.width, height: size.height },
        display: { id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor },
        own: false, shell: false, minimized: false, maximized: false, fullscreen: false, key: source.id,
      },
    }
  }

  /** Capture just the window: { full } at native resolution (for OCR), clipped to its display. */
  async capture(info) {
    this._checkCapture()
    const d = screen.getAllDisplays().find((x) => x.id === info.display.id) || screen.getDisplayMatching(info.bounds)
    const size = { width: Math.round(d.bounds.width * d.scaleFactor), height: Math.round(d.bounds.height * d.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const src = sources.find((s) => String(s.display_id) === String(d.id)) || (sources.length === 1 ? sources[0] : null)
    if (!src || src.thumbnail.isEmpty()) throw new Error('截不到这块屏幕')
    const img = src.thumbnail
    const ts = img.getSize()
    const kx = ts.width / d.bounds.width
    const ky = ts.height / d.bounds.height
    const x0 = Math.max(0, Math.round((info.bounds.x - d.bounds.x) * kx))
    const y0 = Math.max(0, Math.round((info.bounds.y - d.bounds.y) * ky))
    const x1 = Math.min(ts.width, Math.round((info.bounds.x + info.bounds.width - d.bounds.x) * kx))
    const y1 = Math.min(ts.height, Math.round((info.bounds.y + info.bounds.height - d.bounds.y) * ky))
    if (x1 - x0 < 40 || y1 - y0 < 40) throw new Error('窗口太小或不在屏幕上')
    return img.crop({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
  }

  /** The window's own picture (not whatever covers its area now), by its handle. */
  async captureWindow(info) {
    this._checkCapture()
    const k = info.display ? info.display.scaleFactor || 1 : 1
    const size = { width: Math.min(2560, Math.round(info.bounds.width * k)), height: Math.min(2560, Math.round(info.bounds.height * k)) }
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: size, fetchWindowIcons: false })
    const src = sources.find((s) => s.id.startsWith(`window:${info.hwnd}:`))
    if (!src || src.thumbnail.isEmpty()) throw new Error('找不到那个窗口')
    return src.thumbnail
  }

  /** Save a copy for the model: long edge <= maxEdge, JPEG. Returns the temp path. */
  saveForModel(img, maxEdge = 1280) {
    const { width, height } = img.getSize()
    const k = Math.min(1, maxEdge / Math.max(width, height))
    const small = k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'good' }) : img
    const file = path.join(os.tmpdir(), `${TMP_PREFIX}${Date.now().toString(36)}.jpg`)
    fs.writeFileSync(file, small.toJPEG(82))
    return { file, size: small.getSize() }
  }

  /** OCR a captured image. lang 'auto' picks Chinese or English by what it finds. */
  async ocr(img, lang = 'auto') {
    const file = path.join(os.tmpdir(), `${TMP_PREFIX}${Date.now().toString(36)}-ocr.png`)
    fs.writeFileSync(file, img.toPNG())
    try {
      const first = await this.request('ocr', { path: file, lang: lang === 'en' ? 'en-US' : 'zh-Hans-CN' }, 15000)
      let text = first.ok ? tidyOcr(first.text) : ''
      if (lang === 'auto' && text && cjkRatio(text) < 0.08) {
        const en = await this.request('ocr', { path: file, lang: 'en-US' }, 15000)
        if (en.ok && en.text) text = tidyOcr(en.text)
      }
      return text
    } finally {
      ScreenSense.remove(file)
    }
  }

  /** Delete a temp picture; retried because the model's image reader may still hold it briefly. */
  static remove(file, tries = 6) {
    if (!file || !path.basename(file).startsWith(TMP_PREFIX)) return
    fs.rm(file, { force: true }, (err) => {
      if (err && tries > 0) setTimeout(() => ScreenSense.remove(file, tries - 1), 10000)
    })
  }

  /** Temp pictures older than maxAgeMs are never kept around (also covers crashes). */
  sweep(maxAgeMs = 20 * 60000) {
    try {
      const now = Date.now()
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (!f.startsWith(TMP_PREFIX)) continue
        const full = path.join(os.tmpdir(), f)
        try {
          if (now - fs.statSync(full).mtimeMs >= maxAgeMs) ScreenSense.remove(full, 0)
        } catch {}
      }
    } catch {}
  }

  cleanupLeftovers() {
    this.sweep(0)
  }

  /** Synchronous delete of every temp picture (used when quitting). */
  static sweepSync() {
    try {
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (f.startsWith(TMP_PREFIX)) {
          try {
            fs.rmSync(path.join(os.tmpdir(), f), { force: true })
          } catch {}
        }
      }
    } catch {}
  }
}

module.exports = { ScreenSense, tidyOcr, cjkRatio, helperCommand, initialCapabilities }
