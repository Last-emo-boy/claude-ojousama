import test from 'node:test'
import assert from 'node:assert/strict'
import { isActive, orderedTasks, upsertTask, currentTask, selectedTask, presentation, settingsFrom, pendingKey, alphaBands, placeBands, mirrorBands } from './model.mjs'
import { createDragQueue } from './drag.mjs'
import { watchPayload, fileGroups, watchStatus } from './files.mjs'

test('folder watch uses explicit commands and preserves null default-folder and mode meaning', () => {
  assert.deepEqual(watchPayload({enabled:false,folders:' ',mode:'ask'}),{enabled:false,folders:null,mode:'ask'})
  assert.deepEqual(watchPayload({enabled:true,folders:'/fixture/a\r\n /fixture/b \n/fixture/a',mode:'auto'}),{enabled:true,folders:['/fixture/a','/fixture/b'],mode:'auto'})
  assert.deepEqual(fileGroups([{folder:'/a',name:'one.txt'},{folder:'/b',name:'two.txt'},{folder:'/a',name:'three.txt'}]).map(g=>[g.folder,g.files.length]),[['/a',2],['/b',1]])
})
test('watch status distinguishes disabled imports, read errors, auto consent and paused recovery', () => {
  const d={settings:{rules:{tidy:'auto'}},watch:{native:{enabled:false,consentVersion:0}}}
  assert.equal(watchStatus(d),'文件发现未开启')
  d.watch.native={enabled:true,consentVersion:1,autoRoots:null}
  assert.match(watchStatus(d),/重新确认/)
  d.watch.native.autoRoots=['/fixture'];assert.match(watchStatus(d),/自动分类/)
  assert.equal(watchStatus(d,{error:'read failed'}),'read failed')
  assert.match(watchStatus(d,{pauseReason:'session-unavailable'}),/已暂停/)
  d.watch.native.autoError='自动整理已暂停';assert.equal(watchStatus(d),d.watch.native.autoError)
  d.watch.native.autoError='';d.settings.rules.tidy='ask';assert.match(watchStatus(d),/确认前不移动/)
})

const task = (id, status = 'completed', createdAt = id) => ({ id, status, createdAt, activity: '', error: null })

test('all in-flight states keep the stop action available', () => {
  for (const status of ['starting', 'thinking', 'working', 'approval', 'input']) assert.equal(isActive(task(1, status)), true)
  for (const status of ['completed', 'cancelled', 'failed', 'unknown']) assert.equal(isActive(task(1, status)), false)
  assert.equal(isActive(null), false)
})

test('task updates replace by id, preserve newest order, and bound history', () => {
  const history = Array.from({ length: 22 }, (_, id) => task(id))
  const updated = upsertTask(history, { ...task(21), output: 'new output' })
  assert.equal(updated.length, 20)
  assert.equal(updated[0].id, 21)
  assert.equal(updated[0].output, 'new output')
  assert.equal(updated.filter(item => item.id === 21).length, 1)
  assert.deepEqual(orderedTasks([task(1, 'completed', 1), task(2, 'completed', 1)]).map(item => item.id), [2, 1])
})

test('completed event before start result keeps the final output', async () => {
  let tasks = []
  let resolveStart
  const result = new Promise(resolve => { resolveStart = resolve })
  const accepting = result.then(snapshot => {
    tasks = upsertTask(tasks, snapshot, { snapshot: true })
    return selectedTask(tasks, snapshot.id)
  })
  tasks = upsertTask(tasks, { ...task(1), output: '完成后的真实结果' })
  resolveStart({ ...task(1, 'starting'), output: '' })
  const selected = await accepting
  assert.equal(selected.status, 'completed')
  assert.equal(selected.output, '完成后的真实结果')
  assert.equal(tasks.some(isActive), false)
})

