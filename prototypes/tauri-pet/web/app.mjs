import { isActive, orderedTasks, upsertTask, currentTask, selectedTask, presentation, settingsFrom, pendingKey, alphaBands, placeBands, mirrorBands } from './model.mjs'
import { createDragQueue } from './drag.mjs'
import { mountCompanion } from './companion.mjs'
import { createBubbleState } from './bubble.mjs'
import { clipboardPrompt, appendDraft, clipboardTodo } from './desktop-entry.mjs'
import { spritePlayback } from './behavior.mjs'
import { CANVAS_SIZE, SPRITE_SCALE, frameGeometry, createSheetCache } from './sprites.mjs'
import { readFields, restoreFields } from './panel-state.mjs'

const app = document.querySelector('#app')
const view = new URLSearchParams(location.search).get('view') === 'panel' ? 'panel' : 'pet'
document.body.className = view

const state = {
  tasks: [],
  selected: null,
  settings: settingsFrom(),
  motion: { phase: 'settled' },
  positionable: true,
  platform: '',
  error: '',
  questionKey: '',
  submitting: false,
  historyKey: '',
}
let companionPanel
let companionBubble = null
let petCompanion = null
let composing = false
let petTools = false
let expandedText = ''
let pendingPetKey = ''
let companionPendingKey = ''
let seenSetupToken = null
let petInteractionActive = null
let dismissedPetPendingKey = ''
const bubbles = createBubbleState()
let alertControlsKey = ''
let shownAlertToken = null
let bubbleTimer
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const invoke = (command, args) => window.__TAURI__.core.invoke(command, args)
const $ = id => document.getElementById(id)
const errorText = error => error instanceof Error ? error.message : String(error)
const short = (text, limit = 80) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit)
const timeLabel = value => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value))
const platformLabel = { darwin: 'macOS', macos: 'macOS', win32: 'Windows', windows: 'Windows', linux: 'Linux' }

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function showError(error) {
  state.error = errorText(error)
  const output = $(view === 'pet' ? 'pet-error' : 'panel-error')
  if (output) output.textContent = state.error
  if (view === 'pet') sendHitRegions()
  if (view === 'pet') { bubbles.error(state.error); renderPet() }
}

async function action(button, work) {
  button.disabled = true
  try {
    await work()
  } catch (error) {
    showError(error)
  } finally {
    if (button.isConnected) button.disabled = false
  }
}

function renderStatus(node, task) {
  node.textContent = presentation(task).label
  node.dataset.state = task?.status || 'idle'
}

function acceptTask(task, { select = false, snapshot = false } = {}) {
  const isNew = !state.tasks.some(item => item.id === task.id)
  state.tasks = upsertTask(state.tasks, task, { snapshot })
  if (view === 'pet') bubbles.task(currentTask(state.tasks), { snapshot })
  if (select || isNew || state.selected === null) state.selected = task.id
  render()
  companionPanel?.taskUpdated(state.tasks)
}

function render() {
  if (view === 'pet') renderPet()
  else renderPanel()
}

let animationTimer
let activeAnimation = ''
let activeIntent = 0
let animationFrame = 0
let spriteBands = []
let lastRegions = ''
let definitions = {}
const sheets = createSheetCache(readSheet)

