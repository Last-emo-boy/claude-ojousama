'use strict'
// Optional weather for one city (settings.weatherCity; empty = off, nothing is fetched).
// Source: wttr.in JSON. Used for the umbrella animation, rain reminders and the context block.

const RAIN = new Set([176, 200, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 353, 356, 359, 386, 389])
const HEAVY = new Set([305, 308, 356, 359])
const THUNDER = new Set([200, 386, 389])
const SNOW = new Set([179, 227, 230, 323, 326, 329, 332, 335, 338, 368, 371, 392, 395])
const SLEET = new Set([182, 185, 317, 320, 350, 362, 365, 374, 377])
const FOG = new Set([143, 248, 260])

function describe(code) {
  if (THUNDER.has(code)) return '雷阵雨'
  if (HEAVY.has(code)) return '大雨'
  if (RAIN.has(code)) return '小雨'
  if (SNOW.has(code)) return '下雪'
  if (SLEET.has(code)) return '雨夹雪'
  if (FOG.has(code)) return '有雾'
  if (code === 113) return '晴'
  if (code === 116) return '多云'
  if (code === 119 || code === 122) return '阴'
  return '天气一般'
}

class Weather {
  constructor(getCity) {
    this.getCity = getCity
    this.data = null // { city, code, desc, temp, max, min, rainChance, at }
    this.nextAt = 0
    this.busy = false
  }

  async refresh(now = Date.now()) {
    const city = String(this.getCity() || '').trim()
    if (!city) {
      this.data = null
      this.city = ''
      this.nextAt = 0 // setting a city again fetches right away
      return null
    }
    // The back-off also applies after a failed first attempt (no data yet), per city.
    if (this.busy || (now < this.nextAt && this.city === city)) return this.data
    if (this.city !== city) this.data = null
    this.city = city
    this.busy = true
    try {
      const r = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'claude-ojousama' },
      })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      const c = j.current_condition[0]
      const today = j.weather[0]
      const hour = new Date().getHours()
      // Rain chance for the rest of today (3-hour slots).
      const later = today.hourly.filter((h) => Number(h.time) / 100 + 3 > hour)
      const code = Number(c.weatherCode)
      this.data = {
        city,
        code,
        desc: describe(code),
        temp: Number(c.temp_C),
        max: Number(today.maxtempC),
        min: Number(today.mintempC),
        rainChance: Math.max(0, ...later.map((h) => Number(h.chanceofrain) || 0)),
        at: now,
      }
      this.nextAt = now + 90 * 60000
    } catch (e) {
      console.warn('[weather]', e.message)
      this.nextAt = now + 20 * 60000
    } finally {
      this.busy = false
    }
    return this.data
  }

  /** The data if it is recent enough to talk about (failed refreshes must not keep old rain alive). */
  get current() {
    const d = this.data
    return d && d.city === String(this.getCity() || '').trim() && Date.now() - d.at < 4 * 3600e3 ? d : null
  }

  raining() {
    const d = this.current
    return !!d && (RAIN.has(d.code) || SLEET.has(d.code))
  }

  /** "上海 晴 18°C（13~22°C，之后降雨概率 10%）" or '' */
  line() {
    const d = this.current
    if (!d) return ''
    return `${d.city} ${d.desc} ${d.temp}°C（${d.min}~${d.max}°C，之后降雨概率 ${d.rainChance}%）`
  }
}

module.exports = { Weather, describe }
