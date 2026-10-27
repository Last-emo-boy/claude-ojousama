import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROOT } from './prepare.mjs'
import { buildApp, buildEnvironment, releaseDirectory } from './build.mjs'

const APP_ID = 'dev.ojousama.lite.prototype'
const APP_NAME = 'Ojousama Lite'

export function installTarget({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.posix.join(home, 'Applications', `${APP_NAME}.app`)
  if (platform === 'linux') return path.posix.join(env.XDG_DATA_HOME || path.posix.join(home, '.local', 'share'), 'ojousama-lite', 'app')
  throw new Error('Windows installs use the generated NSIS installer')
}

export function desktopQuote(value) {
  if (/[\r\n]/.test(value)) throw new Error('Desktop entry paths cannot contain newlines')
  return '"' + value.replace(/%/g, '%%').replace(/[\\"`$]/g, '\\$&') + '"'
}

export function replaceApp(source, target, validTarget) {
  const exists = fs.existsSync(target)
  if (exists && !validTarget(target)) throw new Error(`Refusing to replace an unrelated directory: ${target}`)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const incoming = `${target}.installing-${process.pid}`
  const backup = `${target}.previous-${process.pid}`
  try {
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

export function assertNotRunning(target, { platform = process.platform, processes } = {}) {
  const list = processes ?? execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' })
  const paths = platform === 'win32' ? path.win32 : path.posix
  const directory = paths.normalize(target)
  const running = list.split('\n').some(line => {
    const executable = paths.normalize(line.trim().replace(/^\d+\s+/, ''))
    return executable.startsWith(directory + paths.sep) || (platform === 'linux' && paths.basename(executable) === 'ojousama-lite')
  })
  if (running) throw new Error(`Close ${APP_NAME} before installing; the running app was not changed`)
}

function oneInstaller(release, folder, extension) {
  const dir = path.join(release, 'bundle', folder)
  const files = fs.readdirSync(dir).filter(name => name.endsWith(extension))
  if (files.length !== 1) throw new Error(`Expected one ${extension} installer in ${dir}; found ${files.length}`)
  return path.join(dir, files[0])
}

function launch(executable, args) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, args, { detached: true, stdio: 'ignore', env })
  child.on('error', error => { console.error(`Installed, but could not launch: ${error.message}`); process.exitCode = 1 })
  child.unref()
}

export function main(args = process.argv.slice(2)) {
  const launchApp = !args.includes('--no-launch')
  const buildArgs = args.filter(arg => !['--no-launch', '--skip-build'].includes(arg))
  const target = process.platform === 'win32' ? null : installTarget()
  if (target) assertNotRunning(target)
  const release = args.includes('--skip-build')
    ? releaseDirectory(buildEnvironment().CARGO_TARGET_DIR, buildArgs)
    : buildApp(process.platform === 'darwin' ? [...buildArgs, '--bundles', 'app'] : buildArgs)

  if (process.platform === 'win32') {
    const installer = oneInstaller(release, 'nsis', '.exe')
    console.log(`Windows installer (run it to install): ${installer}`)
    return { installer }
  }

  let executable
  if (process.platform === 'darwin') {
    const source = path.join(release, 'bundle', 'macos', `${APP_NAME}.app`)
    const valid = dir => fs.readFileSync(path.join(dir, 'Contents', 'Info.plist'), 'utf8').includes(`<string>${APP_ID}</string>`)
    if (!valid(source)) throw new Error(`Unexpected bundle identifier: ${source}`)
    assertNotRunning(target)
    replaceApp(source, target, valid)
  } else if (process.platform === 'linux') {
    const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ojousama-lite-install-'))
    try {
      executable = path.join(target, `${APP_NAME}.AppImage`)
      fs.copyFileSync(oneInstaller(release, 'appimage', '.AppImage'), path.join(source, `${APP_NAME}.AppImage`))
      fs.chmodSync(path.join(source, `${APP_NAME}.AppImage`), 0o755)
      fs.copyFileSync(path.join(ROOT, 'src-tauri', 'icons', 'icon.png'), path.join(source, 'icon.png'))
      fs.writeFileSync(path.join(source, 'identity.json'), JSON.stringify({ id: APP_ID }))
      const valid = dir => fs.readFileSync(path.join(dir, 'identity.json'), 'utf8') === JSON.stringify({ id: APP_ID })
      assertNotRunning(target)
      replaceApp(source, target, valid)
    } finally { fs.rmSync(source, { recursive: true, force: true }) }
    const dataDir = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
    const desktopDir = path.join(dataDir, 'applications')
    fs.mkdirSync(desktopDir, { recursive: true })
    fs.writeFileSync(path.join(desktopDir, `${APP_ID}.desktop`), `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec=${desktopQuote(executable)}\nIcon=${path.join(target, 'icon.png')}\nTerminal=false\nCategories=Utility;\nStartupWMClass=${APP_NAME}\n`)
  } else throw new Error(`Unsupported desktop platform: ${process.platform}`)

  console.log(`Installed: ${target}`)
  if (launchApp) process.platform === 'darwin' ? launch('open', [target]) : launch(executable, [])
  return { target }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
