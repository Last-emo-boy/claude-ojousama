import { isActive, pendingKey, presentation } from './model.mjs'

// Task streams are noisy. Only a new state (not every token) earns a notification.
export function createBubbleState() {
  const seen = new Map()
  let taskNotice = null
  let speech = null
  let error = null
  let alert = null
  let alertToken = 0
  const clearAlert = id => {
    if (String(id) !== String(alert?.alertId)) return
    alert = speech = null
    if (!taskNotice?.needsAction) taskNotice = null
  }
  const read = (now = Date.now()) => {
    const notices = [error, taskNotice?.needsAction ? taskNotice : null, alert, speech, taskNotice]
    return notices.find(notice => notice && notice.until > now) || null
  }
  return {
    task(task, { snapshot = false, now = Date.now() } = {}) {
      if (!task) { taskNotice = null; return }
      const key = `${task.status}:${pendingKey(task)}`
      const changed = seen.get(task.id) !== key
      seen.set(task.id, key)
      if (seen.size > 20) seen.delete(seen.keys().next().value)
      const needsAction = task.status === 'approval' || task.status === 'input'
      if (taskNotice && (taskNotice.taskId !== task.id || !needsAction)) {
        if (taskNotice.needsAction || taskNotice.taskId !== task.id) taskNotice = null
      }
      if (!changed || (snapshot && !needsAction)) return
      const info = presentation(task)
      if (info.label === '待命') return
      taskNotice = { source: 'task', taskId: task.id, label: info.label, text: info.text,
        active: isActive(task), needsAction, until: needsAction ? Infinity : now + 8000 }
    },
    speak(value, now = Date.now()) {
      const text = String(value?.text || '').trim()
      if (text) speech = { source: 'speech', label: '大小姐', text, until: Math.min(Number(value.until) || now + 12000, now + 30000) }
    },
    alert(value, now = Date.now()) {
      if (value?.clear !== undefined) {
        if (value.token === undefined || value.token === alert?.token) clearAlert(value.clear)
        return
      }
      if (!value || !Number.isFinite(value.token) || value.token <= alertToken || value.until <= now) return
      alertToken = value.token
      alert = { source: 'alert', alertId: value.id, token: value.token, label: value.label || '提醒', text: String(value.text || ''), buttons: value.buttons || [], until: Math.min(value.until, now + 30000) }
    },
    clearAlert,
    error(text, now = Date.now()) {
      error = text ? { source: 'error', label: '出了点问题', text: String(text), until: now + 12000 } : null
    },
    dismiss() { error = speech = taskNotice = alert = null },
    read,
  }
}
