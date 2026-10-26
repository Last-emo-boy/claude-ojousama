'use strict'
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const vm = require('vm')
const { EventEmitter } = require('events')
const { execFileSync } = require('child_process')

const file = path.join(__dirname, '..', 'src', 'main', 'screen.js')
const source = fs.readFileSync(file, 'utf8')
const display = { id: 1, bounds: { x: 0, y: 0, width: 1200, height: 800 }, workArea: { x: 0, y: 0, width: 1200, height: 780 }, scaleFactor: 2 }
const image = () => ({ isEmpty: () => false, getSize: () => ({ width: 800, height: 500 }) })

function load({ platform = 'linux', env = { DISPLAY: ':1' }, responses = {}, sources = [], permission = 'granted', spawnError } = {}) {
  const calls = [], captures = []
  const spawn = (exe, args) => {
    calls.push({ exe, args })
    const p = new EventEmitter()
    p.stdout = new EventEmitter()
    p.stdout.setEncoding = () => {}
    p.stderr = new EventEmitter()
    p.exitCode = null
    p.killed = false
    p.stdin = new EventEmitter()
    p.stdin.write = (line) => {
      const req = JSON.parse(line)
      calls.push(req)
      queueMicrotask(() => {
        const value = responses[req.cmd] || { ok: false, error: 'not implemented' }
        p.stdout.emit('data', JSON.stringify({ ...value, id: req.id }) + '\n')
      })
    }
    p.kill = () => { p.killed = true; p.exitCode = 0; p.emit('exit', 0) }
    if (spawnError) queueMicrotask(() => p.emit('error', spawnError))
    return p
  }
  const electron = {
    systemPreferences: { getMediaAccessStatus: () => permission },
    desktopCapturer: { getSources: async (options) => { captures.push(options); return sources } },
    screen: {
      screenToDipRect: (_window, rect) => ({ x: rect.x / 2, y: rect.y / 2, width: rect.width / 2, height: rect.height / 2 }),
      screenToDipPoint: (point) => ({ x: point.x / 2, y: point.y / 2 }),
      getDisplayNearestPoint: () => display,
      getDisplayMatching: () => display, getAllDisplays: () => [display], getPrimaryDisplay: () => display,
    },
  }
  const module = { exports: {} }
  vm.runInNewContext(source, {
    module, exports: module.exports, __dirname: path.dirname(file),
    require: (name) => name === 'electron' ? electron : name === 'child_process' ? { spawn } : name === 'fs' ? { ...fs, readdirSync: () => [], existsSync: () => true } : require(name),
    process: { platform, arch: 'arm64', env, pid: 99 },
    console: { warn() {} }, setTimeout, clearTimeout,
  }, { filename: file })
  return { ...module.exports, calls, captures }
}