function mountPet() {
  app.innerHTML = `
    <section id="pet-bubble" class="pet-bubble" aria-label="桌宠消息" aria-live="polite" aria-atomic="true" hidden>
      <div class="pet-bubble-heading"><span id="pet-status" class="status"></span><button id="pet-dismiss" type="button" aria-label="收起气泡">×</button></div>
      <p id="pet-message" class="pet-message"></p>
      <p id="pet-error" class="pet-error" role="alert"></p>
      <div id="pet-pending" class="pending-card hidden"></div>
      <form id="pet-compose" class="pet-compose" hidden><label for="pet-input" class="visually-hidden">和大小姐说话</label><textarea id="pet-input" rows="2" maxlength="20000" required placeholder="说点什么…" spellcheck="false"></textarea><div class="compose-footer"><button id="pet-tools-toggle" type="button" class="subtle" aria-label="更多桌宠操作">＋</button><button id="pet-send" class="primary" type="submit">发送</button></div></form>
      <div id="pet-tools" class="pet-tools" hidden><div class="quick-actions"><button id="pet-clipboard" type="button">剪贴板</button><button id="pet-look" type="button">选择观察窗口</button><button id="pet-note" type="button">贴便签</button><button id="pet-focus" type="button">专注 25 分钟</button><button id="pet-new-chat" type="button">新对话</button><button type="button" data-pet-template="待办：">记待办</button><button type="button" data-pet-template="目标：">设目标</button><button type="button" data-pet-template="提醒我10分钟后">设提醒</button><button type="button" data-pet-template="记住：">记住偏好</button></div><div id="pet-look-controls" hidden><label>观察窗口<select id="pet-look-window" aria-label="观察窗口"></select></label><button id="pet-look-now" type="button">看这个窗口</button></div><label>准备点什么<select id="pet-background"><option value="agenda:brief">今日简报</option><option value="agenda:pulse">工作区巡检</option><option value="agenda:tip">小技巧</option><option value="summary:now">今日小结</option><option value="growth:reflect">整理记忆</option></select></label><button id="pet-prepare" type="button">交给我</button><label>小动作<select id="pet-animation"><option value="wave">挥手</option><option value="stretch">伸懒腰</option><option value="dance">跳舞</option><option value="read">读书</option><option value="magic">魔术</option></select></label><button id="pet-play" type="button">做这个动作</button></div>
      <section id="pet-clipboard-preview" hidden><textarea id="pet-clipboard-text" maxlength="24000" aria-label="剪贴板预览"></textarea><p class="setting-help">仅本机预览，带入草稿后可修改。</p><div class="quick-actions"><button type="button" data-clipboard="explain">解释</button><button type="button" data-clipboard="translate">翻译</button><button type="button" data-clipboard="fix">修 Bug</button><button type="button" data-clipboard="summary">总结</button><button type="button" data-clipboard="todo">记成待办</button><button id="pet-clipboard-clear" type="button">清除</button></div></section>
      <div class="pet-actions">
        <div id="pet-alert-actions" class="pet-alert-actions" hidden></div>
        <button id="pet-stop" class="danger hidden" type="button">停止</button><button id="pet-retry" class="hidden" type="button">再试一次</button>
        <button id="pet-open" type="button">聊两句</button>
      </div>
    </section>
    <div id="pet-menu" class="pet-menu" role="menu" aria-label="桌宠操作" hidden><button id="pet-menu-chat" type="button" role="menuitem">聊两句</button><button id="pet-menu-touch" type="button" role="menuitem">摸摸头</button><button id="pet-perch" type="button" role="menuitem">爬上窗口</button><button id="pet-menu-walk" type="button" role="menuitem">去走走</button><button id="pet-menu-stop" type="button" role="menuitem">停步／下来</button><button id="pet-menu-actions" type="button" role="menuitem">更多操作</button><button id="pet-menu-records" type="button" role="menuitem">记录</button><button id="pet-menu-settings" type="button" role="menuitem">设置</button><button id="pet-menu-quiet" type="button" role="menuitem">安静一小时</button></div>
    <div id="sprite" role="button" tabindex="0" aria-haspopup="menu" aria-expanded="false" aria-label="桌宠，点击聊天，右键更多操作，拖动后松手抛出"><div id="sprite-art"><div id="sprite-frame"></div></div><span id="sprite-sign" hidden></span></div>`
  const canvas = $('sprite')
  $('pet-open').addEventListener('click',()=>{
    const notice=bubbles.read(),task=currentTask(state.tasks)
    const output=notice?.source==='task' ? task?.output : notice?.text
    if(output && output.length>105){expandedText=output;renderPet()}
    else openPetComposer().catch(showError)
  })
  $('pet-dismiss').addEventListener('click',()=>{dismissedPetPendingKey=petDecisionKey();bubbles.dismiss();composing=petTools=false;expandedText='';clearClipboard();invoke('pet_interaction',{active:false,focus:false}).catch(showError);renderPet()})
  $('pet-compose').addEventListener('submit',async event=>{
    event.preventDefault()
    if(state.submitting)return
    const text=$('pet-input').value.trim();if(!text)return
    state.submitting=true;$('pet-send').disabled=true
    try{
      await invoke('companion_command',{command:'chat:send',args:{text}})
      $('pet-input').value='';composing=petTools=false;expandedText='';clearClipboard();state.error='';bubbles.error('')
      await invoke('pet_interaction',{active:false,focus:false})
    }catch(error){showError(error)}finally{state.submitting=false;$('pet-send').disabled=false;renderPet()}
  })
  $('pet-input').addEventListener('keydown',event=>{
    if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('pet-compose').requestSubmit()}
  })
  for(const b of document.querySelectorAll('[data-pet-template]'))b.addEventListener('click',()=>{$('pet-input').value=b.dataset.petTemplate;petTools=false;renderPet();$('pet-input').focus()})
  $('pet-tools-toggle').addEventListener('click',()=>{petTools=!petTools;renderPet()})
  for(const [id,work] of [
    ['pet-clipboard',()=>previewPetClipboard()],['pet-look',async()=>{const windows=await invoke('observer_windows');if(!windows.length)throw new Error('没有可观察的窗口，私密窗口已跳过');$('pet-look-window').replaceChildren(...windows.map(w=>{const option=element('option','',`${w.name} · ${w.title}`);option.value=w.id;return option}));$('pet-look-controls').hidden=false;renderPet()}],['pet-look-now',async()=>{const chosen=Number($('pet-look-window').value);if(!chosen)throw new Error('请先选择窗口');await invoke('look_now',{chosen});$('pet-dismiss').click()}],
    ['pet-note',()=>invoke('note_toggle')],['pet-focus',()=>invoke('companion_command',{command:'pomodoro:start',args:{minutes:25}})],
    ['pet-new-chat',()=>invoke('companion_command',{command:'chat:new',args:{}})],
    ['pet-prepare',async()=>{await invoke('companion_command',{command:$('pet-background').value,args:{}});$('pet-dismiss').click()}],
    ['pet-play',()=>invoke('companion_command',{command:'prank',args:{name:$('pet-animation').value}})],
  ])$(id).addEventListener('click',event=>action(event.currentTarget,work))
  $('pet-clipboard-clear').addEventListener('click',()=>{clearClipboard();renderPet()})
  for(const button of document.querySelectorAll('[data-clipboard]'))button.addEventListener('click',event=>action(event.currentTarget,async()=>{
    const value=$('pet-clipboard-text').value.trim();if(!value)throw new Error('请先复制或粘贴文字')
    if(button.dataset.clipboard==='todo')await invoke('companion_command',{command:'todo:add',args:{text:clipboardTodo(value)}})
    else $('pet-input').value=appendDraft($('pet-input').value,clipboardPrompt(button.dataset.clipboard,value))
    clearClipboard();renderPet();$('pet-input').focus()
  }))
  $('pet-bubble').addEventListener('pointerdown',()=>invoke('pet_interaction',{active:composing||petTools||!!$('pet-pending').textContent,focus:true}).catch(showError))
  const menu = visible => { $('pet-menu').hidden = !visible; canvas.setAttribute('aria-expanded', String(visible)); renderPet() }
  $('pet-menu-chat').addEventListener('click', () => { menu(false); openPetComposer().catch(showError) })
  $('pet-menu-touch').addEventListener('click', event => action(event.currentTarget, async () => { await invoke('companion_command', { command: 'pet:touch', args: {} }); menu(false) }))
  $('pet-menu-actions').addEventListener('click',()=>{menu(false);openPetComposer(true).catch(showError)})
  for(const tab of ['settings','records'])$(`pet-menu-${tab}`).addEventListener('click',()=>{menu(false);invoke('show_panel',{tab}).catch(showError)})
  $('pet-menu-quiet').addEventListener('click', event => action(event.currentTarget, async () => { await invoke('companion_command', { command: 'companion:pause', args: { minutes: petCompanion?.data.settings.companionPausedUntil>Date.now()?0:60 } }); menu(false) }))
  for(const [id,command]of [['pet-menu-walk','walk'],['pet-menu-stop','stop']])$(id).addEventListener('click',event=>action(event.currentTarget,async()=>{await invoke('motion_command',{command});menu(false)}))
  $('pet-perch').addEventListener('click', event => action(event.currentTarget, async () => {
    await invoke('perch_toggle')
    menu(false)
    state.error = ''
    renderPet()
  }))
  $('pet-retry').addEventListener('click',event=>action(event.currentTarget,async()=>{const task=currentTask(state.tasks);if(task)acceptTask(await invoke('task_retry',{id:task.id}),{select:true})}))
  $('pet-stop').addEventListener('click', event => {
    const task = currentTask(state.tasks)
    if (isActive(task)) action(event.currentTarget, () => invoke('task_cancel', { id: task.id }))
  })
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openPetComposer().catch(showError)
    }
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); menu(true); $('pet-menu-chat').focus() }
  })
  canvas.addEventListener('contextmenu', event => {
    event.preventDefault()
    menu($('pet-menu').hidden)
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { menu(false);$('pet-dismiss').click();canvas.focus() }
    if (!$('pet-menu').hidden && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      const items = [...$('pet-menu').querySelectorAll('button:not(.hidden)')]
      const index = items.indexOf(document.activeElement)
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus()
    }
  })
  const beginDrag = createDragQueue(invoke, showError)
  let press = null
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
    menu(false)
    const point = { x: event.screenX, y: event.screenY }
    press = { ...point, at: performance.now(), distance: 0, drag: state.positionable ? beginDrag(point) : null }
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointermove', event => {
    if (!press) return
    press.distance = Math.max(press.distance, Math.hypot(event.screenX - press.x, event.screenY - press.y))
    press.drag?.move({ x: event.screenX, y: event.screenY })
  })
  const release = async event => {
    if (!press) return
    const ending = press
    const point = event.type === 'pointerup' ? { x: event.screenX, y: event.screenY } : null
    if (point) ending.distance = Math.max(ending.distance, Math.hypot(point.x - ending.x, point.y - ending.y))
    const click = event.type === 'pointerup' && press.distance < 6 && performance.now() - press.at < 500
    press = null
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
    try {
      if (ending.drag) await ending.drag.end(point)
      if (click) await openPetComposer()
    } catch (error) {
      showError(error)
    }
  }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  const resize = new ResizeObserver(() => sendHitRegions())
  resize.observe($('pet-bubble')); resize.observe($('pet-menu'))
  window.addEventListener('resize', () => {
    drawSprite()
    sendHitRegions()
  })
  document.addEventListener('visibilitychange', () => {
    clearTimeout(animationTimer)
    shownAlertToken = null
    if (!document.hidden) { drawSprite(); renderPet() }
  })
}

