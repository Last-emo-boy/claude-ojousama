'use strict'
const fs = require('fs')
const path = require('path')

const MARKER = 'X-Ojousama-Autostart=true'
const quote = (value) => '"' + value.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&') + '"'

function setAutoStart(app, enabled, root, { platform = process.platform, env = process.env, executable = process.execPath } = {}) {
  if (platform !== 'linux') {
    app.setLoginItemSettings(app.isPackaged ? { openAtLogin: enabled } : { openAtLogin: enabled, path: executable, args: [root] })
    return
  }
  const file = path.join(app.getPath('appData'), 'autostart', 'com.claude-ojousama.app.desktop')
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MARKER)) throw new Error('已有同名开机启动项，请先在系统设置中检查，桌宠没有覆盖它')
  if (!enabled) {
    if (fs.existsSync(file)) fs.unlinkSync(file)
    return
  }
  const command = [env.APPIMAGE || executable, ...(!app.isPackaged ? [root] : [])].map(quote).join(' ')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Claude Ojousama\nExec=${command}\nTerminal=false\n${MARKER}\n`, { mode: 0o644 })
}

module.exports = { setAutoStart }