test('failed event before retry result keeps the actual error', async () => {
  let tasks = [task(1)]
  let resolveRetry
  const result = new Promise(resolve => { resolveRetry = resolve })
  const accepting = result.then(snapshot => {
    tasks = upsertTask(tasks, snapshot, { snapshot: true })
    return selectedTask(tasks, snapshot.id)
  })
  tasks = upsertTask(tasks, { ...task(2, 'failed'), error: 'Codex 启动失败', output: '已收到的输出' })
  resolveRetry({ ...task(2, 'starting'), output: '' })
  const selected = await accepting
  assert.equal(selected.id, 2)
  assert.equal(selected.status, 'failed')
  assert.equal(selected.error, 'Codex 启动失败')
  assert.equal(selected.output, '已收到的输出')
})

test('bootstrap snapshots fill missing history without replacing received events', () => {
  let tasks = upsertTask([], { ...task(2, 'working'), output: '新事件' })
  for (const snapshot of [task(1), task(2, 'starting')]) {
    tasks = upsertTask(tasks, snapshot, { snapshot: true })
  }
  assert.equal(tasks.length, 2)
  assert.equal(tasks[0].status, 'working')
  assert.equal(tasks[0].output, '新事件')
  assert.equal(tasks[1].id, 1)
})

test('pet follows active task while task panel preserves explicit selection', () => {
  const history = [task(1, 'working'), task(2)]
  assert.equal(currentTask(history).id, 1)
  assert.equal(selectedTask(history, 2).id, 2)
  assert.equal(selectedTask(history, 99).id, 1)
  assert.equal(currentTask([]), null)
})

test('motion owns the drag pose without overwriting actual task state', () => {
  const result = presentation(task(2, 'working'), 'dragging')
  assert.equal(result.animation, 'dangle')
  assert.equal(result.label, '进行中')
  assert.equal(result.active, true)
  assert.equal(presentation(task(2, 'working'), 'settled').animation, 'typing')
  assert.equal(presentation(task(2, 'working'), 'perched').animation, 'sit')
  assert.equal(presentation(task(2, 'working'), 'perched').active, true)
})

test('failure exposes real error and unknown states never imply success', () => {
  assert.equal(presentation({ ...task(1, 'failed'), error: 'CLI not found' }).text, 'CLI not found')
  assert.equal(presentation(task(1, 'unknown')).label, '待命')
  assert.equal(presentation(null).animation, 'idle')
})

test('native movement selects the connected walking, climbing and pull-up poses', () => {
  for(const [phase,animation] of [['walking','walk'],['climbing','climb'],['hoisting','ledge'],['descending','dangle'],['perched','sit']]) {
    assert.equal(presentation(task(1,'working'),phase).animation,animation)
    assert.equal(presentation(task(1,'working'),phase).active,true)
  }
})

test('mirrored characters keep click-through bands aligned and do not mutate their source', () => {
  const bands=[{x:20,y:5,width:30,height:6}]
  assert.deepEqual(mirrorBands(bands,180),[{x:130,y:5,width:30,height:6}])
  assert.equal(bands[0].x,20)
  assert.deepEqual(mirrorBands(mirrorBands(bands,180),180),bands)
})

test('settings preserve legacy full access, supported policies and the read-only default', () => {
  assert.equal(settingsFrom({ permission: 'danger-full-access' }).permission, 'danger-full-access')
  assert.equal(settingsFrom({ permission: 'unknown' }).permission, 'read-only')
  assert.equal(settingsFrom({ permission: 'workspace-write' }).permission, 'workspace-write')
  assert.deepEqual(settingsFrom(), { workspace: '', codexPath: '', model: '', permission: 'read-only' })
})

test('question identity distinguishes numeric and string RPC ids', () => {
  assert.notEqual(pendingKey({ id: 1, pending: { id: 2 } }), pendingKey({ id: 1, pending: { id: '2' } }))
  assert.equal(pendingKey(task(1)), '')
})

test('alpha hit bands omit transparent rows and select the requested sprite frame', () => {
  const pixels = new Uint8ClampedArray(8 * 4 * 4)
  pixels[(1 * 8 + 5) * 4 + 3] = 255
  pixels[(2 * 8 + 6) * 4 + 3] = 255
  assert.deepEqual(alphaBands(pixels, 8, 0, 4, 4, 2), [])
  assert.deepEqual(alphaBands(pixels, 8, 1, 4, 4, 2), [
    { x: 1, y: 0, width: 1, height: 2 },
    { x: 2, y: 2, width: 1, height: 2 },
  ])
})

