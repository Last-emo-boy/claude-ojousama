export function observationPayload({ enabled, accessibility, consented, intervalSeconds, maxPerHour, excludeApps }) {
  return { enabled, accessibility, consentVersion: consented ? (accessibility ? 2 : 1) : 0, intervalSeconds, maxPerHour, quiet: true, excludeApps }
}
export function observationStatus(config, observer, now = Date.now()) {
  if (observer.running) return '正在理解窗口内容'
  if (config.pausedUntil > now) return `暂停至 ${new Date(config.pausedUntil).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit' })}`
  if (observer.error) return observer.error
  if (!config.enabled) return '未开启主动观察'
  const caps = observer.capabilities
  const ready = caps ? caps.ready : observer.permission
  if (!ready) return caps?.screenSupported === false ? '当前桌面需系统主动共享，后台观察不可用' : '请授权屏幕访问，或开启并授权辅助功能读字'
  return ({
    starting: '正在恢复桌面状态…',
    locked: '解锁后继续主动观察',
    paused: '主动观察已暂停',
    quiet: '安静时段结束后继续主动观察',
    focus: '专注结束后继续主动观察',
    desktop: '显示桌宠并收起面板后继续主动观察',
    task: '任务结束后继续主动观察',
  })[observer.pauseReason] || '已开启 · 安静运行'
}
export function observationPermissions(caps) {
  if (!caps) return ''
  const image = caps.screenSupported ? `画面${caps.screenPermission ? '已授权' : '未授权'}` : '画面需系统共享'
  return caps.accessibilitySupported ? `${image} · 读字${caps.accessibilityPermission ? '已授权' : '未授权'}` : image
}
