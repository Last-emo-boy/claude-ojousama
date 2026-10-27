const ACTIVE = new Set(['starting', 'thinking', 'working', 'approval', 'input'])

const STATUS = {
  starting: ['正在连接', 'thinking', '连接 Codex…'],
  thinking: ['思考中', 'thinking', '正在想办法'],
  working: ['进行中', 'typing', '正在处理任务'],
  approval: ['需要确认', 'wave', '有一步需要你确认'],
  input: ['等你回答', 'wave', '有个问题想问你'],
  completed: ['已完成', 'happy', '做好啦，来看看'],
  cancelled: ['已停止', 'idle', '已经停下来了'],
  failed: ['未完成', 'error', '遇到一点问题'],
}

export const isActive = task => !!task && ACTIVE.has(task.status)

export function orderedTasks(tasks) {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
}

export function upsertTask(tasks, task, { snapshot = false } = {}) {
  // Invoke replies are snapshots; an event already received for this id is newer.
  if (snapshot && tasks.some(item => item.id === task.id)) return tasks
  return orderedTasks([...tasks.filter(item => item.id !== task.id), task]).slice(0, 20)
}

export function currentTask(tasks) {
  const sorted = orderedTasks(tasks)
  return sorted.find(isActive) || sorted[0] || null
}

export function selectedTask(tasks, id) {
  return tasks.find(task => task.id === id) || currentTask(tasks)
}

export function presentation(task, motion = 'settled') {
  const [label, animation, fallback] = STATUS[task?.status] || ['待命', 'idle', '有事叫我']
  return {
    label,
    animation: ({dragging:'dangle',flying:'dangle',descending:'dangle',walking:'walk',climbing:'climb',hoisting:'ledge',perched:'sit'})[motion] || animation,
    text: task?.status === 'failed' ? task.error || fallback : task?.activity || fallback,
    active: isActive(task),
  }
}

export function mirrorBands(bands, width) {
  return bands.map(band => ({ ...band, x: width - band.x - band.width }))
}

export function settingsFrom(value = {}) {
  return {
    workspace: String(value.workspace || ''),
    codexPath: String(value.codexPath || ''),
    model: String(value.model || ''),
    permission: ['read-only','workspace-write','danger-full-access'].includes(value.permission) ? value.permission : 'read-only',
  }
}

export function pendingKey(task) {
  return task?.pending ? `${task.id}:${JSON.stringify(task.pending.id)}` : ''
}

export function alphaBands(rgba, stride, frame, frameWidth, frameHeight, bandHeight = 6) {
  const bands = []
  for (let y = 0; y < frameHeight; y += bandHeight) {
    let left = frameWidth
    let right = -1
    const bottom = Math.min(frameHeight, y + bandHeight)
    for (let row = y; row < bottom; row++) {
      for (let x = 0; x < frameWidth; x++) {
        if (rgba[(row * stride + frame * frameWidth + x) * 4 + 3] > 8) {
          left = Math.min(left, x)
          right = Math.max(right, x)
        }
      }
    }
    if (right >= left) bands.push({ x: left, y, width: right - left + 1, height: bottom - y })
  }
  return bands
}

export function placeBands(bands, origin, scale) {
  return bands.map(band => ({
    x: Math.floor(origin.x + band.x * scale),
    y: Math.floor(origin.y + band.y * scale),
    width: Math.ceil(band.width * scale) + 1,
    height: Math.ceil(band.height * scale) + 1,
  }))
}