test('hit bands use logical CSS coordinates at fractional scales', () => {
  assert.deepEqual(placeBands([{ x: 2, y: 3, width: 4, height: 5 }], { x: 10, y: 20 }, 1.5), [
    { x: 13, y: 24, width: 7, height: 9 },
  ])
})

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('begin completes before moves; coalesces 10000 pending samples and flushes release point before end', async () => {
  const calls = [], errors = [], gate = deferred()
  const begin = createDragQueue((command, point) => {
    calls.push({ command, point })
    return command === 'drag_begin' ? gate.promise : Promise.resolve()
  }, error => errors.push(error))
  const drag = begin({ x: 1, y: 2 })
  await tick()
  for (let x = 0; x < 10000; x++) drag.move({ x, y: x })
  const finished = drag.end({ x: 10000, y: 10001 })
  assert.deepEqual(calls.map(call => call.command), ['drag_begin'])
  gate.resolve()
  await finished
  assert.deepEqual(calls, [
    { command: 'drag_begin', point: { x: 1, y: 2 } },
    { command: 'drag_move', point: { x: 10000, y: 10001 } },
    { command: 'drag_end', point: undefined },
  ])
  assert.equal(errors.length, 0)
})

test('one move in flight and one latest sample; end waits for both', async () => {
  const calls = [], gate = deferred()
  let moves = 0
  const begin = createDragQueue((command, point) => {
    calls.push([command, point])
    return command === 'drag_move' && ++moves === 1 ? gate.promise : Promise.resolve()
  }, assert.fail)
  const drag = begin({ x: 0, y: 0 })
  await tick()
  drag.move({ x: 1, y: 1 })
  await tick()
  drag.move({ x: 2, y: 2 })
  drag.move({ x: 3, y: 3 })
  const finished = drag.end({ x: 4, y: 4 })
  await tick()
  assert.deepEqual(calls.map(call => call[0]), ['drag_begin', 'drag_move'])
  gate.resolve()
  await finished
  assert.deepEqual(calls.map(call => call[0]), ['drag_begin', 'drag_move', 'drag_move', 'drag_end'])
  assert.deepEqual(calls[2][1], { x: 4, y: 4 })
})

test('the next gesture cannot start before the preceding end finishes', async () => {
  const calls = [], gate = deferred()
  let endings = 0
  const begin = createDragQueue((command, point) => {
    calls.push([command, point])
    return command === 'drag_end' && ++endings === 1 ? gate.promise : Promise.resolve()
  }, assert.fail)
  const first = begin({ x: 1, y: 1 })
  const ended = first.end()
  await tick()
  const second = begin({ x: 2, y: 2 })
  const secondEnded = second.end()
  await tick()
  assert.deepEqual(calls.map(call => call[0]), ['drag_begin', 'drag_end'])
  gate.resolve()
  await Promise.all([ended, secondEnded])
  assert.deepEqual(calls.map(call => call[0]), ['drag_begin', 'drag_end', 'drag_begin', 'drag_end'])
})

test('move errors still end native drag and surface the error', async () => {
  const calls = [], errors = []
  const error = new Error('movement failed')
  const begin = createDragQueue(command => {
    calls.push(command)
    return command === 'drag_move' ? Promise.reject(error) : Promise.resolve()
  }, value => errors.push(value))
  const drag = begin({ x: 0, y: 0 })
  await assert.rejects(drag.end({ x: 4, y: 5 }), /movement failed/)
  assert.deepEqual(calls, ['drag_begin', 'drag_move', 'drag_end'])
  assert.deepEqual(errors, [error])
})

