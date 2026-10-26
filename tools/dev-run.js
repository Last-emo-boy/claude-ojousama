'use strict'
const { spawn, spawnSync } = require('child_process')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const development = !process.argv.includes('--start')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// DSH workspaces can have a Low integrity label: keep the existing Windows runtime launcher.
if (process.platform === 'win32' && development) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'dev-run.ps1')], { cwd: ROOT, env, stdio: 'inherit' })
  if (result.error) console.error(result.error.message)
  process.exit(result.status == null ? 1 : result.status)
}

const build = spawnSync(process.execPath, [path.join(__dirname, 'build-screen-helper.js')], { cwd: ROOT, env, stdio: 'inherit' })
if (build.error || build.status !== 0) {
  if (build.error) console.error(build.error.message)
  process.exit(build.status || 1)
}
if (development) env.CLAUDE_PET_DEBUG = '1'
const child = spawn(require('electron'), [...(development ? ['--inspect=9229'] : []), ROOT], { cwd: ROOT, env, stdio: 'inherit' })
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code == null ? 1 : code })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