async function openPetComposer(tools=false) {
  composing=true;petTools=tools;expandedText='';dismissedPetPendingKey='';$('pet-menu').hidden=true
  await invoke('pet_interaction',{active:true,focus:true})
  renderPet();$('pet-input').focus()
}
function clearClipboard(){if(!$('pet-clipboard-preview'))return;$('pet-clipboard-preview').hidden=true;$('pet-clipboard-text').value=''}
async function previewPetClipboard(offer=false){
  await openPetComposer()
  const value=await invoke(offer?'clipboard_offer_preview':'clipboard_preview')
  if(offer&&value.action&&value.action!=='preview'){
    $('pet-input').value=appendDraft($('pet-input').value,clipboardPrompt(value.action,value.text))
  }else{$('pet-clipboard-text').value=value.text;$('pet-clipboard-preview').hidden=false}
  renderPet()
}

async function loadSprites() {
  const response = await fetch('./assets/sprites/manifest.json')
  if (!response.ok) throw new Error('角色资源未准备好，请重新构建原型')
  const manifest = await response.json()
  definitions = manifest.anims
  await loadSheet('idle')
}
const loadSheet = name => sheets.load(name)
async function readSheet(name) {
    const definition = definitions[name]
    if (!definition) throw new Error(`缺少角色动作：${name}`)
    const image = new Image()
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = () => reject(new Error(`无法加载角色动作：${name}`))
      image.src = `./assets/sprites/${definition.file}`
    })
    const offscreen = document.createElement('canvas')
    offscreen.width = image.width
    offscreen.height = image.height
    try {
      const context = offscreen.getContext('2d', { willReadFrequently: true })
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, image.width, image.height).data
      const bands = Array.from({ length: definition.frames }, (_, frame) => alphaBands(pixels, image.width, frame, definition.w, definition.h))
      return { image, bands, ...definition }
    } finally {
      offscreen.width = offscreen.height = 0
    }
}

