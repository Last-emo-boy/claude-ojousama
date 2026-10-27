import test from 'node:test'
import assert from 'node:assert/strict'
import { createBubbleState } from './bubble.mjs'

const task = (status, pending = null) => ({ id: 1, status, pending, activity: '处理任务' })

test('idle and historical completed tasks never open a bubble on launch', () => {
  const state = createBubbleState()
  assert.equal(state.read(0), null)
  state.task(task('completed'), { snapshot: true, now: 0 })
  assert.equal(state.read(0), null)
})

test('task status briefly appears once; streamed tokens cannot renew its lifetime', () => {
  const state = createBubbleState()
  state.task(task('working'), { now: 0 })
  assert.equal(state.read(1).label, '进行中')
  state.task({ ...task('working'), output: 'more tokens' }, { now: 7900 })
  assert.equal(state.read(8000), null)
  state.task(task('completed'), { now: 9000 })
  assert.equal(state.read(9001).label, '已完成')
  assert.equal(state.read(17000), null)
})

test('pending decisions stay until resolved and cannot leak into a resumed task', () => {
  const state = createBubbleState()
  state.task(task('approval', { id: 'a' }), { snapshot: true, now: 0 })
  state.speak({ text: '我去转转', until: 12000 }, 0)
  assert.equal(state.read(10000).needsAction, true)
  state.task(task('working'), { now: 11000 })
  assert.equal(state.read(11001).source, 'speech')
  assert.equal(state.read(19000), null)
})

test('dismissal is remembered for the current question, not the next one', () => {
  const state = createBubbleState()
  state.task(task('input', { id: 1 }), { now: 0 })
  state.dismiss(1)
  state.task(task('input', { id: 1 }), { now: 2 })
  assert.equal(state.read(3), null)
  state.task(task('input', { id: 2 }), { now: 4 })
  assert.equal(state.read(5).needsAction, true)
})

test('speech expires, errors are bounded and animation-only actions stay silent', () => {
  const state = createBubbleState()
  state.speak({ text: '读完啦', until: 1000 }, 0)
  assert.equal(state.read(999).text, '读完啦')
  assert.equal(state.read(1000), null)
  state.speak({ text: '', animation: 'stretch', until: 10000 }, 1000)
  assert.equal(state.read(1001), null)
  state.error('真实错误', 2000)
  assert.equal(state.read(2001).source, 'error')
  assert.equal(state.read(14000), null)
})

test('closing the visible bubble does not reveal an older notice underneath it', () => {
  const state = createBubbleState()
  state.task(task('completed'), { now: 0 })
  state.speak({ text: '说句话', until: 12000 }, 100)
  state.error('真实错误', 200)
  state.dismiss()
  assert.equal(state.read(201), null)
})
