import test from 'node:test'
import assert from 'node:assert/strict'
import { spritePlayback, habitPayload, moodLabel } from './behavior.mjs'

const scene = { animation: 'stretch', until: 5000, autonomous: true }
const play = value => spritePlayback({ now: 1000, ...value })

test('physical motion and active routes cannot be overwritten by an idle or manual scene', () => {
  for (const [phase, name] of [['dragging','dangle'],['flying','dangle'],['walking','walk'],['climbing','climb'],['hoisting','ledge'],['descending','dangle']]) {
    assert.equal(play({ motion: { phase }, scene: { ...scene, autonomous: false } }).name, name)
  }
  assert.equal(play({ task: { status: 'working' }, scene }).name, 'typing')
  assert.equal(play({ task: { status: 'approval' }, scene }).name, 'wave')
})

test('explicit gestures and task progress animate during a panel or user movement pause', () => {
  for (const pauseReason of ['panel','hover','user','task']) {
    const motion = { phase: 'walking', paused: true, pauseReason }
    assert.deepEqual(play({ motion, scene: { ...scene, autonomous: false } }), { name: 'stretch', intent: 5000, paused: false })
    assert.deepEqual(play({ motion, scene }), { name: 'walk', intent: 0, paused: true })
    assert.equal(play({ motion, task: { status: 'working' }, scene }).paused, false)
    assert.equal(play({ motion, task: { status: 'working' }, scene }).name, 'typing')
  }
})

test('lock, fullscreen and missing display always freeze manual gestures too', () => {
  for (const pauseReason of ['locked','fullscreen','display','starting']) {
    assert.equal(play({ motion: { phase: 'settled', paused: true, pauseReason }, scene: { ...scene, autonomous: false } }).paused, true)
  }
})

test('away nap can breathe; waking scenes expire without leaving a permanent pose', () => {
  assert.deepEqual(play({ motion: { phase: 'settled', paused: true, pauseReason: 'away' }, scene: { ...scene, animation: 'nap' } }), { name: 'nap', intent: 5000, paused: false })
  assert.equal(play({ scene: { ...scene, until: 999 } }).name, 'idle')
  assert.equal(play({ motion: { phase: 'perched' }, scene: { ...scene, until: 999 } }).name, 'sit')
})

test('one-shot intent restarts the same gesture without restarting gait on unrelated speech', () => {
  assert.notEqual(play({ scene }).intent, play({ scene: { ...scene, until: 6000 } }).intent)
  assert.equal(play({ motion: { phase: 'walking' }, scene }).intent, 0)
  assert.equal(play({ motion: { phase: 'walking' }, scene: { ...scene, until: 6000 } }).intent, 0)
  assert.equal(play({ notice: { source: 'alert', token: 7 }, scene }).name, 'wave')
})

test('habit controls reuse legacy setting names and keep a disabled water interval', () => {
  assert.deepEqual(habitPayload({ idleActions: true, proactive: false, focusGuard: true, autonomy: 'quiet', mischief: '1', waterMinutes: '0' }), { idleActions: true, proactive: false, focusGuard: true, autonomy: 'quiet', mischief: 1, waterMinutes: 0 })
  assert.equal(moodLabel(3), '很开心')
  assert.equal(moodLabel(-3), '有点闷闷的')
  assert.equal(moodLabel(0), '自在陪着你')
})