function drawSprite() {
  clearTimeout(animationTimer)
  if (document.hidden || !$('sprite-frame')) return
  const playback = petPlayback()
  const name = playback.name
  const sheet = sheets.get(name)
  if (!sheet) { loadSheet(name).then(drawSprite).catch(showError); return }
  if (activeAnimation !== name || activeIntent !== playback.intent) {
    activeAnimation = name
    activeIntent = playback.intent
    animationFrame = 0
  }
  const { frame, scale, width, height, x, y } = frameGeometry(sheet, animationFrame, reduceMotion.matches)
  const mirrored=state.motion.facing<0
  $('sprite-art').style.transform=mirrored?'scaleX(-1)':''
  Object.assign($('sprite-frame').style,{left:`${x}px`,top:`${y}px`,width:`${width}px`,height:`${height}px`,
    backgroundImage:`url("${sheet.image.src}")`,backgroundSize:`${width*sheet.frames}px ${height}px`,backgroundPosition:`${-frame*width}px 0px`})
  const sign=$('sprite-sign')
  sign.hidden=!(name==='sign' && sheet.boards && companionBubble?.text)
  if(name==='sign' && sheet.boards && companionBubble?.text){
    const b=sheet.boards[frame]||sheet.boards[0], text=companionBubble.text.slice(0,6)
    const centre=x+(b.x+b.w/2)*SPRITE_SCALE
    const textWidth=(b.w-4)*SPRITE_SCALE
    sign.textContent=text
    Object.assign(sign.style,{left:`${(mirrored?CANVAS_SIZE-centre:centre)-textWidth/2}px`,top:`${y+(b.y+b.h/2)*SPRITE_SCALE}px`,width:`${textWidth}px`,fontSize:'13px'})
    let size=13;while(size>6&&sign.scrollWidth>sign.clientWidth){size-=.5;sign.style.fontSize=`${size}px`}
  }
  const bounds = $('sprite').getBoundingClientRect()
  const bands=placeBands(sheet.bands[frame],{x,y},scale)
  spriteBands = (mirrored?mirrorBands(bands,CANVAS_SIZE):bands).map(b=>({...b,x:b.x+bounds.x,y:b.y+bounds.y}))
  sendHitRegions()
  if (!reduceMotion.matches && !playback.paused && (sheet.loop !== false || animationFrame < sheet.frames - 1)) {
    animationFrame++
    animationTimer = setTimeout(drawSprite, 1000 / sheet.fps)
  }
}

function petPlayback() {
  return spritePlayback({ task: currentTask(state.tasks), motion: state.motion, scene: companionBubble, notice: bubbles.read() })
}

function sendHitRegions() {
  if (view !== 'pet' || !window.__TAURI__) return
  const regions = [...spriteBands]
  for (const popup of [$('pet-bubble'), $('pet-menu')]) if (popup && !popup.hidden) {
    const bounds = popup.getBoundingClientRect()
    regions.push({ x: Math.floor(bounds.x), y: Math.floor(bounds.y), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height) + 8 })
  }
  const encoded = JSON.stringify(regions)
  if (encoded === lastRegions) return
  lastRegions = encoded
  invoke('set_hit_regions', { regions }).catch(error => {
    // Keep the actual error visible without recursively submitting the same regions.
    state.error = errorText(error)
    $('pet-error').textContent = state.error
  })
}

