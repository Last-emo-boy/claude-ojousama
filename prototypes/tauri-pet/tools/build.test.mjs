import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SPRITES, prepareAssets } from './prepare.mjs'
import { buildArguments, buildEnvironment, releaseDirectory } from './build.mjs'
import { assertNotRunning, desktopQuote, installTarget, replaceApp } from './install.mjs'

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ojousama-lite-packaging-'))
  try { return run(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('prepare copies selected existing sprite sheets, original manifest and icon only', () => fixture(dir => {
  const repository = path.join(dir, 'repository')
  const source = path.join(repository, 'assets', 'sprites')
  const root = path.join(repository, 'prototypes', 'tauri-pet')
  fs.mkdirSync(source, { recursive: true })
  for (const name of [...SPRITES, 'unused']) fs.writeFileSync(path.join(source, `${name}.png`), `fixture-${name}`)
  const manifest = JSON.stringify({ anims: { idle: { frames: 4 }, unused: { frames: 3 } } })
  fs.writeFileSync(path.join(source, 'manifest.json'), manifest)
  fs.writeFileSync(path.join(repository, 'assets', 'icon-256.png'), 'icon fixture')
  fs.writeFileSync(path.join(repository, 'assets', 'icon.ico'), 'Windows icon fixture')
  const output = prepareAssets({ root, repository })
  assert.deepEqual(fs.readdirSync(output.sprites).sort(), [...SPRITES.map(name => `${name}.png`), 'manifest.json'].sort())
  assert.equal(fs.readFileSync(path.join(output.sprites, 'manifest.json'), 'utf8'), manifest)
  assert.equal(fs.readFileSync(output.icon, 'utf8'), 'icon fixture')
  assert.equal(fs.readFileSync(path.join(root, 'src-tauri', 'icons', 'icon.ico'), 'utf8'), 'Windows icon fixture')
  assert.equal(fs.readFileSync(path.join(output.sprites, 'idle.png'), 'utf8'), 'fixture-idle')
}))

test('missing source assets fail instead of generating placeholder art', () => fixture(dir => {
  assert.throws(() => prepareAssets({ root: path.join(dir, 'app'), repository: dir }), /ENOENT/)
}))

test('macOS build leaves synced workspace and honors explicit Cargo output', () => {
  const root = path.resolve('synced-project')
  const home = path.resolve('home')
  const env = buildEnvironment({ root, home, platform: 'darwin', env: { ELECTRON_RUN_AS_NODE: '1', EXAMPLE: 'kept' } })
  assert.equal(env.CARGO_TARGET_DIR, path.join(home, 'Library', 'Caches', 'ojousama-lite', 'target'))
  assert.equal(env.EXAMPLE, 'kept')
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
  assert.equal(buildEnvironment({ root, platform: 'linux', env: {} }).CARGO_TARGET_DIR, path.join(root, 'src-tauri', 'target'))
  assert.equal(buildEnvironment({ root, platform: 'win32', env: {} }).CARGO_TARGET_DIR, path.join(root, 'src-tauri', 'target'))
  const override = path.resolve('explicit-target')
  assert.equal(buildEnvironment({ root, platform: 'darwin', env: { CARGO_TARGET_DIR: override } }).CARGO_TARGET_DIR, override)
  assert.equal(buildEnvironment({ root, platform: 'darwin', env: { CARGO_TARGET_DIR: 'custom-target' } }).CARGO_TARGET_DIR, path.join(root, 'custom-target'))
})

test('Tauri bundle defaults and caller --no-bundle remain platform specific', () => {
  assert.deepEqual(buildArguments([], 'darwin'), ['build', '--bundles', 'app,dmg'])
  assert.deepEqual(buildArguments([], 'win32'), ['build', '--bundles', 'nsis'])
  assert.deepEqual(buildArguments([], 'linux'), ['build', '--bundles', 'deb,appimage'])
  assert.deepEqual(buildArguments(['--no-bundle'], 'darwin'), ['build', '--no-bundle'])
  assert.deepEqual(buildArguments(['--bundles', 'app', '--target', 'aarch64-apple-darwin'], 'darwin'), ['build', '--bundles', 'app', '--target', 'aarch64-apple-darwin'])
  assert.deepEqual(buildArguments(['--bundles=deb'], 'linux'), ['build', '--bundles=deb'])
  assert.throws(() => buildArguments([], 'freebsd'), /Unsupported/)
})

test('release directory follows explicit target triple and debug flag', () => {
  const target = path.resolve('target')
  assert.equal(releaseDirectory(target), path.join(target, 'release'))
  assert.equal(releaseDirectory(target, ['--target', 'x86_64-apple-darwin']), path.join(target, 'x86_64-apple-darwin', 'release'))
  assert.equal(releaseDirectory(target, ['--target=aarch64-apple-darwin', '--debug']), path.join(target, 'aarch64-apple-darwin', 'debug'))
  assert.equal(releaseDirectory(target, ['-t', 'x86_64-pc-windows-msvc', '-d']), path.join(target, 'x86_64-pc-windows-msvc', 'debug'))
  assert.throws(() => releaseDirectory(target, ['--target']), /requires/)
})

test('prototype installs separately and Linux desktop quoting preserves one executable', () => {
  const home = '/home/test'
  assert.equal(installTarget({ platform: 'darwin', home, env: {} }), path.posix.join(home, 'Applications', 'Ojousama Lite.app'))
  assert.equal(installTarget({ platform: 'linux', home, env: {} }), path.posix.join(home, '.local', 'share', 'ojousama-lite', 'app'))
  assert.equal(installTarget({ platform: 'linux', home, env: { XDG_DATA_HOME: '/data' } }), '/data/ojousama-lite/app')
  assert.throws(() => installTarget({ platform: 'win32', home }), /NSIS/)
  assert.equal(desktopQuote('/home/a b/$name%/app'), '"/home/a b/\\$name%%/app"')
  assert.throws(() => desktopQuote('/home/a\nExec=bad'), /newlines/)
})

test('replacement is staged, refuses unrelated targets and recovers a failed promotion', () => fixture(dir => {
  const source = path.join(dir, 'source')
  const target = path.join(dir, 'installed')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'binary'), 'v1')
  replaceApp(source, target, () => true)
  assert.equal(fs.readFileSync(path.join(target, 'binary'), 'utf8'), 'v1')
  fs.writeFileSync(path.join(source, 'binary'), 'v2')
  assert.throws(() => replaceApp(source, target, () => false), /unrelated directory/)
  const rename = fs.renameSync
  fs.renameSync = (from, to) => {
    if (from === `${target}.installing-${process.pid}`) throw new Error('promotion fixture failure')
    return rename(from, to)
  }
  try { assert.throws(() => replaceApp(source, target, () => true), /promotion fixture/) } finally { fs.renameSync = rename }
  assert.equal(fs.readFileSync(path.join(target, 'binary'), 'utf8'), 'v1')
  assert.deepEqual(fs.readdirSync(dir).sort(), ['installed', 'source'])
  replaceApp(source, target, () => true)
  assert.equal(fs.readFileSync(path.join(target, 'binary'), 'utf8'), 'v2')
  if (process.platform !== 'win32') {
    fs.symlinkSync('binary', path.join(source, 'relative-link'))
    replaceApp(source, target, () => true)
    assert.equal(fs.readlinkSync(path.join(target, 'relative-link')), 'binary')
    fs.rmSync(source, { recursive: true })
    assert.equal(fs.readFileSync(path.join(target, 'relative-link'), 'utf8'), 'v2')
  }
}))

