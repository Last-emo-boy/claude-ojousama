import { isActive, presentation } from './model.mjs'

// Movement owns the body; a task owns attention. Explicit gestures can still play
// while autonomous movement is paused by the panel, pointer or user.
export function spritePlayback({ task, motion = {}, scene, notice, now = Date.now() }) {
  const active = isActive(task)
  const physical = ['dragging', 'flying'].includes(motion.phase)
  const route = ['walking', 'climbing', 'hoisting', 'descending'].includes(motion.phase)
  const live = scene?.until > now
  const manual = live && scene.autonomous !== true
  const hardPause = motion.paused && ['locked', 'fullscreen', 'display', 'starting'].includes(motion.pauseReason)
  let name, intent = 0, animated = false
  if (physical || (route && !motion.paused)) name = presentation(task, motion.phase).animation
  else if (active) { name = presentation(task).animation; animated = true }
  else if (notice?.source === 'alert') { name = 'wave'; intent = notice.token; animated = true }
  else if (notice?.source === 'clipboard') { name = 'point'; intent = notice.token; animated = true }
  else if (live && (!motion.paused || manual || (scene.animation === 'nap' && motion.pauseReason === 'away'))) {
    name = scene.animation || 'idle'; intent = scene.until; animated = manual || name === 'nap'
  } else if (route) name = presentation(task, motion.phase).animation
  else if (motion.phase === 'perched') name = 'sit'
  else name = notice?.source === 'task' ? presentation(task).animation : 'idle'
  return { name, intent, paused: !!(hardPause || (motion.paused && !animated)) }
}

export const moodLabel = value => Number(value) >= 2 ? '很开心' : Number(value) <= -2 ? '有点闷闷的' : '自在陪着你'

export function habitPayload(values) {
  return {
    idleActions: !!values.idleActions,
    proactive: !!values.proactive,
    focusGuard: !!values.focusGuard,
    autonomy: values.autonomy,
    mischief: Number(values.mischief),
    waterMinutes: Number(values.waterMinutes),
  }
}
