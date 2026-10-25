'use strict'
// Moves the pet window: walking along the taskbar, falling after a drop, shaking.
const { screen } = require('electron')

class Motion {
  /**
   * @param {() => Electron.BrowserWindow | null} getWin
   * @param {(dir: 1 | -1) => void} onFace called when the walking direction changes
   */
  constructor(getWin, onFace) {
    this.getWin = getWin
    this.onFace = onFace
    this.timer = null
    this.cancelCurrent = null
  }

  /** Move without letting Windows DPI rounding grow the transparent window. */
  setPos(win, x, y) {
    const s = this.size || win.getSize()
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: s[0], height: s[1] })
  }

  get busy() {
    return !!this.timer
  }

  workArea() {
    const win = this.getWin()
    const b = win.getBounds()
    return screen.getDisplayMatching(b).workArea
  }

  floorY() {
    const win = this.getWin()
    const wa = this.workArea()
    return wa.y + wa.height - (this.size ? this.size[1] : win.getBounds().height)
  }

  /** Clamp an x so the window centre stays on the current display. */
  clampX(x) {
    const wa = this.workArea()
    const w = this.size ? this.size[0] : this.getWin().getBounds().width
    return Math.max(wa.x - w / 2 + 40, Math.min(wa.x + wa.width - w / 2 - 40, x))
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.cancelCurrent) this.cancelCurrent()
    this.cancelCurrent = null
  }

  _animate(step) {
    this.stop()
    return new Promise((resolve) => {
      let last = Date.now()
      this.cancelCurrent = () => resolve(false)
      this.timer = setInterval(() => {
        const win = this.getWin()
        if (!win || win.isDestroyed()) return this.stop()
        const now = Date.now()
        const dt = Math.min(0.05, (now - last) / 1000)
        last = now
        if (step(win, dt) === true) {
          clearInterval(this.timer)
          this.timer = null
          this.cancelCurrent = null
          resolve(true)
        }
      }, 16)
    })
  }

  /** Walk horizontally to window x = target (pixels per second). */
  walkTo(targetX, speed = 70, { allowOffscreen = false } = {}) {
    const win = this.getWin()
    const target = Math.round(allowOffscreen ? targetX : this.clampX(targetX))
    let [x, y] = win.getPosition()
    const dir = target >= x ? 1 : -1
    this.onFace(dir)
    let fx = x
    return this._animate((w, dt) => {
      fx += dir * speed * dt
      if ((dir > 0 && fx >= target) || (dir < 0 && fx <= target)) {
        this.setPos(w, target, y)
        return true
      }
      this.setPos(w, Math.round(fx), y)
    })
  }

  /** Walk by a relative distance. */
  walkBy(dx, speed) {
    const [x] = this.getWin().getPosition()
    return this.walkTo(x + dx, speed)
  }

  /** Fall with gravity until the window rests on the taskbar (or on `floorY`, e.g. a window's top edge). */
  fall(floorY) {
    const win = this.getWin()
    const floor = floorY != null ? Math.round(floorY) : this.floorY()
    let [x, y] = win.getPosition()
    if (y >= floor - 2) {
      this.setPos(win, x, floor)
      return Promise.resolve(false)
    }
    let vy = 0
    let fy = y
    return this._animate((w, dt) => {
      vy += 2600 * dt
      fy += vy * dt
      if (fy >= floor) {
        this.setPos(w, x, floor)
        return true
      }
      this.setPos(w, x, Math.round(fy))
    })
  }

  /** Quick horizontal shake (knock-knock prank). */
  shake(ms = 600, amp = 6) {
    const win = this.getWin()
    const [x, y] = win.getPosition()
    const start = Date.now()
    return this._animate((w) => {
      const t = Date.now() - start
      if (t >= ms) {
        this.setPos(w, x, y)
        return true
      }
      this.setPos(w, x + Math.round(Math.sin(t / 22) * amp), y)
    })
  }

  /** Hop along an arc to window position (tx, ty); used to climb onto a window's title bar. */
  jumpTo(tx, ty, ms = 650, arc = 90) {
    const win = this.getWin()
    const [x0, y0] = win.getPosition()
    const start = Date.now()
    this.onFace(tx >= x0 ? 1 : -1)
    return this._animate((w) => {
      const t = Math.min(1, (Date.now() - start) / ms)
      const x = x0 + (tx - x0) * t
      const y = y0 + (ty - y0) * t - arc * 4 * t * (1 - t)
      this.setPos(w, Math.round(x), Math.round(y))
      if (t >= 1) return true
    })
  }

  /** Put the window on the floor at x (no animation). */
  place(x, y) {
    const win = this.getWin()
    this.setPos(win, Math.round(x), Math.round(y == null ? this.floorY() : y))
  }
}

module.exports = { Motion }