function petDecisionKey(){const d=petCompanion?.data;return JSON.stringify([pendingKey(currentTask(state.tasks)),d?.chat.question,d?.pendingActions?.[0]?.id,d?.goals?.filter(g=>g.question).map(g=>[g.id,g.question])])}
function renderPetPending(task){
  const box=$('pet-pending')
  if(task?.pending){box.classList.remove('hidden');companionPendingKey='';if(pendingKey(task)!==pendingPetKey){pendingPetKey=pendingKey(task);renderPending(task,box,'petQuestionKey')}return}
  pendingPetKey='';state.petQuestionKey=''
  const d=petCompanion?.data, item=d?.pendingActions?.[0], goal=d?.goals?.find(g=>g.question), question=d?.chat.question||goal?.question
  const key=JSON.stringify([item?.id,question,goal?.id])
  box.classList.toggle('hidden',!item&&!question)
  if(companionPendingKey===key)return
  companionPendingKey=key;box.replaceChildren()
  const add=(label,command,args)=>{const b=element('button','',label);b.type='button';b.addEventListener('click',event=>action(event.currentTarget,()=>invoke('companion_command',{command,args})));box.append(b)}
  if(item){const a=item.action;box.append(element('p','',a.action==='file.move'?`移动 ${a.from} → ${a.to}`:a.action==='open'?`打开 ${a.target}`:a.text));add('允许这次','action:accept',{id:item.id});add('不要','action:reject',{id:item.id})}
  else if(question){box.append(element('p','',question.question));for(const answer of question.options||[])add(answer,goal?'goal:answer':'chat:answer',goal?{id:goal.id,answer}:{answer})}
}

function renderAlertActions(notice, visible) {
  const box=$('pet-alert-actions')
  box.hidden=!notice?.buttons?.length
  if(box.hidden)return
  const key=`${notice.source}:${notice.token}`
  if(alertControlsKey!==key) {
    alertControlsKey=key
    box.replaceChildren(...notice.buttons.map((choice,index)=>{
      const button=element('button',choice.id==='done'||choice.id==='ok'||(notice.source==='clipboard'&&index===0)?'primary':'',choice.label)
      button.type='button'
      button.addEventListener('click',event=>action(event.currentTarget,async()=>{
        if(notice.source==='clipboard') {
          await invoke('clipboard_offer_open',{token:notice.token,action:choice.id});bubbles.clipboard({clear:notice.token})
        } else if(notice.source==='speech') {
          const result=await invoke('companion_command',{command:'notice:respond',args:{token:notice.token,choice:choice.id}})
          bubbles.dismiss();if(result?.configure)await invoke('show_panel',{tab:'settings'})
        } else {
          await invoke('companion_command',{command:'alert:respond',args:{id:notice.alertId,choice:choice.id}});bubbles.clearAlert(notice.alertId)
        }
        renderPet()
      }))
      return button
    }))
  }
  if(notice.source==='alert' && visible && !document.hidden && shownAlertToken!==notice.token) {
    shownAlertToken=notice.token
    invoke('alert_shown',{token:notice.token}).then(shown=>{if(!shown && shownAlertToken===notice.token)shownAlertToken=null}).catch(error=>{if(shownAlertToken===notice.token)shownAlertToken=null;showError(error)})
  }
}

function renderPet() {
  clearTimeout(bubbleTimer)
  const task = currentTask(state.tasks)
  const info = presentation(task, state.motion.phase)
  const notice = bubbles.read()
  const pending=petDecisionKey()!==dismissedPetPendingKey && (!!task?.pending||!!petCompanion?.data.chat.question||!!petCompanion?.data.pendingActions?.length||!!petCompanion?.data.goals?.some(g=>g.question))
  const interactive=composing||petTools||pending||!!expandedText||!!notice?.expanded
  $('pet-bubble').hidden = !(notice||composing||petTools||pending||expandedText) || !$('pet-menu').hidden
  $('pet-bubble').classList.toggle('interactive',interactive)
  $('pet-compose').hidden=!composing
  $('pet-tools').hidden=!petTools
  renderPetPending(task)
  if(!pending)$('pet-pending').classList.add('hidden')
  const interaction=interactive||!$('pet-menu').hidden
  if(petInteractionActive!==interaction){petInteractionActive=interaction;invoke('pet_interaction',{active:interaction,focus:false}).catch(showError)}
  $('pet-menu-quiet').textContent=petCompanion?.data.settings.companionPausedUntil>Date.now()?'继续陪伴':'安静一小时'
  renderStatus($('pet-status'), task)
  const companionSpeaking = notice?.source === 'speech' && !info.active
  $('pet-message').textContent = expandedText || (notice?.source === 'error' ? '' : notice?.expanded ? notice.text : short(notice?.text, 105))
  $('pet-message').classList.toggle('expanded',!!expandedText||!!notice?.expanded)
  $('pet-message').hidden=pending
  $('pet-bubble').classList.toggle('companion-speaking', !!companionSpeaking)
  if(composing&&!notice)$('pet-status').textContent='大小姐'
  if(notice){$('pet-status').textContent=notice.label;$('pet-status').dataset.state=notice.source==='error'?'failed':notice.source==='task'?task?.status||'idle':'idle'}
  $('pet-error').textContent = notice?.source === 'error' ? notice.text : ''
  $('pet-bubble').classList.toggle('has-error', notice?.source === 'error')
  $('pet-stop').classList.toggle('hidden', !isActive(task)||pending)
  $('pet-retry').classList.toggle('hidden',!['failed','cancelled'].includes(task?.status)||pending||composing)
  $('pet-open').textContent = (notice?.source==='task'?task?.output:notice?.text)?.length>105?'展开':'聊两句'
  $('pet-open').hidden=composing||pending||!!expandedText||!!notice?.expanded||!!notice?.buttons?.length
  if(notice?.kind==='setup'&&!document.hidden&&!$('pet-bubble').hidden&&seenSetupToken!==notice.token){seenSetupToken=notice.token;invoke('companion_command',{command:'notice:shown',args:{token:notice.token}}).catch(showError)}
  renderAlertActions(notice,!$('pet-bubble').hidden)
  $('pet-perch').textContent = state.motion.phase === 'perched' ? '下来' : '爬上窗口'
  $('pet-perch').classList.toggle('hidden', !state.positionable)
  $('pet-menu-walk').classList.toggle('hidden',!state.positionable)
  $('pet-menu-stop').classList.toggle('hidden',!state.positionable)
  $('sprite').classList.toggle('dragging', state.motion.phase === 'dragging')
  $('sprite').setAttribute('aria-label', state.positionable ? '桌宠，点击聊天，右键更多操作，拖动后松手抛出' : '桌宠，点击聊天，右键更多操作')
  const playback = petPlayback()
  if (activeAnimation !== playback.name || activeIntent !== playback.intent || reduceMotion.matches) drawSprite()
  sendHitRegions()
  if (notice && Number.isFinite(notice.until)) bubbleTimer = setTimeout(renderPet, Math.max(1, notice.until - Date.now()))
}

