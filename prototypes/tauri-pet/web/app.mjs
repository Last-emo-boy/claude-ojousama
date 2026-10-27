import { isActive, orderedTasks, upsertTask, currentTask, selectedTask, presentation, settingsFrom, pendingKey, alphaBands, placeBands } from './model.mjs'
import { createDragQueue } from './drag.mjs'
import { mountCompanion } from './companion.mjs'

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
let animationFrame = 0
let spriteBands = []
let lastRegions = ''
let sheets = {}
let definitions = {}
let loading = new Map()
let spriteContext
const SPRITE_SCALE = 1.35
const CANVAS_SIZE = 180

function mountPet() {
  app.innerHTML = `
    <section id="pet-bubble" class="pet-bubble" aria-label="任务状态">
      <span id="pet-status" class="status"></span>
      <p id="pet-message" class="pet-message"></p>
      <p id="pet-error" class="pet-error" role="alert"></p>
      <div class="pet-actions">
        <button id="pet-stop" class="danger hidden" type="button">停止</button>
        <button id="pet-perch" type="button">坐上窗口</button>
        <button id="pet-open" type="button">新任务</button>
      </div>
    </section>
    <canvas id="sprite" role="button" tabindex="0" aria-label="桌宠，点击打开任务，拖动后松手抛出"></canvas>`
  const canvas = $('sprite')
  const ratio = devicePixelRatio || 1
  canvas.width = CANVAS_SIZE * ratio
  canvas.height = CANVAS_SIZE * ratio
  spriteContext = canvas.getContext('2d')
  spriteContext.setTransform(ratio, 0, 0, ratio, 0, 0)
  spriteContext.imageSmoothingEnabled = false
  $('pet-open').addEventListener('click', event => action(event.currentTarget, () => invoke('show_panel')))
  $('pet-perch').addEventListener('click', event => action(event.currentTarget, async () => {
    await invoke('perch_toggle')
    state.error = ''
    renderPet()
  }))
  $('pet-stop').addEventListener('click', event => {
    const task = currentTask(state.tasks)
    if (isActive(task)) action(event.currentTarget, () => invoke('task_cancel', { id: task.id }))
  })
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      invoke('show_panel').catch(showError)
    }
  })
  canvas.addEventListener('contextmenu', event => {
    event.preventDefault()
    invoke('show_panel').catch(showError)
  })
  const beginDrag = createDragQueue(invoke, showError)
  let press = null
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return
    event.preventDefault()
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
      if (click) await invoke('show_panel')
    } catch (error) {
      showError(error)
    }
  }
  canvas.addEventListener('pointerup', release)
  canvas.addEventListener('pointercancel', release)
  new ResizeObserver(() => sendHitRegions()).observe($('pet-bubble'))
  window.addEventListener('resize', sendHitRegions)
  document.addEventListener('visibilitychange', () => {
    clearTimeout(animationTimer)
    if (!document.hidden) drawSprite()
  })
}

async function loadSprites() {
  const response = await fetch('./assets/sprites/manifest.json')
  if (!response.ok) throw new Error('角色资源未准备好，请重新构建原型')
  const manifest = await response.json()
  definitions = manifest.anims
  await Promise.all(['idle', 'thinking', 'typing', 'dangle', 'happy', 'error', 'wave', 'sit'].map(loadSheet))
}
async function loadSheet(name) {
  if (sheets[name]) return
  if (loading.has(name)) return loading.get(name)
  const task = (async () => {
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
    const context = offscreen.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, image.width, image.height).data
    const bands = Array.from({ length: definition.frames }, (_, frame) => alphaBands(pixels, image.width, frame, definition.w, definition.h))
    sheets[name] = { image, bands, ...definition }
  })()
  loading.set(name, task)
  try { await task } finally { loading.delete(name) }
}

function drawSprite() {
  clearTimeout(animationTimer)
  if (document.hidden || !spriteContext) return
  const task = currentTask(state.tasks)
  const base = presentation(task, state.motion.phase)
  const name = !base.active && !['dragging','flying','perched'].includes(state.motion.phase) && companionBubble?.until > Date.now() ? companionBubble.animation : base.animation
  const sheet = sheets[name]
  if (!sheet) { loadSheet(name).then(drawSprite).catch(showError); return }
  if (activeAnimation !== name) {
    activeAnimation = name
    animationFrame = 0
  }
  const frame = reduceMotion.matches ? 0 : animationFrame % sheet.frames
  const x = (CANVAS_SIZE - sheet.w * SPRITE_SCALE) / 2
  const y = CANVAS_SIZE - sheet.h * SPRITE_SCALE
  spriteContext.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
  spriteContext.drawImage(sheet.image, frame * sheet.w, 0, sheet.w, sheet.h, x, y, sheet.w * SPRITE_SCALE, sheet.h * SPRITE_SCALE)
  if(name==='sign' && sheet.boards && companionBubble?.text){
    const b=sheet.boards[frame]||sheet.boards[0], text=companionBubble.text.slice(0,6)
    spriteContext.save();spriteContext.fillStyle='#64452e';spriteContext.textAlign='center';spriteContext.textBaseline='middle'
    let size=13;do{spriteContext.font=`600 ${size}px sans-serif`;size-=.5}while(size>6&&spriteContext.measureText(text).width>(b.w-4)*SPRITE_SCALE)
    spriteContext.fillText(text,x+(b.x+b.w/2)*SPRITE_SCALE,y+(b.y+b.h/2)*SPRITE_SCALE);spriteContext.restore()
  }
  const bounds = $('sprite').getBoundingClientRect()
  spriteBands = placeBands(sheet.bands[frame], { x: bounds.x + x, y: bounds.y + y }, SPRITE_SCALE)
  sendHitRegions()
  if (!reduceMotion.matches) {
    animationFrame++
    animationTimer = setTimeout(drawSprite, 1000 / sheet.fps)
  }
}

