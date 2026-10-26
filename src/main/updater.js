'use strict'
// Checks GitHub Releases for a newer version. Never downloads or installs anything by itself:
// the pet tells the user and opens the download (or the release page) when asked.

const REPO = 'Silasvanceneo/claude-ojousama'
const API = `https://api.github.com/repos/${REPO}/releases/latest`
const HOUR = 3600e3

/** "v2.10.0" -> [2, 10, 0, prerelease?]; null when not a version. */
function parseVersion(v) {
  const m = String(v || '').trim().match(/^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/)
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3] || 0)], pre: m[4] || '' }
}

/** >0 when a is newer than b. A release (no suffix) is newer than its own pre-release. */
function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i]
  if (x.pre === y.pre) return 0
  if (!x.pre) return 1
  if (!y.pre) return -1
  return x.pre < y.pre ? -1 : 1
}

/** The best download for this computer among the release assets, or null. */
function pickAsset(assets, platform = process.platform, arch = process.arch) {
  const list = (assets || []).filter((a) => a && a.name && a.browser_download_url)
  const has = (a, re) => re.test(a.name)
  const archRe = arch === 'arm64' ? /arm64|aarch64/i : /x64|amd64|x86_64/i
  const otherArch = arch === 'arm64' ? /x64|amd64|x86_64/i : /arm64|aarch64/i
  const prefs = {
    win32: [/\.exe$/i, /win.*\.zip$/i],
    darwin: [/\.dmg$/i, /mac.*\.zip$/i],
    linux: [/\.AppImage$/i, /\.deb$/i],
  }[platform] || []
  for (const re of prefs) {
    const cands = list.filter((a) => has(a, re) && !/blockmap/i.test(a.name))
    const exact = cands.find((a) => has(a, archRe)) || cands.find((a) => !has(a, otherArch))
    if (exact) return { name: exact.name, url: exact.browser_download_url, size: exact.size || 0 }
  }
  return null
}

/** First paragraph-ish summary of release notes for the bubble (plain text, short). */
function summarize(body, max = 120) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*|^[-*]\s*|[*_`]/g, '').trim())
    .filter((l) => l && !/^(!\[|<)/.test(l))
  const text = lines.slice(0, 4).join('；')
  return text.length > max ? text.slice(0, max) + '…' : text
}

class Updater {
  /**
   * @param {{ current: string, fetchImpl?: Function, now?: () => number }} opts
   */
  constructor({ current, fetchImpl, now } = {}) {
    this.current = current
    this.fetch = fetchImpl || ((...a) => fetch(...a))
    this.now = now || Date.now
    this.latest = null // { version, url, name, notes, asset, publishedAt }
    this.checkedAt = 0
    this.error = ''
    this.busy = false
  }

  /** Ask GitHub for the latest release. Resolves to the info object when it is newer, else null. */
  async check() {
    if (this.busy) return null
    this.busy = true
    try {
      const r = await this.fetch(API, {
        signal: AbortSignal.timeout(15000),
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'claude-ojousama-updater' },
      })
      this.checkedAt = this.now()
      if (r.status === 404) {
        this.error = ''
        this.latest = null
        return null // no release published yet
      }
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      if (j.draft || j.prerelease) return null
      const version = String(j.tag_name || j.name || '').replace(/^v/i, '')
      if (!parseVersion(version)) throw new Error('bad tag ' + j.tag_name)
      this.error = ''
      this.latest = {
        version,
        name: String(j.name || 'v' + version).slice(0, 80),
        url: String(j.html_url || `https://github.com/${REPO}/releases/latest`),
        notes: summarize(j.body),
        asset: pickAsset(j.assets),
        publishedAt: Date.parse(j.published_at) || 0,
      }
      return compareVersions(version, this.current) > 0 ? this.latest : null
    } catch (e) {
      this.checkedAt = this.now()
      this.error = e.message
      return null
    } finally {
      this.busy = false
    }
  }

  /** A newer version is known (from the last check). */
  get available() {
    return this.latest && compareVersions(this.latest.version, this.current) > 0 ? this.latest : null
  }

  /**
   * Whether to tell the user about `info` now, given what they said before.
   * state: { skipVersion, laterUntil, notifiedVersion }
   */
  static shouldNotify(info, state, now = Date.now()) {
    if (!info) return false
    if (state.skipVersion && compareVersions(info.version, state.skipVersion) <= 0) return false
    if (now < (state.laterUntil || 0)) return false
    return true
  }
}

module.exports = { Updater, parseVersion, compareVersions, pickAsset, summarize, REPO, HOUR }