function mountPanel() {
  app.innerHTML = `
    <header class="panel-header">
      <div class="brand"><span class="brand-mark" aria-hidden="true">✦</span><h1>Claude Ojousama</h1></div>
      <div class="header-actions"><button id="show-pet" class="subtle" type="button">回到桌宠</button></div>
    </header>
    <p id="panel-error" class="error" role="alert"></p>
    <section class="task-section" aria-label="任务">
      <div class="task-section-heading"><h2>任务</h2><span id="task-count"></span></div>
      <div id="empty-state" class="empty-state"><strong>还没有任务记录</strong><p>和桌宠说说想做什么，结果会留在这里。</p></div>
      <nav id="task-history" class="task-history" aria-label="任务历史"></nav>
      <article id="task-detail" class="task-detail hidden" tabindex="-1" aria-labelledby="detail-title">
        <div class="detail-top"><h3 id="detail-title"></h3><div class="detail-actions"><button id="detail-stop" class="danger" type="button">停止</button><button id="detail-retry" type="button">再试一次</button><button id="copy-output" type="button">复制结果</button></div></div>
        <p id="detail-meta" class="detail-meta"></p>
        <div id="detail-activity" role="status"></div>
        <div id="pending" class="pending-card hidden"></div>
        <p id="detail-error" class="error task-error" role="alert"></p>
        <pre id="detail-output" class="output" aria-label="任务结果"></pre>
      </article>
    </section>
    <footer class="panel-footnote"><span id="platform-note"></span><button id="quit-app" type="button">退出大小姐</button></footer>`
  $('show-pet').addEventListener('click',event=>action(event.currentTarget,async()=>{await invoke('open_pet');await closePanel()}))
  $('quit-app').addEventListener('click', event => action(event.currentTarget, () => invoke('quit_app')))
  $('detail-stop').addEventListener('click', event => action(event.currentTarget, async () => {
    const task = selectedTask(state.tasks, state.selected)
    if (task) await invoke('task_cancel', { id: task.id })
  }))
  $('detail-retry').addEventListener('click', event => action(event.currentTarget, async () => {
    const task = selectedTask(state.tasks, state.selected)
    if (task) acceptTask(await invoke('task_retry', { id: task.id }), { select: true, snapshot: true })
  }))
  $('copy-output').addEventListener('click', event => action(event.currentTarget, async () => {
    const task = selectedTask(state.tasks, state.selected)
    if (task?.output) {
      await navigator.clipboard.writeText(task.output)
      $('copy-output').textContent = '已复制'
    }
  }))

}

async function closePanel() {
  await invoke('hide_panel',{viewState:{companion:companionPanel?.snapshot(),selected:state.selected,scrollY:window.scrollY,focus:document.activeElement?.id,
    pending:{key:state.questionKey,fields:readFields($('pending'))},scrolls:Object.fromEntries(['task-history','detail-output'].map(id=>[id,$(id).scrollTop]))}})
}

