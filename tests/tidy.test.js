// Unit check for tidy.scanNew: baseline, new stable file, edited old file, partial download.
const fs = require('fs')
const os = require('os')
const path = require('path')
const tidy = require('../src/main/tidy')

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tidy-'))
  const st = { seen: {}, pending: {} }
  const write = (n, s) => fs.writeFileSync(path.join(dir, n), s)
  write('old.md', 'v1')
  let t = Date.now()
  const r0 = await tidy.scanNew([dir], st, t)
  write('old.md', 'v2 edited') // an old file changes
  write('new.pdf', 'pdf')
  write('dl.zip.crdownload', 'partial')
  const r1 = await tidy.scanNew([dir], st, t + 1000)
  const r2 = await tidy.scanNew([dir], st, t + 120000)
  const res = {
    baseline: r0.length,
    firstSight: r1.map((f) => f.name),
    ready: r2.map((f) => f.name + '->' + f.cat),
    plan: tidy.planMoves(r2).map((m) => path.relative(dir, m.to)),
  }
  fs.rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify(res))
  const ok = res.baseline === 0 && res.firstSight.length === 0 && res.ready.join() === 'new.pdf->文档'
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()
