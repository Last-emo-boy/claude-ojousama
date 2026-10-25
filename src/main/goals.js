'use strict'
// Goals: things the pet keeps pushing forward between conversations.
const { fmtTime } = require('./persona')

const EVERY_MIN = { hourly: 60, '3h': 180 }
const EVERY_LABEL = { hourly: '每小时', '3h': '每 3 小时', daily: '每天' }

/** Next scheduled check-in after `from`. */
function nextCheck(goal, from = Date.now()) {
  if (goal.every === 'daily') {
    const m = String(goal.at || '09:00').match(/^(\d{1,2}):(\d{2})$/)
    const d = new Date(from)
    d.setHours(m ? Number(m[1]) : 9, m ? Number(m[2]) : 0, 0, 0)
    if (d.getTime() <= from + 60000) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  return from + (EVERY_MIN[goal.every] || 180) * 60000
}

function normalizeEvery(every) {
  return ['hourly', '3h', 'daily'].includes(every) ? every : 'daily'
}

function scheduleLabel(goal) {
  return goal.every === 'daily' ? `每天 ${goal.at || '09:00'}` : EVERY_LABEL[goal.every] || ''
}

function checkInPrompt(goal) {
  const recent = (goal.log || [])
    .slice(-4)
    .map((l) => `- ${fmtTime(l.ts)} ${l.text}`)
    .join('\n')
  return [
    '[目标跟进] 你在对话之外帮用户持续推进下面这个目标。这是一次定时跟进，用户此刻不一定在看屏幕。',
    `目标：${goal.title}`,
    goal.detail ? `说明 / 标准：${goal.detail}` : '',
    `最近进展：\n${recent || '（还没有，这是第一次跟进）'}`,
    goal.answer ? `用户对你上次问题「${goal.lastQuestion || ''}」的回答：${goal.answer}` : '',
    '要求：',
    '1. 在当前权限内实际推进一小步（查资料、读写工作目录里的文件、整理信息等），不要只写计划；删除、外发消息、花钱等危险操作只提建议，不要执行。',
    '2. 最后用 1~3 句话向用户汇报：这次做了什么、下一步打算做什么。',
    '3. 需要用户拍板时附加 {"action":"ask","question":"…","options":["…","…"]}；需要用户亲自做的事用 todo.add；目标已经完全达成时附加 {"action":"goal.done"}。',
  ]
    .filter(Boolean)
    .join('\n')
}

module.exports = { nextCheck, normalizeEvery, scheduleLabel, checkInPrompt, EVERY_LABEL }
