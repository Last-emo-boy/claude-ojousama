'use strict'
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const { EventEmitter } = require('events')
const { desktopMode } = require('../src/main/platform')
const { setAutoStart } = require('../src/main/autostart')
const { DEFAULTS } = require('../src/main/store')
const pranks = require('../src/main/pranks')
const os = require('os')

const file = path.resolve(__dirname, '../src/main/main.js')
const source = fs.readFileSync(file, 'utf8')
const localRequire = createRequire(file)
const runs = [], dialogs = []
let lastWindow
class FakeWindow extends EventEmitter {
  constructor(options) { super(); this.options=options; this.webContents={send(){},on(){}}; this.visible=true; lastWindow=this }
  isDestroyed() { return false }
  isVisible() { return this.visible }
  hide() { this.visible=false }
  showInactive() { this.visible=true }
  setAlwaysOnTop() {}
  setIgnoreMouseEvents() {}
  loadFile() {}
}
class FakeRun extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    runs.push(this)
    queueMicrotask(() => this.emit('done', { ok: true, final: '已看到测试画面', sessionId: 'test-thread' }))
  }
  kill() { this.killed = true }
}
const electron = {
  app: { commandLine: { appendSwitch() {} }, setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {}, getPath: () => __dirname },
  powerMonitor: { getSystemIdleTime: () => 0 },
  BrowserWindow: FakeWindow,
  screen: { getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1600,height:900}}),getDisplayNearestPoint:()=>({workArea:{x:0,y:0,width:1600,height:900}}) },
  Menu: { buildFromTemplate:items=>items },
  dialog: { showMessageBox: async (_window, options) => { dialogs.push(options); return { response: 0 } } },
}
const context = {
  require(name) {
    if (name === 'electron') return electron
    if (name === './codex') return { CodexRun: FakeRun, locateCodex: () => ({ exe: '/test/codex' }) }
    if (name === './dsh') return { DshRun: FakeRun, locateDsh: () => ({ exe: '/test/dsh' }), writePetPatch: () => ({}), DSH_HOME: __dirname, TOOLSETS: { look: [], none: [], scan: [] } }
    if (name === './screen') return { ScreenSense: class { static remove() {} } }
    return localRequire(name)
  },
  process: { platform: process.platform, env: {}, on() {} },
  __dirname: path.dirname(file),
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
}
vm.createContext(context)
vm.runInContext(source + `
globalThis.testMain = {
  startRun, snapshot, glance, requestAgentApproval, requestAgentInput, refreshScreenCapabilities, createPetWindow, togglePet,
  initialize(data, sense) {
    store = { get: k => data[k], set: (k,v) => data[k]=v, patch: (k,p) => data[k]={...data[k],...p} };
    screenSense = sense;
    growth = { retrieve:()=>[], level:()=>1, data:{notes:[]}, prefsLine:()=>'', view:()=>({}) };
    petWin = new BrowserWindow({});
    tray = {setContextMenu(){},setToolTip(){}};
  }
};`, context, { filename: file })
const main = context.testMain
const data = { ...structuredClone(DEFAULTS), settings: { backend: 'codex', permission: 'read-only', rules: {screen:'auto'}, cwd: '', scale: 1.5 }, pet: {}, chat: {messages:[]}, activity: [], goals: [], todos: [], reminders: [], tasks: [], memories: [], alerts: [], inbox: [] }
const manualImage = { synthetic: true }
let savedImage
const capabilities = { platform: 'linux', session: 'wayland', foreground: false, windows: false, manualCapture: true, screenCapture: false, ocr: true, reason: 'manual only' }
const sense = {
  capabilities: () => capabilities,
  refreshCapabilities: async () => capabilities,
  foreground: async () => { throw new Error('manual screenshot must not query foreground') },
  saveForModel: image => { savedImage = image; return {file:'/synthetic-shot.jpg'} },
  ocr: async () => 'synthetic OCR',
}
main.initialize(data, sense)

