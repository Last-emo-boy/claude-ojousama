// Smoke test for src/main/screen-helper.ps1: fg, ocr, procs.
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')

const helper = path.join(__dirname, '..', 'src', 'main', 'screen-helper.ps1')
const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { windowsHide: true })
let buf = ''
const pending = new Map()
p.stdout.setEncoding('utf8')
p.stdout.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    const r = JSON.parse(line)
    pending.get(r.id)?.(r)
  }
})
p.stderr.on('data', (d) => process.stderr.write(d))
let id = 0
const req = (o) => new Promise((resolve) => {
  const i = ++id
  pending.set(i, resolve)
  p.stdin.write(JSON.stringify({ id: i, ...o }) + '\n')
})
;(async () => {
  let t = Date.now()
  const fg = await req({ cmd: 'fg' })
  console.log('fg', Date.now() - t, 'ms', JSON.stringify({ title: fg.title, process: fg.process, cls: fg.cls, x: fg.x, y: fg.y, w: fg.w, h: fg.h, max: fg.maximized }))
  t = Date.now()
  const fg2 = await req({ cmd: 'fg' })
  console.log('fg again', Date.now() - t, 'ms', fg2.ok)
  t = Date.now()
  const ocr = await req({ cmd: 'ocr', path: path.join(os.tmpdir(), 'pet_vision_test.png'), lang: 'zh-Hans-CN' })
  console.log('ocr', Date.now() - t, 'ms', JSON.stringify(ocr.ok ? ocr.text : ocr.error))
  t = Date.now()
  const procs = await req({ cmd: 'procs', names: ['explorer', 'cloudmusic', 'QQMusic', 'Spotify'] })
  console.log('procs', Date.now() - t, 'ms', JSON.stringify(procs.windows || procs.error).slice(0, 200))
  p.stdin.end()
})()
