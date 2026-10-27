export function watchPayload({ enabled, folders, mode }) {
  const paths = [...new Set(String(folders || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))]
  return { enabled: !!enabled, folders: paths.length ? paths : null, mode }
}
export function fileGroups(ready = []) {
  const groups = new Map()
  for (const file of ready) {
    if (typeof file.folder !== 'string' || typeof file.name !== 'string') continue
    if (!groups.has(file.folder)) groups.set(file.folder, [])
    groups.get(file.folder).push(file)
  }
  return [...groups].map(([folder, files]) => ({ folder, files }))
}
export function watchStatus(data, runtime = {}) {
  if (!data.watch?.native?.enabled || data.watch.native.consentVersion !== 1) return '文件发现未开启'
  if (data.watch.native.autoError) return data.watch.native.autoError
  if (runtime.error) return runtime.error
  if (runtime.pauseReason === 'session-unavailable') return '当前桌面尚未提供会话状态，文件发现已暂停'
  if (runtime.pauseReason === 'starting') return '等待桌面状态，稍后开始发现新文件'
  if (runtime.pauseReason === 'locked') return '桌面解锁后继续发现新文件'
  if (runtime.scanning) return '正在查看文件夹…'
  if (data.settings.rules?.tidy === 'off') return '已开启 · 不再提议整理'
  if (data.settings.rules?.tidy === 'auto' && !data.watch.native.autoRoots) return '自动整理需重新确认，请保存文件夹设置'
  return data.settings.rules?.tidy === 'auto' ? '已开启 · 新文件稳定后自动分类，可撤销上次整理' : '已开启 · 新文件稳定后再提议，确认前不移动'
}