test('pointer cancellation retains the last move sample and end is idempotent', async () => {
  const calls = [], gate = deferred()
  const begin = createDragQueue((command, point) => {
    calls.push([command, point])
    return command === 'drag_begin' ? gate.promise : Promise.resolve()
  }, assert.fail)
  const drag = begin({ x: 0, y: 0 })
  drag.move({ x: 15, y: 20 })
  const finished = drag.end()
  assert.equal(drag.end({ x: 0, y: 0 }), finished)
  drag.move({ x: 100, y: 100 })
  gate.resolve()
  await finished
  assert.deepEqual(calls[1], ['drag_move', { x: 15, y: 20 }])
  assert.equal(calls.filter(call => call[0] === 'drag_end').length, 1)
})


test('visible text needs renewed consent while image-only consent stays compatible', async () => {
  const { observationPayload } = await import('./observation.mjs')
  const image = observationPayload({ enabled: true, accessibility: false, consented: true })
  assert.equal(image.consentVersion, 1)
  const text = observationPayload({ enabled: true, accessibility: true, consented: true })
  assert.equal(text.consentVersion, 2)
  assert.equal(text.accessibility, true)
  assert.equal(observationPayload({ enabled: true, accessibility: true, consented: false }).consentVersion, 0)
})
test('text-ready observer is usable without screen recording and disabled state stays clear', async () => {
  const { observationStatus, observationPermissions } = await import('./observation.mjs')
  const observer = { permission: false, capabilities: { ready: true, screenSupported: true, screenPermission: false, accessibilitySupported: true, accessibilityPermission: true } }
  assert.equal(observationStatus({ enabled: true }, observer), '已开启 · 安静运行')
  assert.equal(observationPermissions(observer.capabilities), '画面未授权 · 读字已授权')
  assert.equal(observationStatus({ enabled: false }, observer), '未开启主动观察')
  assert.equal(observationStatus({ enabled: true }, { capabilities: { ready: false, screenSupported: false } }), '当前桌面需系统主动共享，后台观察不可用')
})
test('automatic observation explains suspension without masking explicit manual work', async () => {
  const { observationStatus } = await import('./observation.mjs')
  const ready = { capabilities: { ready: true } }
  const expected = {
    starting: '正在恢复桌面状态…', locked: '解锁后继续主动观察',
    paused: '主动观察已暂停', quiet: '安静时段结束后继续主动观察',
    focus: '专注结束后继续主动观察', desktop: '显示桌宠并收起面板后继续主动观察',
    task: '任务结束后继续主动观察',
  }
  for (const [pauseReason, label] of Object.entries(expected)) {
    const observer = { ...ready, pauseReason }
    assert.equal(observationStatus({ enabled: true }, observer), label)
    assert.equal(observationStatus({ enabled: false }, observer), '未开启主动观察')
    assert.equal(observationStatus({ enabled: false, pausedUntil: 2000 }, { ...observer, running: true }, 1000), '正在理解窗口内容')
  }
  assert.equal(observationStatus({ enabled: true }, { ...ready, pauseReason: 'future' }), '已开启 · 安静运行')
  assert.match(observationStatus({ enabled: true, pausedUntil: 2000 }, { ...ready, pauseReason: 'desktop' }, 1000), /^暂停至 /)
  assert.equal(observationStatus({ enabled: true }, { ...ready, error: '读取失败', pauseReason: 'desktop' }), '读取失败')
  assert.equal(observationStatus({ enabled: true }, { capabilities: { ready: false, screenSupported: false }, pauseReason: 'desktop' }), '当前桌面需系统主动共享，后台观察不可用')
})
test('agenda controls preserve other rules and zero/empty values really disable automation', async () => {
  const { agendaPayload, agendaStatus, backgroundText } = await import('./agenda.mjs')
  const settings={ rules:{agenda:'auto',goals:'ask',open:'off',custom:'keep'},agendaPerDay:6,summaryTime:'18:30' }
  const patch=agendaPayload(settings,{enabled:false,morningBrief:false,workspacePulse:false,agendaPerDay:0,summaryTime:''})
  assert.deepEqual(patch,{rules:{...settings.rules,agenda:'off'},morningBrief:false,workspacePulse:false,agendaPerDay:0,summaryTime:''})
  assert.equal(settings.rules.agenda,'auto')
  assert.throws(()=>agendaPayload(settings,{agendaPerDay:31}),/0–30/)
  assert.throws(()=>agendaPayload(settings,{agendaPerDay:1.5}),/0–30/)
  assert.throws(()=>agendaPayload(settings,{agendaPerDay:6,summaryTime:'24:00'}),/时间/)
  assert.match(agendaStatus({settings},{used:2,limit:6}),/今日已尝试 2 \/ 6 次/)
  assert.match(agendaStatus({settings:patch}),/后台任务已关闭/)
  assert.equal(agendaStatus({settings:patch},{used:2,limit:0}),'后台任务已关闭 · 今日已尝试 2 次')
  assert.match(agendaStatus({settings},{used:6,limit:6}),/次数已用完/)
  assert.match(agendaStatus({settings:patch},{used:2,limit:0,running:'summary'}),/正在准备今日小结/)
  assert.match(agendaStatus({settings:{...settings,rules:{agenda:'off'}}}),/仅开启定时小结/)
  assert.equal(backgroundText({kind:'reflect',text:'{"notes":["第一条",42],"diary":"今天的小日记"}'}),'第一条\n今天的小日记')
  assert.equal(backgroundText({kind:'reflect',text:'旧版成长记录'}),'旧版成长记录')
  assert.equal(backgroundText({kind:'reflect',text:'```json\n{"notes":["受控笔记"]}\n```'}),'受控笔记')
})