;(async () => {
  const wayland = load({ env: { DISPLAY: ':1', XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } })
  const wl = new wayland.ScreenSense()
  assert.equal(wl.capabilities().session, 'wayland')
  assert.equal(wl.capabilities().foreground, false)
  assert.equal(await wl.foreground(), null)
  assert.equal((await wl.windows()).length, 0)
  assert.equal(wayland.calls.length, 0)
  await assert.rejects(wl.capture({}), /Wayland/)
  assert.equal(wayland.captures.length, 0)
  await assert.rejects(wl.captureManual(), /没有选中共享画面/)
  assert.equal(wayland.captures.length, 1)

  const shot1 = image(), shot2 = image()
  const manual = load({ env: { WAYLAND_DISPLAY: 'wayland-0' }, sources: [{ id: 'one', name: 'Screen 1', thumbnail: shot1 }, { id: 'two', name: 'Screen 2', thumbnail: shot2 }] })
  const m = new manual.ScreenSense()
  await assert.rejects(m.captureManual(), /已取消/)
  const selected = await m.captureManual({ chooseSource: async (choices) => {
    assert.equal(choices.length, 2)
    assert.equal(choices[1].id, 'two')
    return 'two'
  } })
  assert.equal(selected.image, shot2)
  assert.equal(selected.info.manual, true)
  assert.equal(selected.info.hwnd, 'two')
  await assert.rejects(m.captureManual({ chooseSource: async () => null }), /已取消/)

  const denied = load({ platform: 'darwin', permission: 'denied', responses: { capabilities: { ok: true, foreground: true, windows: true, ocr: true, manualCapture: true } } })
  const mac = new denied.ScreenSense()
  const cap = await mac.refreshCapabilities()
  assert.equal(cap.foreground, false)
  assert.equal(cap.windows, true)
  assert.equal(cap.permissions.screenCapture, 'denied')
  assert.equal(cap.manualCapture, true)
  await assert.rejects(mac.captureManual(), /屏幕录制权限/)
  assert.equal(denied.captures.length, 0)
  mac.dispose()

  const fg = { ok: true, hwnd: 100, pid: 5, process: 'editor', title: 'file', cls: 'Editor', x: 100, y: 80, w: 800, h: 600 }
  const linux = load({ responses: { fg, wins: { ok: true, windows: [{ ...fg, shell: true }] }, rect: { ...fg, gone: false } } })
  const x11 = new linux.ScreenSense()
  const info = await x11.foreground()
  assert.equal(info.bounds.x, 50)
  assert.equal(info.bounds.width, 400)
  assert.equal((await x11.windows())[0].shell, true)
  assert.equal((await x11.rect(100)).bounds.width, 400)
  x11.dispose()

  const macCoordinates = load({ platform: 'darwin', responses: { fg: { ...fg, coordinates: 'dip' } } })
  const cocoa = new macCoordinates.ScreenSense()
  assert.equal((await cocoa.foreground()).bounds.width, 800)
  cocoa.dispose()

  const missing = load({ spawnError: Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }) })
  const noPython = new missing.ScreenSense()
  const absent = await noPython.refreshCapabilities()
  assert.equal(absent.helperAvailable, false)
  assert.match(absent.reason, /Python 3/)
  noPython.dispose()
  assert.equal(missing.helperCommand('win32').exe, 'powershell.exe')
  assert.equal(missing.helperCommand('linux').exe, 'python3')
  assert.equal(missing.initialCapabilities('linux', {}).session, 'headless')
  if (process.platform === 'darwin') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ojousama-helper-loop-'))
    try {
      const executable = path.join(directory, 'helper-loop-test')
      execFileSync('xcrun', ['swiftc', '-parse-as-library', '-D', 'SCREEN_HELPER_TESTS',
        path.join(path.dirname(file), 'platform', 'screen-helper-macos.swift'),
        path.join(__dirname, 'macos-helper-loop.test.swift'), '-o', executable], { stdio: 'inherit' })
      execFileSync(executable, [], { stdio: 'inherit', timeout: 5000 })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
  if (process.platform === 'linux') {
    // Keep the same helper alive while dependencies and language packs change.
    execFileSync('python3', ['-c', `
import importlib.util
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('linux_screen', ${JSON.stringify(path.join(path.dirname(file), 'platform', 'screen-helper-linux.py'))})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
installation = {'path': None, 'languages': 'eng\\n'}
commands = []
def run(args, **kwargs):
    commands.append(args)
    return subprocess.CompletedProcess(args, 0, installation['languages'] if '--list-langs' in args else 'recognized text', '')

with patch.dict(module.os.environ, {}, clear=True), patch.object(module.shutil, 'which', lambda name: installation['path']), patch.object(module.subprocess, 'run', run):
    helper = module.LinuxScreen()
    assert helper.request({'cmd': 'capabilities'})['ocr'] is False
    installation['path'] = '/test/new-tesseract'
    installed = helper.request({'cmd': 'capabilities'})
    assert installed['ocr'] is True
    assert installed['dependencies']['tesseract'] is True
    assert installed['dependencies']['languages'] == ['eng']
    installation['languages'] = ''
    assert helper.request({'cmd': 'capabilities'})['ocr'] is False
    installation['languages'] = 'chi_sim\\neng\\n'
    assert helper.request({'cmd': 'capabilities'})['ocr'] is True
    installation['path'] = None
    removed = helper.request({'cmd': 'capabilities'})
    assert removed['ocr'] is False and removed['dependencies']['tesseract'] is False
    installation['path'] = '/test/reinstalled-tesseract'
    with tempfile.TemporaryDirectory() as directory:
        image = Path(directory, 'image.png')
        image.write_bytes(b'test fixture')
        assert helper.ocr(str(image), 'en-US')['text'] == 'recognized text'
    assert commands[-1][0] == '/test/reinstalled-tesseract'
    helper.close()
print('PASS Linux OCR dependency install, removal, language-pack refresh and direct OCR re-probe')
`], { stdio: 'inherit' })
  }
  console.log('PASS platform screen dispatch, DIP coordinates, Wayland manual selection and permission/error paths')
})().catch((error) => { console.error(error); process.exitCode = 1 })
