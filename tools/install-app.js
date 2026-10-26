'use strict'
// Source installs use the same packaged app as release downloads; user data stays outside it.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const APP_ID = 'com.claude-ojousama.app'

function installTarget({ platform = process.platform, home = os.homedir() } = {}) {
  return platform === 'darwin' ? path.join(home, 'Applications', 'Claude Ojousama.app') : path.join(home, '.local', 'share', 'claude-ojousama', 'app')
}

function run(exe, args, options = {}) {
  const result = spawnSync(exe, args, { cwd: ROOT, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(exe)} exited with ${result.status}`)
}

function desktopQuote(value) {
  return '"' + value.replace(/[%]/g, '%%').replace(/[\\"`$]/g, '\\$&') + '"'
}

function replaceApp(source, target, validTarget) {
  const exists = fs.existsSync(target)
  if (exists && !validTarget(target)) throw new Error(`Refusing to replace an unrelated directory: ${target}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const incoming = `${target}.installing-${process.pid}`
  const backup = `${target}.previous-${process.pid}`
  try {
    // macOS frameworks use relative links; resolving them ties the installed app to the build tree.
    fs.cpSync(source, incoming, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    if (exists) fs.renameSync(target, backup)
    fs.renameSync(incoming, target)
  } catch (error) {
    if (exists && !fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target)
    throw error
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true })
  }
  if (exists) fs.rmSync(backup, { recursive: true, force: true })
}

function main(args = process.argv.slice(2)) {
  const launch = !args.includes('--no-launch')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (process.platform === 'win32') {
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'install.ps1'), ...(launch ? ['-Launch'] : [])], { env })
    return
  }
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error(`Unsupported desktop platform: ${process.platform}`)
  const { buildApp, packagePath } = require('./build-app')
  const source = packagePath(buildApp({ dir: true }))
  let target, executable
  if (process.platform === 'darwin') {
    target = installTarget()
    replaceApp(source, target, (dir) => {
      const plist = path.join(dir, 'Contents', 'Info.plist')
      return fs.existsSync(plist) && fs.readFileSync(plist, 'utf8').includes(`<string>${APP_ID}</string>`)
    })
  } else {
    target = installTarget()
    replaceApp(source, target, (dir) => {
      const metadata = path.join(dir, 'resources', 'app', 'package.json')
      return fs.existsSync(metadata) && JSON.parse(fs.readFileSync(metadata, 'utf8')).name === 'claude-ojousama'
    })
    executable = path.join(target, 'claude-ojousama')
    const desktopDir = path.join(os.homedir(), '.local', 'share', 'applications')
    fs.mkdirSync(desktopDir, { recursive: true })
    fs.writeFileSync(path.join(desktopDir, `${APP_ID}.desktop`), `[Desktop Entry]\nType=Application\nName=Claude Ojousama\nComment=Pixel-art AI desktop companion\nExec=${desktopQuote(executable)}\nIcon=${path.join(target, 'resources', 'app', 'assets', 'icon.png')}\nTerminal=false\nCategories=Utility;\nStartupWMClass=claude-ojousama\n`, 'utf8')
  }
  console.log(`Installed: ${target}`)
  if (launch) {
    const child = process.platform === 'darwin' ? spawn('open', [target], { detached: true, stdio: 'ignore', env }) : spawn(executable, [], { detached: true, stdio: 'ignore', env })
    child.on('error', (error) => { console.error(`Installed, but could not launch: ${error.message}`); process.exitCode = 1 })
    child.unref()
  }
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { desktopQuote, replaceApp, installTarget, main }