function sendHitRegions() {
  if (view !== 'pet' || !window.__TAURI__) return
  const bubble = $('pet-bubble')
  const regions = [...spriteBands]
  if (bubble && !bubble.hidden) {
    const bounds = bubble.getBoundingClientRect()
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

function renderPet() {
  const task = currentTask(state.tasks)
  const info = presentation(task, state.motion.phase)
  renderStatus($('pet-status'), task)
  $('pet-message').textContent = short(companionBubble?.until > Date.now() && !info.active ? companionBubble.text : info.text, 105)
  $('pet-error').textContent = state.error
  $('pet-bubble').classList.toggle('has-error', !!state.error)
  $('pet-stop').classList.toggle('hidden', !info.active)
  $('pet-open').textContent = task ? '展开' : '新任务'
  $('pet-perch').textContent = state.motion.phase === 'perched' ? '下来' : '坐上窗口'
  $('pet-perch').classList.toggle('hidden', !state.positionable)
  $('sprite').classList.toggle('dragging', state.motion.phase === 'dragging')
  $('sprite').setAttribute('aria-label', state.positionable ? '桌宠，点击打开任务，拖动后松手抛出' : '桌宠，点击打开任务')
  if (activeAnimation !== info.animation || reduceMotion.matches) drawSprite()
  sendHitRegions()
}

function mountPanel() {
  app.innerHTML = `
    <header class="panel-header">
      <div class="brand"><span class="brand-mark" aria-hidden="true">✦</span><h1>Claude Ojousama</h1></div>
      <div class="header-actions"><button id="show-pet" class="subtle" type="button">回到桌宠</button></div>
    </header>
    <p id="panel-error" class="error" role="alert"></p>
    <form id="task-form" class="new-task">
      <label class="section-label" for="prompt">这次做什么？</label>
      <textarea id="prompt" placeholder="看看这个项目，或者帮我完成一件事…" required maxlength="20000" spellcheck="false"></textarea>
      <div class="workspace-row">
        <input id="workspace" aria-label="工作目录" placeholder="选择工作目录" required spellcheck="false" autocapitalize="off">
        <button id="choose-workspace" type="button">选择</button>
      </div>
      <div class="compose-footer">
        <label class="permission-control" for="permission">权限<select id="permission"><option value="read-only">只读</option><option value="workspace-write">工作区可写</option><option value="danger-full-access">完全访问（谨慎）</option></select></label>
        <button id="start-task" class="primary" type="submit">开始任务 ↗</button>
      </div>
      <p id="form-error" class="error form-error" role="alert"></p>
      <details class="settings">
        <summary>连接设置</summary>
        <div class="settings-fields">
          <label for="codex-path">Codex 可执行文件<input id="codex-path" placeholder="自动查找" spellcheck="false" autocapitalize="off"></label>
          <label for="model">模型<input id="model" placeholder="沿用 Codex 设置" spellcheck="false" autocapitalize="off"></label>
        </div>
        <div class="settings-actions"><button id="save-settings" type="button">保存设置</button><span id="settings-state" class="settings-note" role="status">使用本机 Codex 登录</span></div>
      </details>
    </form>
    <section class="task-section" aria-label="任务">
      <div class="task-section-heading"><h2>任务</h2><span id="task-count"></span></div>
      <div id="empty-state" class="empty-state"><strong>先交给我一件小事</strong><p>进度、问题和结果都会留在这里。</p></div>
      <nav id="task-history" class="task-history" aria-label="任务历史"></nav>
      <article id="task-detail" class="task-detail hidden">
        <div class="detail-top"><h3 id="detail-title"></h3><div class="detail-actions"><button id="detail-stop" class="danger" type="button">停止</button><button id="detail-retry" type="button">再试一次</button><button id="copy-output" type="button">复制结果</button></div></div>
        <p id="detail-meta" class="detail-meta"></p>
        <div id="detail-activity" role="status"></div>
        <div id="pending" class="pending-card hidden"></div>
        <p id="detail-error" class="error task-error" role="alert"></p>
        <pre id="detail-output" class="output" aria-label="任务结果"></pre>
      </article>
    </section>
    <footer class="panel-footnote"><span id="platform-note"></span><button id="quit-app" type="button">退出大小姐</button></footer>`
  $('task-form').addEventListener('submit', startTask)
  $('choose-workspace').addEventListener('click', event => action(event.currentTarget, async () => {
    const path = await invoke('choose_workspace')
    if (path) $('workspace').value = path
  }))
  $('save-settings').addEventListener('click', event => action(event.currentTarget, async () => {
    const settings = collectSettings()
    await invoke('save_settings', { settings })
    state.settings = settings
    $('settings-state').textContent = '已保存'
  }))
  $('show-pet').addEventListener('click', event => action(event.currentTarget, () => invoke('hide_panel')))
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
  $('prompt').addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault()
      $('task-form').requestSubmit()
    }
  })
}

