// Unit checks for src/main/updater.js: version comparison, asset choice, check() and notify rules.
const { Updater, compareVersions, pickAsset, summarize } = require('../src/main/updater')

const cases = []
const check = (name, got, want) => cases.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })

check('newer patch', compareVersions('2.1.1', '2.1.0') > 0, true)
check('newer minor beats patch', compareVersions('v2.10.0', '2.9.9') > 0, true)
check('same', compareVersions('v2.1.0', '2.1.0'), 0)
check('older', compareVersions('2.0.9', '2.1.0') < 0, true)
check('release beats its prerelease', compareVersions('2.2.0', '2.2.0-beta.1') > 0, true)
check('garbage is not newer', compareVersions('latest', '2.1.0'), 0)

const assets = [
  'Claude Ojousama-2.2.0-win-x64.exe', 'Claude Ojousama-2.2.0-win-x64.exe.blockmap', 'Claude Ojousama-2.2.0-win-x64.zip',
  'Claude Ojousama-2.2.0-mac-arm64.dmg', 'Claude Ojousama-2.2.0-mac-x64.dmg', 'Claude Ojousama-2.2.0-mac-arm64.zip',
  'Claude Ojousama-2.2.0-linux-x86_64.AppImage', 'Claude Ojousama-2.2.0-linux-amd64.deb',
].map((name) => ({ name, browser_download_url: 'https://dl/' + encodeURIComponent(name), size: 1 }))
check('windows exe', pickAsset(assets, 'win32', 'x64').name, 'Claude Ojousama-2.2.0-win-x64.exe')
check('mac arm dmg', pickAsset(assets, 'darwin', 'arm64').name, 'Claude Ojousama-2.2.0-mac-arm64.dmg')
check('mac intel dmg', pickAsset(assets, 'darwin', 'x64').name, 'Claude Ojousama-2.2.0-mac-x64.dmg')
check('linux appimage', pickAsset(assets, 'linux', 'x64').name, 'Claude Ojousama-2.2.0-linux-x86_64.AppImage')
check('windows zip fallback', pickAsset(assets.filter((a) => !a.name.endsWith('.exe')), 'win32', 'x64').name, 'Claude Ojousama-2.2.0-win-x64.zip')
check('no asset', pickAsset([], 'win32', 'x64'), null)
check('summary strips markdown', summarize('## 新功能\n- **检测更新**\n- 跨平台\n![img](x.png)'), '新功能；检测更新；跨平台')

const res = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body })
;(async () => {
  const rel = { tag_name: 'v2.2.0', name: 'v2.2.0 小更新', html_url: 'https://github.com/x/releases/tag/v2.2.0', body: '- 修复', assets, published_at: '2026-10-27T00:00:00Z' }
  let u = new Updater({ current: '2.1.0', fetchImpl: res(200, rel) })
  const info = await u.check()
  check('newer found', info && info.version, '2.2.0')
  check('asset chosen', !!(info && info.asset), true)
  u = new Updater({ current: '2.2.0', fetchImpl: res(200, rel) })
  check('same version -> null', await u.check(), null)
  u = new Updater({ current: '2.1.0', fetchImpl: res(200, { ...rel, prerelease: true }) })
  check('prerelease ignored', await u.check(), null)
  u = new Updater({ current: '2.1.0', fetchImpl: res(404, {}) })
  check('no release yet -> null, no error', [await u.check(), u.error], [null, ''])
  u = new Updater({ current: '2.1.0', fetchImpl: async () => { throw new Error('offline') } })
  check('offline -> null with error', [await u.check(), u.error], [null, 'offline'])
  u = new Updater({ current: '2.1.0', fetchImpl: res(403, {}) })
  check('rate limited -> error', [await u.check(), u.error], [null, 'HTTP 403'])

  const now = 1e12
  const v = { version: '2.2.0' }
  check('notify fresh', Updater.shouldNotify(v, {}, now), true)
  check('skipped version', Updater.shouldNotify(v, { skipVersion: '2.2.0' }, now), false)
  check('newer than skipped', Updater.shouldNotify({ version: '2.3.0' }, { skipVersion: '2.2.0' }, now), true)
  check('later not yet', Updater.shouldNotify(v, { laterUntil: now + 1000 }, now), false)
  check('later passed', Updater.shouldNotify(v, { laterUntil: now - 1 }, now), true)

  const bad = cases.filter((c) => !c.ok)
  for (const c of bad) console.log('FAIL', c.name, 'got', JSON.stringify(c.got), 'want', JSON.stringify(c.want))
  console.log(`${cases.length - bad.length}/${cases.length} passed`)
  process.exit(bad.length ? 1 : 0)
})()
