const labels = { reflect:'整理记忆', brief:'今日简报', pulse:'工作区巡检', tip:'每日小技巧', summary:'今日小结', plan:'今日计划' }
export function backgroundLabel(kind) { return labels[kind] || '后台任务' }
export function backgroundText(task) {
  if (task.kind!=='reflect') return task.text
  const body=task.text.includes('```json') ? task.text.split('```json')[1].split('```')[0] : task.text
  let result
  try { result=JSON.parse(body) } catch { return task.text }
  return [...(Array.isArray(result?.notes)?result.notes.filter(n=>typeof n==='string'):[]),typeof result?.diary==='string'?result.diary:''].filter(Boolean).join('\n') || '成长记录已更新'
}
export function agendaPayload(settings, { enabled, morningBrief, workspacePulse, agendaPerDay, summaryTime }) {
  if (!Number.isInteger(agendaPerDay) || agendaPerDay < 0 || agendaPerDay > 30) throw new Error('每天最多尝试 0–30 次')
  if (summaryTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(summaryTime)) throw new Error('请选择有效的小结时间')
  return { rules:{...settings.rules,agenda:enabled?'auto':'off'}, morningBrief, workspacePulse, agendaPerDay, summaryTime }
}
export function agendaStatus(data, state) {
  const settings=data.settings
  const budget=state ? state.limit>0 ? `今日已尝试 ${state.used} / ${state.limit} 次` : `今日已尝试 ${state.used} 次` : ''
  const mode=state?.running ? `正在准备${backgroundLabel(state.running)}` : state?.preparing ? '正在准备后台任务…' : settings.agendaPerDay===0 ? '后台任务已关闭' : state?.limit>0&&state.used>=state.limit ? '今日后台任务次数已用完' : settings.rules?.agenda!=='off' ? '自动安排已开启' : settings.summaryTime ? '仅开启定时小结' : '未开启自动安排'
  return [mode,budget].filter(Boolean).join(' · ')
}