function renderPanel() {
  const tasks = orderedTasks(state.tasks)
  const active = tasks.find(isActive)
  const selected = selectedTask(tasks, state.selected)
  state.selected = selected?.id ?? null
  $('task-count').textContent = tasks.length ? `${tasks.length} 条记录` : ''
  $('empty-state').classList.toggle('hidden', tasks.length > 0)
  const history = $('task-history')
  const historyKey = JSON.stringify([selected?.id, tasks.map(task => [task.id, task.status, task.prompt, task.createdAt])])
  if (state.historyKey !== historyKey) history.replaceChildren(...tasks.map(task => {
    const button = element('button', 'history-item')
    button.type = 'button'
    button.setAttribute('aria-current', String(task.id === selected?.id))
    button.append(element('span', 'history-text', short(task.prompt, 150)))
    const meta = element('span', 'history-meta')
    const status = element('span', 'status')
    renderStatus(status, task)
    meta.append(status, element('span', 'history-time', timeLabel(task.createdAt)))
    button.append(meta)
    button.addEventListener('click', () => {
      state.selected = task.id
      $('copy-output').textContent = '复制结果'
      renderPanel()
    })
    return button
  }))
  state.historyKey = historyKey
  $('task-detail').classList.toggle('hidden', !selected)
  if (!selected) return
  $('detail-title').textContent = selected.prompt
  $('detail-meta').textContent = `${timeLabel(selected.createdAt)} · ${({'read-only':'只读','workspace-write':'工作区可写','danger-full-access':'完全访问'})[selected.permission] || selected.permission} · ${selected.workspace}`
  $('detail-activity').textContent = `${presentation(selected).label}${selected.activity ? ` · ${selected.activity}` : ''}`
  $('detail-stop').classList.toggle('hidden', !isActive(selected))
  $('detail-retry').classList.toggle('hidden', isActive(selected))
  $('detail-retry').disabled = !!active
  $('copy-output').disabled = !selected.output
  $('detail-error').textContent = selected.error || ''
  const output = $('detail-output')
  const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 70
  const emptyOutput = { cancelled: '任务已停止，未产生结果', failed: '任务未完成，未产生结果', completed: '任务已完成，未返回文字结果' }[selected.status] || '结果会出现在这里'
  const outputText = selected.output || emptyOutput
  output.classList.toggle('muted', !selected.output)
  if (output.textContent !== outputText) {
    output.textContent = outputText
    if (nearBottom) output.scrollTop = output.scrollHeight
  }
  renderPending(selected)
}

function renderPending(task, pending=$('pending'), stateKey='questionKey') {
  const key = pendingKey(task)
  pending.classList.toggle('hidden', !key)
  if (key === state[stateKey]) return
  state[stateKey] = key
  pending.replaceChildren()
  if (!task?.pending) return
  if (task.pending.kind === 'approval') renderApproval(task, pending)
  else renderQuestions(task, pending)
}

function renderApproval(task, container) {
  const pending = task.pending
  const explanation=element('div','pending-explanation')
  explanation.append(element('h3', '', '允许这次操作吗？'))
  if (pending.message) explanation.append(element('p', '', pending.message))
  const command = typeof pending.command === 'string' ? pending.command : pending.command && JSON.stringify(pending.command, null, 2)
  const scope = [command, pending.permissions && JSON.stringify(pending.permissions, null, 2)].filter(Boolean).join('\n\n')
  if (scope) explanation.append(element('pre', '', scope))
  container.append(explanation)
  const buttons = element('div', 'pending-actions')
  const reject = element('button', '', '拒绝')
  const allow = element('button', 'primary', '允许一次')
  for (const [button, accept] of [[reject, false], [allow, true]]) {
    button.type = 'button'
    button.addEventListener('click', async () => {
      reject.disabled = allow.disabled = true
      try {
        await invoke('task_approval', { id: task.id, requestId: pending.id, accept })
      } catch (error) {
        showError(error)
        if (button.isConnected) reject.disabled = allow.disabled = false
      }
    })
    buttons.append(button)
  }
  container.append(buttons)
}

function renderQuestions(task, container) {
  const pending = task.pending
  container.append(element('h3', '', '有个问题想问你'))
  const form = element('form')
  const fields = []
  for (const question of pending.questions || []) {
    const fieldset = element('fieldset')
    fieldset.append(element('legend', '', question.question || question.header || '你的回答'))
    const options = Array.isArray(question.options) ? question.options : []
    const inputs = []
    if (options.length) {
      options.forEach((option, index) => {
        const label = element('label', 'answer-choice')
        const input = element('input')
        input.type = 'radio'
        input.name = `question-${fields.length}`
        input.value = option.label
        input.required = true
        input.id = `answer-${fields.length}-${index}`
        const text = element('span', '', option.label)
        if (option.description) text.append(element('small', '', option.description))
        label.append(input, text)
        inputs.push(input)
        fieldset.append(label)
      })
    } else {
      const input = element('textarea')
      input.id = `answer-${fields.length}`
      input.required = true
      input.maxLength = 12000
      input.setAttribute('aria-label', question.question || '你的回答')
      inputs.push(input)
      fieldset.append(input)
    }
    fields.push({ id: question.id, inputs, options: !!options.length })
    form.append(fieldset)
  }
  const buttons = element('div', 'pending-actions')
  const skip = element('button', '', '跳过')
  skip.type = 'button'
  const submit = element('button', 'primary', '提交回答')
  submit.type = 'submit'
  buttons.append(skip, submit)
  form.append(buttons)
  const respond = async answers => {
    skip.disabled = submit.disabled = true
    try {
      await invoke('task_answer', { id: task.id, requestId: pending.id, answers })
    } catch (error) {
      showError(error)
      if (form.isConnected) skip.disabled = submit.disabled = false
    }
  }
  skip.addEventListener('click', () => respond({}))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const answers = Object.fromEntries(fields.map(field => {
      const value = field.options ? field.inputs.find(input => input.checked)?.value : field.inputs[0].value.trim()
      return [field.id, { answers: value ? [value] : [] }]
    }))
    respond(answers)
  })
  container.append(form)
}

