// Run one headless DSH turn with the pet's patch and summarise the events.
// Usage: node tools/_dsh_probe.js "<prompt>" [permission]
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')

const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const exe = path.join(local, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')
const cli = path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
const patch = path.join(process.env.APPDATA, 'claude-ojousama', 'dsh-pet-patch.yml')
const prompt = process.argv[2] || 'hi'
const permission = process.argv[3] || 'read-only'

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: permission }
for (const k of ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SHELL', 'DSH_WEB_URL']) delete env[k]
const started = Date.now()
const child = spawn(exe, ['--expose-internals', cli, '--profile', 'headless', '--patch', patch, '--json', '-'], { env, windowsHide: true, cwd: os.tmpdir() })
let buf = ''
const tools = []
let final = ''
const types = {}
child.stdout.setEncoding('utf8')
child.stdout.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      const e = JSON.parse(line)
      types[e.type] = (types[e.type] || 0) + 1
      if (e.type === 'tool_call') tools.push(e.tool + ' ' + JSON.stringify(e.input || {}).slice(0, 120))
      if (e.type === 'final') final = e.text || ''
    } catch {}
  }
})
let err = ''
child.stderr.on('data', (d) => (err += d))
child.on('close', (code) => {
  console.log(JSON.stringify({ code, secs: Math.round((Date.now() - started) / 1000), types, tools, final: final.slice(0, 400), stderr: err.trim().split(/\r?\n/).slice(-3).join(' | ') }, null, 1))
})
child.stdin.end(prompt, 'utf8')