test('running prototype is refused without terminating another app', () => {
  const target = '/Users/test/Applications/Ojousama Lite.app'
  assert.throws(() => assertNotRunning(target, { platform: 'darwin', processes: `123 ${target}/Contents/MacOS/ojousama-lite\n` }), /Close Ojousama Lite/)
  assert.doesNotThrow(() => assertNotRunning(target, { platform: 'darwin', processes: '123 /Applications/Other.app/Contents/MacOS/Other\n' }))
  assert.throws(() => assertNotRunning('/home/test/.local/share/ojousama-lite/app', { platform: 'linux', processes: '123 /tmp/.mount_fixture/usr/bin/ojousama-lite\n' }), /Close Ojousama Lite/)
})

test('process fixtures apply the selected platform separator rather than the test host', () => {
  const windowsTarget = path.win32.join('C:\\Users\\test', 'Applications', 'Ojousama Lite.app')
  const windowsExecutable = path.win32.join(windowsTarget, 'bin', 'ojousama-lite.exe')
  assert.throws(() => assertNotRunning(windowsTarget, { platform: 'win32', processes: `123 ${windowsExecutable}\n` }), /Close Ojousama Lite/)
  assert.throws(() => assertNotRunning(windowsTarget, { platform: 'win32', processes: `123 ${windowsExecutable.replaceAll('\\', '/')}\n` }), /Close Ojousama Lite/)
  const linuxTarget = path.posix.join('/home/test', '.local', 'share', 'ojousama-lite', 'app')
  assert.throws(() => assertNotRunning(linuxTarget, { platform: 'linux', processes: `123 ${path.posix.join(linuxTarget, 'Ojousama Lite.AppImage')}\n` }), /Close Ojousama Lite/)
  assert.doesNotThrow(() => assertNotRunning('/Users/test/Ojousama Lite.app', { platform: 'darwin', processes: '123 /Users/test/Ojousama Lite.app.backup/Contents/MacOS/ojousama-lite\n' }))
})