async function boot() {
  if (view === 'pet') mountPet()
  else mountPanel()
  if (!window.__TAURI__) throw new Error('请从 Claude Ojousama 应用打开这个界面')
  await window.__TAURI__.event.listen('task:update', event => acceptTask(event.payload))
  if(view==='panel') await window.__TAURI__.event.listen('task:select',event=>{
    state.selected=event.payload
    if(state.tasks.some(task=>task.id===event.payload))renderPanel()
  })
  if (view === 'pet') {
    await window.__TAURI__.event.listen('companion:alert',event=>{bubbles.alert(event.payload);renderPet()})
    await window.__TAURI__.event.listen('clipboard:offer',event=>{bubbles.clipboard(event.payload);renderPet()})
    await window.__TAURI__.event.listen('pet:error', event => showError(event.payload))
  await window.__TAURI__.event.listen('motion:update', event => {
      if((event.payload.generation||0)<(state.motion.generation||0))return
      state.motion = event.payload
      renderPet()
      drawSprite()
    })
    await loadSprites()
  }
  const initial = await invoke('bootstrap')
  if(view==='panel')state.selected=initial.panelState?.selected??null
  for (const task of initial.tasks || []) {
    state.tasks = upsertTask(state.tasks, task, { snapshot: true })
  }
  state.settings = settingsFrom(initial.settings)
  state.positionable = initial.positionable !== false
  state.platform = initial.platform
  state.motion = initial.motion || state.motion
  if (view === 'pet') {bubbles.task(currentTask(state.tasks), { snapshot: true });bubbles.alert(initial.companion?.alert);bubbles.clipboard(initial.companion?.clipboard?.offer)}
  if (view === 'panel' && initial.companion) {
    companionPanel = mountCompanion({invoke, initial: initial.companion, showError, platform:state.platform, onTasks: () => companionPanel.select('tasks')})
    await window.__TAURI__.event.listen('companion:update', event => companionPanel.update(event.payload))
    companionPanel.restore(initial.panelState?.companion)
    await window.__TAURI__.event.listen('panel:close',()=>closePanel().catch(showError))
    await window.__TAURI__.event.listen('panel:open', event => {
      if(event.payload.taskId!=null){state.selected=event.payload.taskId;renderPanel()}
      if(event.payload.tab)companionPanel.select(event.payload.tab,{focus:true})
      if(event.payload.tab==='tasks') {
        renderPanel()
        if(!$('task-detail').classList.contains('hidden')) {
          $('task-detail').scrollIntoView({block:'start'})
          $('task-detail').focus({preventScroll:true})
        }
      }
    })
    await window.__TAURI__.event.listen('motion:update',event=>companionPanel.motionUpdated(event.payload))
  } else if (view === 'pet') {
    petCompanion=initial.companion
    if(petCompanion?.notice)bubbles.speak(petCompanion.notice)
    await window.__TAURI__.event.listen('companion:update',event=>{petCompanion=event.payload;renderPet()})
    await window.__TAURI__.event.listen('pet:compose',()=>openPetComposer().catch(showError))
    const clipboardRequest=async()=>{if(await invoke('clipboard_pending'))await previewPetClipboard()}
    const clipboardOffer=async()=>{if(await invoke('clipboard_offer_pending'))await previewPetClipboard(true)}
    await window.__TAURI__.event.listen('clipboard:request',()=>clipboardRequest().catch(showError))
    await window.__TAURI__.event.listen('clipboard:offer-request',()=>clipboardOffer().catch(showError))
    await clipboardRequest();await clipboardOffer()
    await window.__TAURI__.event.listen('companion:action', event => {if(event.payload.kind==='note.show')invoke('note_show').catch(showError)})
    await window.__TAURI__.event.listen('companion:bubble', event => {
      companionBubble = event.payload
      bubbles.speak(companionBubble)
      renderPet()
      setTimeout(() => renderPet(), Math.max(0, companionBubble.until - Date.now()))
    })
  }
  if (view === 'panel') {
    $('platform-note').textContent = `${platformLabel[state.platform] || state.platform} · ${state.positionable ? '原生窗口' : '原地互动模式'}`
  } else {
    await invoke('set_reduced_motion', { enabled: reduceMotion.matches })
    reduceMotion.addEventListener('change', event => {
      invoke('set_reduced_motion', { enabled: event.matches }).catch(showError)
      drawSprite()
    })
  }
  render()
  if(view==='panel') {
    if(initial.panelState?.pending?.key===state.questionKey)restoreFields($('pending'),initial.panelState.pending.fields)
    for(const [id,top] of Object.entries(initial.panelState?.scrolls||{})){const node=$(id);if(node)node.scrollTop=top}
    const focus=$(initial.panelState?.focus)
    if(focus&&!focus.closest('[hidden]'))focus.focus({preventScroll:true})
    window.scrollTo(0,initial.panelState?.scrollY||0)
    await invoke('panel_ready')
  }
  if (view === 'pet') drawSprite()
}

boot().catch(showError)
