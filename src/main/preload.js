'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')

const SEND = [
  'pet:ready',
  'pet:rects',
  'pet:drag-start',
  'pet:drag-end',
  'pet:click',
  'pet:context-menu',
  'pet:input-state',
  'pet:send',
  'pet:button',
  'pet:bubble-click',
  'pet:bubble-closed',
  'pet:drop',
  'note:resize',
  'note:close',
  'note:pin',
]
const INVOKE = [
  'pet:init',
  'panel:state',
  'chat:send',
  'chat:new',
  'chat:cancel',
  'todo:add',
  'todo:update',
  'todo:remove',
  'todo:clear-done',
  'reminder:add',
  'reminder:remove',
  'task:start',
  'task:cancel',
  'task:remove',
  'settings:set',
  'plan:today',
  'pomodoro:start',
  'pomodoro:stop',
  'open:web',
  'open:path',
  'pick:dir',
  'pick:exe',
  'prank',
  'note:init',
  'note:toggle',
  'note:add',
  'note:post',
  'tidy:now',
  'goal:add',
  'goal:update',
  'goal:remove',
  'goal:run',
  'goal:answer',
  'memory:add',
  'memory:remove',
  'activity:clear',
  'look:now',
  'screen:pause',
  'climb:now',
]
const ON = ['pet:cmd', 'state', 'panel:tab', 'note:state']

contextBridge.exposeInMainWorld('pet', {
  send(channel, data) {
    if (SEND.includes(channel)) ipcRenderer.send(channel, data)
  },
  invoke(channel, data) {
    if (!INVOKE.includes(channel)) return Promise.reject(new Error('blocked channel ' + channel))
    return ipcRenderer.invoke(channel, data)
  },
  on(channel, fn) {
    if (!ON.includes(channel)) return () => {}
    const handler = (_e, data) => fn(data)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
})