function collectSettings() {
  return settingsFrom({ workspace: $('workspace').value.trim(), permission: $('permission').value, codexPath: $('codex-path').value.trim(), model: $('model').value.trim() })
}

async function startTask(event) {
  event.preventDefault()
  if (state.submitting || state.tasks.some(isActive)) return
  const prompt = $('prompt').value.trim()
  const settings = collectSettings()
  if (!prompt || !settings.workspace) return
  state.submitting = true
  state.error = ''
  $('form-error').textContent = ''
  renderPanel()
  try {
    await invoke('save_settings', { settings })
    state.settings = settings
    acceptTask(await invoke('task_start', { request: { prompt, ...settings } }), { select: true, snapshot: true })
    $('prompt').value = ''
  } catch (error) {
    showError(error)
  } finally {
    state.submitting = false
    renderPanel()
  }
}

function renderPanel() {
  const tasks = orderedTasks(state.tasks)
  const active = tasks.find(isActive)
  const selected = selectedTask(tasks, state.selected)
  state.selected = selected?.id ?? null
  $('start-task').disabled = !!active || state.submitting
  $('start-task').textContent = state.submitting ? '正在启动…' : active ? '任务进行中' : '开始任务 ↗'
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

function renderPending(task) {
  const pending = $('pending')
  const key = pendingKey(task)
  pending.classList.toggle('hidden', !key)
  if (key === state.questionKey) return
  state.questionKey = key
  pending.replaceChildren()
  if (!task.pending) return
  if (task.pending.kind === 'approval') renderApproval(task, pending)
  else renderQuestions(task, pending)
}

function renderApproval(task, container) {
  const pending = task.pending
  container.append(element('h3', '', '允许这次操作吗？'))
  if (pending.message) container.append(element('p', '', pending.message))
  const command = typeof pending.command === 'string' ? pending.command : pending.command && JSON.stringify(pending.command, null, 2)
  const scope = [command, pending.permissions && JSON.stringify(pending.permissions, null, 2)].filter(Boolean).join('\n\n')
  if (scope) container.append(element('pre', '', scope))
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
  if (view === 'pet') {
    await window.__TAURI__.event.listen('pet:error', event => showError(event.payload))
  await window.__TAURI__.event.listen('motion:update', event => {
      state.motion = event.payload
      renderPet()
    })
    await loadSprites()
  }
  const initial = await invoke('bootstrap')
  for (const task of initial.tasks || []) {
    state.tasks = upsertTask(state.tasks, task, { snapshot: true })
  }
  state.settings = settingsFrom(initial.settings)
  state.positionable = initial.positionable !== false
  state.platform = initial.platform
  state.motion = initial.motion || state.motion
  if (view === 'panel' && initial.companion) {
    companionPanel = mountCompanion({invoke, initial: initial.companion, showError, platform:state.platform, onTasks: () => companionPanel.select('tasks')})
    await window.__TAURI__.event.listen('companion:update', event => companionPanel.update(event.payload))
  } else if (view === 'pet') {
    await window.__TAURI__.event.listen('companion:action', event => {if(event.payload.kind==='note.show')invoke('note_show').catch(showError)})
    await window.__TAURI__.event.listen('companion:bubble', event => {
      companionBubble = event.payload
      renderPet()
      setTimeout(() => renderPet(), Math.max(0, companionBubble.until - Date.now()))
    })
  }
  if (view === 'panel') {
    $('workspace').value = state.settings.workspace
    $('permission').value = state.settings.permission
    $('codex-path').value = state.settings.codexPath
    $('model').value = state.settings.model
    $('platform-note').textContent = `${platformLabel[state.platform] || state.platform} · ${state.positionable ? '原生窗口' : '原地互动模式'}`
  } else {
    await invoke('set_reduced_motion', { enabled: reduceMotion.matches })
    reduceMotion.addEventListener('change', event => {
      invoke('set_reduced_motion', { enabled: event.matches }).catch(showError)
      drawSprite()
    })
  }
  render()
  if (view === 'pet') drawSprite()
}

boot().catch(showError)
