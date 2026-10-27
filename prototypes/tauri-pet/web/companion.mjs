import { observationPayload, observationStatus, observationPermissions } from './observation.mjs'
const $ = id => document.getElementById(id)
const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node }
const date = ts => ts ? new Date(ts).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''
const icons = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
  todos: '<path d="m4 12 4 4 8-8m-1 8 5-5M4 4h10"/>',
  goals: '<path d="M4 22V3m0 1c5-5 11 5 16 0v12c-5 5-11-5-16 0"/>',
  tasks: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m7 8 4 4-4 4m6 0h4"/>',
  actions: '<path d="M7 3c-4 0-4 7-2 9 1 1 4 1 4-1V7c0-2 0-4-2-4Zm10 6c4 0 4 7 2 9-1 1-4 1-4-1v-4c0-2 0-4 2-4Z"/>',
  growth: '<path d="M12 22v-9m0 3C3 16 2 10 3 4c6 0 10 4 9 12Zm0-3C12 6 18 3 22 3c0 5-4 10-10 10Z"/>',
  activity: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  settings: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="9" cy="5" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="19" r="2"/>',
}
const navIcon = name => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icons[name]}</svg>`
const ACTIONS = [['climb','爬窗','攀爬预览'],['ledge','翻上窗沿','收尾预览'],['wave','挥挥手'],['stretch','伸个懒腰'],['magnify','看看内容'],['read','读一会儿'],['dance','跳支舞'],['walk','走两步'],['water','喝点水'],['nap','打个盹'],['happy','开心一下'],['magic','变个魔术']]
export const dateValue = value => value ? new Date(value).getTime() : null
export function mountCompanion({invoke, initial, showError, onTasks, platform}) {
  let current = initial
  let tab = 'chat'
  let motionValue = null
  const header = document.querySelector('.panel-header')
  const tasks = document.createElement('div'); tasks.id = 'view-tasks'
  const form = $('task-form'), result = document.querySelector('.tasks-section') || $('task-history').closest('section')
  form.before(tasks); tasks.append(form, result); tasks.hidden = true
  const legacy=document.createElement('section');legacy.innerHTML='<h2>原有任务记录</h2><div id="legacy-tasks" class="item-list"></div>';tasks.append(legacy)
  const nav = document.createElement('nav'); nav.className = 'companion-nav'; nav.setAttribute('aria-label','控制面板')
  header.after(nav)
  const host = document.createElement('div'); nav.after($('panel-error')); $('panel-error').after(host)
  const tabs = [['chat','聊天'],['todos','待办'],['goals','目标'],['tasks','任务'],['actions','动作'],['growth','成长'],['activity','动态'],['settings','设置']]
  for (const [name, label] of tabs) {
    const button = text('button',''); button.type='button'; button.dataset.tab=name;button.setAttribute('aria-label',label)
    button.innerHTML=navIcon(name);button.append(text('span',label))
    button.addEventListener('click',()=>select(name)); nav.append(button)
  }
  host.innerHTML = `
    <section id="view-chat" class="companion-view">
      <div id="chat-welcome" class="chat-welcome"><div class="welcome-sprite" aria-hidden="true"></div><h2>今天，也一起。</h2><p>聊聊今天，或者从一件小事开始。</p></div>
      <div id="chat-messages" class="chat-messages" aria-live="polite"></div><p id="chat-live" role="status"></p><button id="chat-pending" type="button" hidden>查看需要确认的操作</button><div id="chat-question" class="pending-card" hidden></div><div id="pending-actions" class="item-list"></div>
      <form id="chat-form" class="chat-compose"><label for="chat-text" class="visually-hidden">和大小姐说点什么</label><textarea id="chat-text" required maxlength="20000" placeholder="说点什么，或者交给我一件事…"></textarea><div class="compose-footer"><button id="chat-new" type="button" class="subtle">＋ 新对话</button><button id="chat-stop" type="button" hidden>停止</button><button id="chat-send" class="primary">发送 ↗</button></div></form>
      <div class="quick-actions"><button id="look-open" type="button">看看我在做什么</button><button id="note-open" type="button">贴便签</button><button id="prank-dance" type="button">跳支舞</button></div>
      <details id="look-controls"><summary>选择观察窗口</summary><p class="muted">选中窗口的画面或已启用的可见文字会交给 Codex 理解，不读取其他窗口。</p><div class="workspace-row"><select id="look-window" aria-label="观察窗口"></select><button id="look-refresh" type="button">刷新窗口</button><button id="look-now" type="button">看一下</button></div><p id="look-state" role="status"></p></details>
    </section>
    <section id="view-todos" class="companion-view" hidden>
      <section id="alert-inbox" hidden><h2 id="alert-inbox-title">待处理提醒</h2><div id="alert-list" class="item-list"></div></section>
      <h2>待办</h2><form id="todo-form" class="inline-compose"><input id="todo-text" aria-label="待办内容" required maxlength="2000" placeholder="记下一件事"><input id="todo-due" type="datetime-local" aria-label="截止时间"><button class="primary">添加</button></form><div id="todo-list" class="item-list"></div>
      <h2>提醒</h2><form id="reminder-form" class="inline-compose"><input id="reminder-text" aria-label="提醒内容" required placeholder="提醒我…"><input id="reminder-at" type="datetime-local" aria-label="提醒时间" required><select id="reminder-repeat" aria-label="重复"><option value="">仅一次</option><option value="daily">每天</option></select><button>设提醒</button></form><div id="reminder-list" class="item-list"></div>
      <h2>整理文件</h2><div class="workspace-row"><input id="tidy-folder" aria-label="整理目录" placeholder="选择要整理的目录"><button id="tidy-choose" type="button">选择</button><button id="tidy-preview" type="button">先看怎么整理</button></div><div id="tidy-plan" class="item-list"></div><div class="quick-actions"><button id="tidy-apply" type="button" hidden>按列表整理</button><button id="tidy-undo" type="button">撤销上次整理</button></div><h2>专注一会儿</h2><div class="quick-actions"><input id="pomo-minutes" type="number" min="1" max="180" value="25" aria-label="专注分钟"><button id="pomo-start">开始专注</button><button id="pomo-stop">结束</button><span id="pomo-state" role="status"></span></div>
    </section>
    <section id="view-goals" class="companion-view" hidden>
      <h2>持续推进的目标</h2><form id="goal-form" class="stack-form"><input id="goal-title" aria-label="目标" required placeholder="想持续推进什么？"><textarea id="goal-detail" aria-label="目标标准" placeholder="做到什么程度，哪些事情需要先问你？"></textarea><div class="workspace-row"><select id="goal-every" aria-label="跟进频率"><option value="daily">每天</option><option value="3h">每 3 小时</option><option value="hourly">每小时</option></select><input id="goal-at" type="time" value="09:00" aria-label="每日跟进时间"><button class="primary">添加目标</button></div></form><div id="goal-list" class="item-list"></div>
    </section>
    <section id="view-growth" class="companion-view" hidden><h2 id="growth-level"></h2><h3>记住的事</h3><form id="memory-form" class="workspace-row"><input id="memory-text" aria-label="长期记忆" required placeholder="希望大小姐记住的偏好"><button>记住</button></form><div id="memory-list" class="item-list"></div><div class="quick-actions"><button id="growth-reflect">整理记忆与日记</button></div><h3>成长笔记</h3><div id="growth-notes"></div><h3>日记</h3><div id="growth-diary"></div></section>
    <section id="view-actions" class="companion-view" hidden><div class="actions-intro"><h2>让她去转转。</h2><p>一个小动作，也是一点陪伴。</p></div><div class="new-actions"><div class="action-art" id="climb-preview" aria-hidden="true"></div><div class="action-art" id="ledge-preview" aria-hidden="true"></div><div><span class="eyebrow">新动作</span><h3>从窗口边上，爬到你身边。</h3><p>沿着真实窗口的边缘走过去，再爬到窗沿坐下。</p></div></div><div class="desktop-activity"><h3>桌面活动</h3><div class="quick-actions"><button id="motion-walk" type="button">去走走</button><button id="motion-climb" type="button" class="primary">爬上窗口</button><button id="motion-stop" type="button">停步／下来</button><button id="motion-pause" type="button">暂停活动</button><button id="motion-resume" type="button">继续活动</button></div><div class="workspace-row"><select id="motion-screen" aria-label="目标显示器"></select><button id="motion-go" type="button">到这块屏幕</button><button id="motion-refresh" type="button">刷新</button></div><p id="motion-state" class="setting-help" role="status"></p><form id="motion-preferences" class="motion-preferences"><label class="check-row"><input id="motion-wander" type="checkbox">自主走动</label><label class="check-row"><input id="motion-windows" type="checkbox">自动爬窗</label><label class="check-row"><input id="motion-cross" type="checkbox">允许跨屏</label><label class="check-row"><input id="motion-fullscreen" type="checkbox">全屏时隐藏</label><button type="submit">保存偏好</button></form></div><h3>动作预览</h3><div id="action-gallery" class="action-gallery" aria-label="动作选择器"></div><p id="action-state" class="muted" role="status">选择一个动作，在桌宠上播放。不会弹出说话气泡。</p></section>
    <section id="view-activity" class="companion-view" hidden><h2>桌宠自己做的事</h2><div class="quick-actions"><button id="agenda-brief">今日简报</button><button id="agenda-pulse">只读巡检</button><button id="agenda-tip">来个小技巧</button><button id="summary-now">今日小结</button></div><div id="background-tasks" class="item-list"></div><h2>最近的动态</h2><div id="activity-list" class="item-list"></div></section>
    <section id="view-settings" class="companion-view" hidden>
      <h2>安静地陪着你</h2>
      <form id="observation-form" class="stack-form">
        <label class="check-row"><input id="observe-enabled" type="checkbox">主动观察当前窗口</label>
        <label id="observe-text-option" class="check-row"><input id="observe-text" type="checkbox">优先读取可见文字（macOS 辅助功能）</label>
        <p class="setting-help">窗口内容交给已配置的 Codex 模型理解，使用账户额度；画面和原始文字不写入桌宠记录，模型服务按其数据政策处理。</p>
        <p id="observe-text-help" class="setting-help">读不到文字时，仅在已授权屏幕访问的情况下使用画面。</p>
        <label class="check-row"><input id="observe-consent" type="checkbox">我了解观察范围及 AI 处理方式，允许安静地运行</label>
        <div class="settings-grid"><label>观察间隔<select id="observe-interval"><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="900">15 分钟</option></select></label><label>每小时最多互动<input id="observe-max" type="number" min="0" max="12" value="4"></label></div>
        <label>不看的应用或窗口<textarea id="observe-exclude" placeholder="一行一个，例如工作群名称或应用名称"></textarea></label>
        <p class="setting-help">默认跳过密码、支付、私密浏览、聊天和会议窗口。开启后不逐次提示，可随时暂停。</p>
        <div class="quick-actions"><button class="primary">保存观察设置</button><button id="observe-pause" type="button">暂停 1 小时</button><button id="observe-permission" type="button">授权屏幕访问</button><button id="observe-accessibility" type="button">授权辅助功能</button><button id="observe-check" type="button">检查权限</button></div><p id="observer-permissions" class="muted"></p><p id="observer-state" role="status"></p>
      </form>
      <h2>AI 与工作目录</h2><form id="companion-settings" class="stack-form"><label>聊天与任务后端<select id="companion-backend"><option value="codex">Codex</option><option value="dsh">DeepSeek Harness（Windows 兼容）</option></select></label><details><summary>DSH 兼容设置</summary><label>DSH 可执行文件<input id="companion-dsh" placeholder="自动查找"></label><label>Profile<input id="companion-profile" placeholder="desktop"></label><label>Provider<input id="companion-provider" placeholder="继承原配置"></label><label>DSH 模型<input id="companion-dsh-model" placeholder="继承原配置"></label></details><label>Codex 可执行文件<input id="companion-codex" placeholder="自动查找"></label><label>模型<input id="companion-model" placeholder="使用 Codex 默认模型"></label><label>观察模型<input id="companion-glance-model" placeholder="与聊天相同"></label><label>工作目录<input id="companion-cwd" placeholder="未设置时只在独立工作目录中运行"></label><label>任务权限<select id="companion-permission"><option value="read-only">只读</option><option value="workspace-write">工作区可写</option><option value="danger-full-access">完全访问（谨慎）</option></select></label><label>再次提醒间隔（分钟）<input id="nag-minutes" type="number" min="0" max="1440" required value="5"></label><p class="setting-help">0 为不重复；最多弹出 3 次，未处理内容留在待办。</p><div class="settings-grid"><label>安静开始<input id="quiet-start" type="time"></label><label>安静结束<input id="quiet-end" type="time"></label></div><button class="primary">保存</button><span id="companion-saved" role="status"></span></form><h2>天气与更新</h2><form id="weather-form" class="workspace-row"><input id="weather-city" aria-label="所在城市" placeholder="城市留空时不查询天气"><button>查天气</button></form><p id="weather-state" role="status"></p><button id="update-check" type="button">检查更新</button><p id="update-state" role="status"></p>
    </section>`
  const sidebar=document.createElement('aside');sidebar.className='companion-sidebar'
  const brand=header.querySelector('.brand');brand.querySelector('h1').textContent='大小姐';brand.querySelector('.brand-mark').textContent='✿'
  sidebar.append(brand,nav)
  const main=document.createElement('main');main.className='companion-main'
  const title=document.createElement('div');title.className='panel-title';title.innerHTML='<h2 id="companion-title">今天也一起。</h2><p id="companion-subtitle">Codex · 随时聊聊</p>'
  header.prepend(title)
  document.querySelector('#app').prepend(sidebar,main)
  main.append(header,$('panel-error'),host,tasks,document.querySelector('.panel-footnote'))
  const call = async (command,args={}) => {const result=await invoke('companion_command',{command,args});showError('');return result}
  const bind = (id,work) => $(id).addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{await work()}catch(e){showError(e)}finally{button.disabled=false;if(button.id.startsWith('motion-'))renderMotion()}})
  const submit=(id,work)=>$(id).addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button.primary,button:not([type="button"])');if(button)button.disabled=true;try{await work()}catch(error){showError(error)}finally{if(button)button.disabled=false}})
  submit('chat-form', async()=>{await call('chat:send',{text:$('chat-text').value.trim()});$('chat-text').value=''})
  bind('chat-stop',async()=>{if(current.chatTask)await invoke('task_cancel',{id:current.chatTask})})
  bind('chat-pending',()=>select('tasks'))
  bind('chat-new',()=>call('chat:new'))
  const refresh = async()=>{const values=await invoke('observer_windows');$('look-window').replaceChildren(...values.map(w=>{const n=text('option',`${w.name} · ${w.title}`);n.value=w.id;return n}));$('look-controls').open=true}
  bind('look-open',refresh);bind('look-refresh',refresh)
  bind('look-now',async()=>{const id=Number($('look-window').value);if(!id)throw new Error('请先选择一个窗口');await invoke('look_now',{chosen:id});$('look-state').textContent='这次观察已开始，合适的内容会显示在桌宠气泡里。'})
  bind('note-open',()=>invoke('note_toggle'))
  bind('prank-dance',()=>call('prank',{name:'dance'}))
  const motion = async(command,screen) => {await invoke('motion_command',{command,screen});if(['walk','climb','screen'].includes(command))await invoke('hide_panel');await refreshMotion()}
  const refreshMotion = async() => {
    motionValue=await invoke('motion_status')
    $('motion-screen').replaceChildren(...motionValue.screens.map((s,i)=>{const option=text('option',`${i+1} · ${s.name}`);option.value=s.id;return option}))
    if(motionValue.current)$('motion-screen').value=motionValue.current
    for(const id of ['motion-walk','motion-climb','motion-stop','motion-go'])$(id).disabled=!motionValue.positionable
    if(motionValue.screens.length<2)$('motion-go').disabled=true
    renderMotion()
  }
  for(const [id,command]of [['motion-walk','walk'],['motion-climb','climb'],['motion-stop','stop'],['motion-pause','pause'],['motion-resume','resume']])bind(id,()=>motion(command))
  bind('motion-refresh',refreshMotion);bind('motion-go',()=>motion('screen',$('motion-screen').value))
  submit('motion-preferences',async()=>{await call('settings:set',{wander:$('motion-wander').checked,climbWindows:$('motion-windows').checked,crossScreens:$('motion-cross').checked,hideOnFullscreen:$('motion-fullscreen').checked});$('motion-state').textContent='桌面活动偏好已保存'})
  function renderMotion(){if(!motionValue)return;const paused=current.data.settings.motionPausedUntil>Date.now();const m=motionValue.motion;for(const id of ['motion-walk','motion-climb','motion-go'])$(id).disabled=!motionValue.positionable||paused; $('motion-stop').disabled=!motionValue.positionable;if(motionValue.screens.length<2)$('motion-go').disabled=true;const labels={walking:'走路中',climbing:'攀爬中',hoisting:'正在翻上窗沿',descending:'正在下来',perched:'坐在窗口上',dragging:'跟着你走',flying:'落地中',settled:'安静陪着你'};$('motion-state').textContent=!motionValue.positionable?'当前 Wayland 桌面由系统管理位置；X11 或 XWayland 可使用自主移动。':paused?'桌面活动已暂停 1 小时，可随时继续。':m.paused?({starting:'正在恢复桌面活动…',locked:'屏幕锁定时暂停活动。',fullscreen:'全屏应用中暂停活动。',task:'任务结束后继续活动。',panel:'收起控制面板后继续活动。',quiet:'安静时段内暂停自主活动。',disabled:'自主走动已关闭。',focus:'专注结束后继续活动。',away:'等你回来再继续活动。',hover:'鼠标移开后继续，拖动可打断。',display:'等待显示器就绪。'})[m.pauseReason]||'桌面活动已暂停。':labels[m.phase]||'安静陪着你';$('motion-pause').hidden=paused;$('motion-resume').hidden=!paused}

  const play=async(name,label)=>{await call('prank',{name});$('action-state').textContent=`正在桌宠上播放：${label}`}
  for(const [name,label,description]of ACTIONS){const b=document.createElement('button');b.type='button';b.className='action-tile';b.setAttribute('aria-label',`播放${label}`);const preview=document.createElement('span');preview.className='action-art';preview.dataset.sprite=name;preview.setAttribute('aria-hidden','true');b.append(preview,text('span',label));if(description)b.append(text('small',description));b.addEventListener('click',async()=>{b.disabled=true;try{await play(name,label)}catch(e){showError(e)}finally{b.disabled=false}});$('action-gallery').append(b)}
  fetch('./assets/sprites/manifest.json').then(r=>{if(!r.ok)throw new Error('动作资源不可用');return r.json()}).then(manifest=>{for(const node of [...document.querySelectorAll('[data-sprite]'),$('climb-preview'),$('ledge-preview')]){const name=node.dataset.sprite||node.id.replace('-preview','');const a=manifest.anims[name];if(!a)throw new Error(`缺少动作：${name}`);const h=node.closest('.new-actions')?132:78;const w=h*a.w/a.h;node.style.width=`${w}px`;node.style.height=`${h}px`;node.style.backgroundImage=`url('./assets/sprites/${a.file}')`;node.style.backgroundSize=`${w*a.frames}px ${h}px`;if(name==='ledge'&&node.id)node.style.backgroundPosition=`-${w*3}px 0`}}).catch(showError)
  submit('todo-form',async()=>{await call('todo:add',{text:$('todo-text').value,due:dateValue($('todo-due').value)});$('todo-text').value=''})
  submit('reminder-form',async()=>{await call('reminder:add',{text:$('reminder-text').value,at:dateValue($('reminder-at').value),repeat:$('reminder-repeat').value});$('reminder-text').value=''})
  submit('goal-form',async()=>{await call('goal:add',{title:$('goal-title').value,detail:$('goal-detail').value,every:$('goal-every').value,at:$('goal-at').value});$('goal-title').value='';$('goal-detail').value=''})
  submit('memory-form',async()=>{await call('memory:add',{text:$('memory-text').value});$('memory-text').value=''})
  bind('pomo-start',()=>call('pomodoro:start',{minutes:Number($('pomo-minutes').value)}));bind('pomo-stop',()=>call('pomodoro:stop'))
  submit('observation-form',async()=>{await call('observation:set',observationPayload({enabled:$('observe-enabled').checked,accessibility:$('observe-text').checked,consented:$('observe-consent').checked,intervalSeconds:Number($('observe-interval').value),maxPerHour:Number($('observe-max').value),excludeApps:$('observe-exclude').value}));await refreshObservation()})
  bind('observe-pause',()=>call('screen:pause',{minutes:60}))
  const refreshObservation=async()=>{current.observer.capabilities=await invoke('observer_capabilities');render()}
  bind('observe-permission',async()=>{const allowed=await invoke('observer_permission');await refreshObservation();if(!allowed)$('observer-state').textContent='请在系统设置中允许屏幕访问，再点击检查权限。'})
  bind('observe-accessibility',async()=>{const allowed=await invoke('accessibility_permission');await refreshObservation();if(!allowed)$('observer-state').textContent='请在系统设置中允许辅助功能，再点击检查权限。'})
  bind('observe-check',refreshObservation)
  $('observe-text').addEventListener('change',()=>{$('observe-consent').checked=false})
  const textSupported=initial.observer.capabilities?.accessibilitySupported??['macos','darwin'].includes(platform)
  for(const id of ['observe-text-option','observe-text-help','observe-accessibility'])$(id).hidden=!textSupported
  submit('companion-settings',async()=>{await call('settings:set',{backend:$('companion-backend').value,dshExe:$('companion-dsh').value,sourceProfile:$('companion-profile').value||'desktop',provider:$('companion-provider').value,model:$('companion-dsh-model').value,codexExe:$('companion-codex').value.trim(),codexModel:$('companion-model').value.trim(),codexGlanceModel:$('companion-glance-model').value.trim(),cwd:$('companion-cwd').value.trim(),permission:$('companion-permission').value,nagMinutes:Number($('nag-minutes').value),quietStart:$('quiet-start').value,quietEnd:$('quiet-end').value});$('companion-saved').textContent='已保存'})
  bind('tidy-choose',async()=>{const path=await invoke('choose_workspace');if(path)$('tidy-folder').value=path})
  bind('tidy-preview',()=>call('tidy:preview',{folder:$('tidy-folder').value}))
  bind('tidy-apply',()=>call('tidy:apply'));bind('tidy-undo',()=>call('tidy:undo'))
  bind('growth-reflect',()=>call('growth:reflect'))
  bind('agenda-brief',()=>call('agenda:brief'));bind('agenda-pulse',()=>call('agenda:pulse'));bind('agenda-tip',()=>call('agenda:tip'));bind('summary-now',()=>call('summary:now'))
  submit('weather-form',async()=>{await call('settings:set',{weatherCity:$('weather-city').value.trim()});await call('weather:refresh')})
  bind('update-check',async()=>{const value=await call('update:check');$('update-state').textContent=value?`最新发布：${value.version}`:'暂时没有新发布'})
  if(!['windows','win32'].includes(platform))$('companion-backend').querySelector('[value="dsh"]').disabled=true
  function button(label,command,args) {const n=text('button',label);n.type='button';n.addEventListener('click',()=>call(command,args).catch(showError));return n}
  function list(id,items,render){$(id).replaceChildren(...items.map(render))}
  function row(title,meta=''){const n=text('div','', 'companion-item');const body=text('div','');body.append(text('p',title),text('small',meta));n.append(body);return n}
  function render() {
    const d=current.data
    renderMotion()
    $('chat-welcome').hidden=d.chat.messages.length>0
    $('chat-send').disabled=!!current.chatTask; $('chat-stop').hidden=!current.chatTask
    if(!current.chatTask){$('chat-live').textContent='';$('chat-pending').hidden=true}
    list('chat-messages',d.chat.messages.slice(-100),m=>text('div',m.text,`chat-message ${m.role}`))
    const alerts=d.alerts||[]
    $('alert-inbox').hidden=!alerts.length;$('alert-inbox-title').textContent=`待处理提醒 · ${alerts.length}`
    list('alert-list',alerts,a=>{const n=row(a.text,`${date(a.createdAt)}${a.count?` · 已提醒 ${a.count} 次`:''}`);const controls=text('div','','quick-actions');const choices=a.kind==='todo-soon'?[['done','已完成'],['ok','马上做']]:a.kind==='todo-overdue'?[['done','已完成'],['later','推迟 1 小时']]:['reminder','pomodoro'].includes(a.kind)?[['ok','知道了'],['snooze','10 分钟后']]:[];for(const [i,[choice,label]]of choices.entries()){const b=button(label,'alert:respond',{id:a.id,choice});if(i===0)b.classList.add('primary');controls.append(b)}if(a.kind==='goal-ask'){const b=text('button','查看目标');b.type='button';b.addEventListener('click',()=>select('goals'));controls.append(b)}n.append(controls);return n})
    list('todo-list',d.todos,t=>{const n=row(t.text,t.done?'已完成':date(t.due));const check=document.createElement('input');check.type='checkbox';check.checked=!!t.done;check.setAttribute('aria-label',`完成 ${t.text}`);check.addEventListener('change',()=>call('todo:update',{id:t.id,patch:{done:check.checked}}).catch(showError));n.prepend(check);n.append(button('移除','todo:remove',{id:t.id}));return n})
    list('reminder-list',d.reminders.filter(r=>!r.fired),r=>{const n=row(r.text,date(r.at));n.append(button('移除','reminder:remove',{id:r.id}));return n})
    list('goal-list',d.goals,g=>{const n=row(g.title,`${({active:'进行中',paused:'已暂停',waiting:'等你决定',done:'已完成'})[g.status]||g.status} · 下次 ${date(g.nextAt)}`);const controls=text('div','', 'quick-actions');controls.append(button('推进一步','goal:run',{id:g.id}),button(g.status==='active'?'暂停':'继续','goal:update',{id:g.id,patch:{status:g.status==='active'?'paused':'active'}}),button('移除','goal:remove',{id:g.id}));if(g.question){controls.append(text('p',g.question.question));for(const option of g.question.options||[])controls.append(button(option,'goal:answer',{id:g.id,answer:option}))}const logs=text('div','', 'goal-log');for(const l of (g.log||[]).slice(-3))logs.append(text('p',`${date(l.ts)} ${l.text}`));n.append(controls,logs);return n})
    list('memory-list',d.memories,m=>{const n=row(m.text);n.append(button('忘记','memory:remove',{id:m.id}));return n})
    list('legacy-tasks',d.tasks||[],t=>{const n=row(t.title||t.prompt,`${t.status==='running'?'上次未完成':t.status} · ${date(t.startedAt)}`);if(t.result)n.append(text('p',t.result));if(t.error)n.append(text('p',t.error,'error'));n.append(button('重新开始','legacy:retry',{id:t.id}));return n})
    list('background-tasks',d.backgroundTasks||[],t=>row(t.text,`${t.kind} · ${date(t.at)}`))
    list('pending-actions',d.pendingActions||[],item=>{const a=item.action;const n=row(a.action==='file.move'?`移动 ${a.from} → ${a.to}`:a.action==='open'?`打开 ${a.target}`:a.text);n.append(button('确认','action:accept',{id:item.id}),button('不要','action:reject',{id:item.id}));return n})
    const question=d.chat.question;$('chat-question').hidden=!question
    $('chat-question').replaceChildren()
    if(question){$('chat-question').append(text('p',question.question));for(const option of question.options||[])$('chat-question').append(button(option,'chat:answer',{answer:option}))}
    const plan=d.tidyPreview
    list('tidy-plan',plan?.moves||[],m=>row(m.name,`→ ${m.cat}`))
    $('tidy-apply').hidden=!plan?.moves?.length
    $('weather-state').textContent=d.weather?`${d.weather.city} · ${d.weather.desc||''} ${d.weather.temp}°C`:''
    $('growth-level').textContent=`Lv.${d.growth.level||1} · ${d.growth.xp||0} XP`
    $('growth-notes').replaceChildren(...(d.growth.notes||[]).map(n=>text('p',typeof n==='string'?n:n.text||'')))
    $('growth-diary').replaceChildren(...(d.growth.diary||[]).slice(-10).map(n=>text('p',typeof n==='string'?n:`${n.day||''} ${n.text||''}`)))
    list('activity-list',d.activity.slice(0,100),a=>row(a.text,date(a.ts)))
    $('pomo-state').textContent=d.pomodoro.until>Date.now()?`专注至 ${date(d.pomodoro.until)}`:'尚未开始'
    const o=current.observer, conf=d.observation
    $('observer-state').textContent=observationStatus(conf,o);$('observer-permissions').textContent=observationPermissions(o.capabilities)
  }
  function fill() {const d=current.data,s=d.settings,o=d.observation
    $('weather-city').value=s.weatherCity||''
    $('nag-minutes').value=s.nagMinutes??5
    for(const [id,key]of [['motion-wander','wander'],['motion-windows','climbWindows'],['motion-cross','crossScreens'],['motion-fullscreen','hideOnFullscreen']])$(id).checked=s[key]!==false
    $('observe-enabled').checked=!!o.enabled;$('observe-text').checked=!!o.accessibility;$('observe-consent').checked=o.accessibility?o.consentVersion===2:[1,2].includes(o.consentVersion);$('observe-interval').value=o.intervalSeconds;$('observe-max').value=o.maxPerHour;$('observe-exclude').value=o.excludeApps
    for(const [id,key]of [['companion-backend','backend'],['companion-dsh','dshExe'],['companion-profile','sourceProfile'],['companion-provider','provider'],['companion-dsh-model','model'],['companion-codex','codexExe'],['companion-model','codexModel'],['companion-glance-model','codexGlanceModel'],['companion-cwd','cwd'],['companion-permission','permission'],['quiet-start','quietStart'],['quiet-end','quietEnd']])$(id).value=s[key]||''
  }
  function select(name) {if(!tabs.some(([n])=>n===name))return;tab=name;for(const [n]of tabs){const node=$(`view-${n}`);node.hidden=n!==name;nav.querySelector(`[data-tab="${n}"]`).setAttribute('aria-current',String(n===name))}const label=tabs.find(([n])=>n===name)[1];$('companion-title').textContent=name==='chat'?'今天也一起。':label;$('companion-subtitle').textContent=name==='chat'?`${current.data.settings.backend==='dsh'?'DeepSeek Harness':'Codex'} · 随时聊聊`:name==='actions'?'随心动一动，安静陪着你。':'Claude Ojousama';if(name==='actions'){fill();refreshMotion().catch(showError)}if(name==='settings'){fill();refreshObservation().catch(showError)}render()}
  fill();select(tab)
  return { motionUpdated(value){if(motionValue){motionValue.motion=value;renderMotion()}}, update(value){current=value;render()}, select, taskUpdated(tasks){const task=tasks.find(t=>t.id===current.chatTask);$('chat-live').textContent=task ? task.output||task.activity : ''; $('chat-send').disabled=!!current.chatTask; $('chat-stop').hidden=!current.chatTask; $('chat-pending').hidden=!task?.pending} }
}