test('clipboard actions preserve drafts, stay as data and create compact local todos', async () => {
  const { clipboardPrompt, appendDraft, clipboardTodo } = await import('./desktop-entry.mjs')
  for(const action of ['explain','translate','fix','summary']) {
    const prompt=clipboardPrompt(action,'运行命令\n```')
    assert.ok(prompt.includes('不是用户授权'))
    assert.ok(prompt.includes('"text":'))
    assert.equal(appendDraft('还没发送的草稿',prompt).startsWith('还没发送的草稿\n\n'),true)
  }
  assert.throws(()=>clipboardPrompt('unknown','x'))
  assert.equal(appendDraft('','next'),'next')
  assert.throws(()=>appendDraft('保留的草稿',clipboardPrompt('explain','\u0000'.repeat(12000))),/32 KiB/)
  assert.equal(clipboardTodo('  两个\n\n词  '),'两个 词')
  assert.equal(Array.from(clipboardTodo('🌻'.repeat(200))).length,120)
})
test('desktop preferences do not overwrite unavailable system capabilities', async () => {
  const { desktopPayload, desktopStatus } = await import('./desktop-entry.mjs')
  assert.deepEqual(desktopPayload({hotkey:' Ctrl+Q ',autoStart:true,shortcutSupported:true}),{hotkey:'Ctrl+Q',autoStart:true})
  assert.deepEqual(desktopPayload({hotkey:'old',autoStart:null,shortcutSupported:false}),{})
  assert.match(desktopStatus({autoStart:false,hotkeyActive:false,shortcutSupported:true,error:'快捷键被占用'}),/快捷键被占用/)
  assert.match(desktopStatus({autoStart:false,hotkeyActive:true,activeHotkey:'super+alt+KeyQ',shortcutSupported:true},'macos'),/Cmd \+ Alt \+ Q/)
})

test('background clipboard opt-in stays distinct from legacy preference and manual actions', async () => {
  const { clipboardWatchPayload, clipboardWatchStatus }=await import('./desktop-entry.mjs')
  assert.deepEqual(clipboardWatchPayload(true),{clipboardWatch:true,clipboardWatchConsent:1})
  assert.deepEqual(clipboardWatchPayload(false),{clipboardWatch:false,clipboardWatchConsent:0})
  assert.equal(clipboardWatchStatus({clipboardWatch:true},{supported:true}),'未开启后台检测')
  assert.equal(clipboardWatchStatus({clipboardWatch:true,clipboardWatchConsent:1},{supported:true}),'已开启 · 仅在本机识别')
  assert.match(clipboardWatchStatus({clipboardWatch:true,clipboardWatchConsent:1},{supported:false}),/可使用剪贴板操作/)
})