;(async () => {
  const run = main.startRun({ prompt: 'hi', sessionId: 'legacy-dsh-id' })
  assert.equal(run.options.sessionId, null)
  assert.equal(run.options.scanRoot, '')
  assert.equal(run.options.codex.exe, '/test/codex')
  data.settings.permission = 'workspace-write'
  assert.throws(() => main.startRun({prompt:'edit'}), /工作目录/)
  data.settings.cwd = '/work'
  assert.equal(main.startRun({prompt:'edit'}).options.cwd, '/work')
  data.settings.backend = 'dsh'
  assert.equal(main.startRun({prompt:'legacy',sessionId:'legacy-dsh-id'}).options.sessionId, 'legacy-dsh-id')
  assert.equal(main.startRun({prompt:'switch',sessionId:'codex:thread'}).options.sessionId, null)
  assert.equal(main.startRun({prompt:'passive',tools:'none',permission:'danger-full-access'}).options.permission, 'read-only')
  data.settings.backend = 'codex'
  data.settings.permission = 'read-only'
  const info = { manual:true, hwnd:'screen:1:0', title:'Test screen', process:'test', own:false, shell:false, bounds:{x:0,y:0,width:800,height:600} }
  const result = await main.glance('user', {info, manualImage, keepImage:true})
  assert.equal(savedImage, manualImage)
  assert.equal(result.image, '/synthetic-shot.jpg')
  assert.equal(runs.at(-1).options.images[0], '/synthetic-shot.jpg')
  assert.doesNotMatch(runs.at(-1).options.prompt, /read_image/)
  const snap = main.snapshot()
  assert.equal(snap.backendName, 'Codex')
  assert.equal(snap.backendFound, true)
  assert.equal(snap.screenCapabilities, capabilities)
  assert.equal(await main.refreshScreenCapabilities(), capabilities)
  const responses = []
  const approvalRun = { done:false, respondApproval:(...args)=>responses.push(args) }
  await main.requestAgentApproval(approvalRun, {id:1,canAccept:true,command:'echo test',permissions:{network:{enabled:true}}})
  assert.deepEqual(responses, [[1,'decline']])
  assert.match(dialogs.at(-1).detail, /network/)
  assert.ok(dialogs.at(-1).signal, 'approval dialogs close by themselves (timeout / run end)')
  assert.doesNotMatch(dialogs.at(-1).message, /echo test/) // agent text is detail, never the heading
  await main.requestAgentApproval(approvalRun, {id:2,canAccept:false})
  assert.deepEqual(responses.at(-1), [2,'decline'])
  const answers = []
  await main.requestAgentInput({done:false,respondUserInput:(id,value)=>answers.push({id,value})}, {id:3,questions:[{id:'q',question:'Choose',options:[{label:'A',description:'First'}]}]})
  assert.equal(answers[0].id,3)
  assert.deepEqual(Object.keys(answers[0].value),[])
  assert.equal(desktopMode('linux',{WAYLAND_DISPLAY:'wayland-0',DISPLAY:':1'}).xwayland,true)
  assert.equal(desktopMode('linux',{WAYLAND_DISPLAY:'wayland-0'}).floating,false)
  assert.equal(desktopMode('linux',{DISPLAY:':0'}).floating,true)
  assert.equal(desktopMode('darwin',{}).floating,true)
  main.createPetWindow()
  let closePrevented=false
  lastWindow.emit('close',{preventDefault(){closePrevented=true}})
  assert.equal(closePrevented,true)
  assert.equal(lastWindow.visible,false)
  main.togglePet()
  assert.equal(lastWindow.visible,true)
  const notices=[]
  assert.equal(await pranks.runRandom({canPositionWindows:false,say:async text=>notices.push(text)},'chase'),null)
  assert.match(notices[0],/系统管理窗口位置/)
  const startupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ojousama-startup-test-'))
  try {
    const app = { isPackaged: true, getPath: () => startupDir }
    const options = { platform:'linux', env:{APPIMAGE:'/test/App With Spaces.AppImage'}, executable:'/tmp/.mount/app' }
    const startup = path.join(startupDir,'autostart','com.claude-ojousama.app.desktop')
    setAutoStart(app,true,'/source',options)
    assert.match(fs.readFileSync(startup,'utf8'), /Exec="\/test\/App With Spaces.AppImage"/)
    setAutoStart(app,false,'/source',options)
    assert.equal(fs.existsSync(startup),false)
    fs.writeFileSync(startup,'user-owned entry')
    assert.throws(()=>setAutoStart(app,true,'/source',options), /没有覆盖/)
    assert.equal(fs.readFileSync(startup,'utf8'),'user-owned entry')
    const login=[]
    setAutoStart({isPackaged:false,setLoginItemSettings:settings=>login.push(settings)},true,'/source',{platform:'darwin',executable:'/Electron'})
    assert.deepEqual(login,[{openAtLogin:true,path:'/Electron',args:['/source']}])
  } finally { fs.rmSync(startupDir,{recursive:true,force:true}) }
  console.log('PASS main backend, manual-image, capability, approval and desktop-mode integration')
})().catch(error => { console.error(error); process.exitCode=1 })
