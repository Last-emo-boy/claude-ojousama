// Weather back-off: a failed first request must not be retried on every tick.
const { Weather, describe } = require('../src/main/weather')

let calls = 0
global.fetch = async () => {
  calls++
  throw new Error('offline')
}
;(async () => {
  const w = new Weather(() => 'Nowhere')
  const t = Date.now()
  await w.refresh(t)
  await w.refresh(t + 5000)
  await w.refresh(t + 60000)
  const backedOff = calls === 1
  await w.refresh(t + 21 * 60000)
  const retried = calls === 2
  // Stale or other-city data is never talked about.
  let city = 'Shanghai'
  const s = new Weather(() => city)
  s.data = { city: 'Shanghai', code: 296, desc: '小雨', temp: 18, max: 20, min: 15, rainChance: 80, at: Date.now() }
  const fresh = s.raining() && s.line().startsWith('Shanghai 小雨')
  s.data.at = Date.now() - 5 * 3600e3
  const stale = !s.raining() && s.line() === ''
  s.data.at = Date.now()
  city = 'Beijing'
  const otherCity = !s.raining()
  city = ''
  await s.refresh()
  const cleared = s.data === null && s.nextAt === 0
  const ok = backedOff && retried && fresh && stale && otherCity && cleared && describe(296) === '小雨' && describe(113) === '晴' && w.line() === ''
  console.log(JSON.stringify({ calls, backedOff, retried, fresh, stale, otherCity, cleared }))
  console.log(ok ? 'PASS' : 'FAIL')
  process.exit(ok ? 0 : 1)
})()