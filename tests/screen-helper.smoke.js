// Smoke test for src/main/screen-helper.ps1 (Windows only): fg, wins, rect, ocr, procs.
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

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
    const done = pending.get(r.id)
    if (done) done(r)
  }
})
p.stderr.on('data', (d) => process.stderr.write(d))
let id = 0
const req = (o) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    p.stdin.write(JSON.stringify({ id: i, ...o }) + '\n')
  })
const time = async (label, o) => {
  const t = Date.now()
  const r = await req(o)
  console.log(label, Date.now() - t, 'ms', r.ok ? '' : 'ERROR ' + r.error)
  return r
}

;(async () => {
  let failed = 0
  const fg = await time('fg', { cmd: 'fg' })
  console.log('  ', JSON.stringify({ title: fg.title, process: fg.process, w: fg.w, h: fg.h }))
  const wins = await time('wins', { cmd: 'wins' })
  console.log('   windows:', (wins.windows || []).length, (wins.windows || []).slice(0, 4).map((w) => `${w.process}:${w.w}x${w.h}`).join(' | '))
  if (!wins.ok || !(wins.windows || []).length) failed++
  if (fg.hwnd) {
    const r = await time('rect', { cmd: 'rect', hwnd: fg.hwnd })
    if (!r.ok || r.gone || r.w !== fg.w) failed++
  }
  const img = path.join(os.tmpdir(), 'pet_vision_test.png')
  if (fs.existsSync(img)) {
    const ocr = await time('ocr', { cmd: 'ocr', path: img, lang: 'zh-Hans-CN' })
    console.log('  ', JSON.stringify(ocr.text))
  } else console.log('ocr skipped (no test image)')
  const procs = await time('procs', { cmd: 'procs', names: ['explorer'] })
  if (!procs.ok) failed++
  p.stdin.end()
  console.log(failed ? 'FAIL' : 'PASS')
  process.exitCode = failed ? 1 : 0
})()
