import test from 'node:test'
import assert from 'node:assert/strict'
import { isActive, orderedTasks, upsertTask, currentTask, selectedTask, presentation, settingsFrom, pendingKey, alphaBands, placeBands } from './model.mjs'
import { createDragQueue } from './drag.mjs'

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
