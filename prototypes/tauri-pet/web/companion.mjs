const $ = id => document.getElementById(id)
const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node }
const date = ts => ts ? new Date(ts).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''
export const dateValue = value => value ? new Date(value).getTime() : null
export function mountCompanion({invoke, initial, showError, onTasks, platform}) {
  let current = initial
  let tab = 'chat'
  const header = document.querySelector('.panel-header')
  const tasks = document.createElement('div'); tasks.id = 'view-tasks'
  const form = $('task-form'), result = document.querySelector('.tasks-section') || $('task-history').closest('section')
  form.before(tasks); tasks.append(form, result); tasks.hidden = true
  const legacy=document.createElement('section');legacy.innerHTML='<h2>原有任务记录</h2><div id="legacy-tasks" class="item-list"></div>';tasks.append(legacy)
  const nav = document.createElement('nav'); nav.className = 'companion-nav'; nav.setAttribute('aria-label','控制面板')
  header.after(nav)
  const host = document.createElement('div'); nav.after($('panel-error')); $('panel-error').after(host)
  const tabs = [['chat','聊天'],['todos','待办'],['goals','目标'],['tasks','任务'],['growth','成长'],['activity','动态'],['settings','设置']]
  for (const [name, label] of tabs) {
    const button = text('button',label); button.type='button'; button.dataset.tab=name
    button.addEventListener('click',()=>select(name)); nav.append(button)
  }
  host.innerHTML = `
    <section id="view-chat" class="companion-view">
      <div id="chat-messages" class="chat-messages" aria-live="polite"></div><p id="chat-live" role="status"></p><button id="chat-pending" type="button" hidden>查看需要确认的操作</button><div id="chat-question" class="pending-card" hidden></div><div id="pending-actions" class="item-list"></div>
      <form id="chat-form" class="chat-compose"><label for="chat-text">和大小姐说点什么</label><textarea id="chat-text" required maxlength="20000" placeholder="聊聊今天，或者交给我一件事…"></textarea><div class="compose-footer"><button id="chat-new" type="button">新对话</button><button id="chat-stop" type="button" hidden>停止</button><button id="chat-send" class="primary">发送 ↗</button></div></form>
      <div class="quick-actions"><button id="look-open" type="button">看看我在做什么</button><button id="note-open" type="button">贴便签</button><button id="prank-dance" type="button">跳支舞</button></div>
      <details id="look-controls"><summary>选择观察窗口</summary><p class="muted">选中窗口的画面会交给当前 Codex 模型理解，不读取其他窗口。</p><div class="workspace-row"><select id="look-window" aria-label="观察窗口"></select><button id="look-refresh" type="button">刷新窗口</button><button id="look-now" type="button">看一下</button></div><p id="look-state" role="status"></p></details>
    </section>
    <section id="view-todos" class="companion-view" hidden>
      <h2>待办</h2><form id="todo-form" class="inline-compose"><input id="todo-text" aria-label="待办内容" required maxlength="2000" placeholder="记下一件事"><input id="todo-due" type="datetime-local" aria-label="截止时间"><button class="primary">添加</button></form><div id="todo-list" class="item-list"></div>
      <h2>提醒</h2><form id="reminder-form" class="inline-compose"><input id="reminder-text" aria-label="提醒内容" required placeholder="提醒我…"><input id="reminder-at" type="datetime-local" aria-label="提醒时间" required><select id="reminder-repeat" aria-label="重复"><option value="">仅一次</option><option value="daily">每天</option></select><button>设提醒</button></form><div id="reminder-list" class="item-list"></div>
      <h2>整理文件</h2><div class="workspace-row"><input id="tidy-folder" aria-label="整理目录" placeholder="选择要整理的目录"><button id="tidy-choose" type="button">选择</button><button id="tidy-preview" type="button">先看怎么整理</button></div><div id="tidy-plan" class="item-list"></div><div class="quick-actions"><button id="tidy-apply" type="button" hidden>按列表整理</button><button id="tidy-undo" type="button">撤销上次整理</button></div><h2>专注一会儿</h2><div class="quick-actions"><input id="pomo-minutes" type="number" min="1" max="180" value="25" aria-label="专注分钟"><button id="pomo-start">开始专注</button><button id="pomo-stop">结束</button><span id="pomo-state" role="status"></span></div>
    </section>
    <section id="view-goals" class="companion-view" hidden>
      <h2>持续推进的目标</h2><form id="goal-form" class="stack-form"><input id="goal-title" aria-label="目标" required placeholder="想持续推进什么？"><textarea id="goal-detail" aria-label="目标标准" placeholder="做到什么程度，哪些事情需要先问你？"></textarea><div class="workspace-row"><select id="goal-every" aria-label="跟进频率"><option value="daily">每天</option><option value="3h">每 3 小时</option><option value="hourly">每小时</option></select><input id="goal-at" type="time" value="09:00" aria-label="每日跟进时间"><button class="primary">添加目标</button></div></form><div id="goal-list" class="item-list"></div>
    </section>
    <section id="view-growth" class="companion-view" hidden><h2 id="growth-level"></h2><h3>记住的事</h3><form id="memory-form" class="workspace-row"><input id="memory-text" aria-label="长期记忆" required placeholder="希望大小姐记住的偏好"><button>记住</button></form><div id="memory-list" class="item-list"></div><div class="quick-actions"><button id="growth-reflect">整理记忆与日记</button></div><h3>成长笔记</h3><div id="growth-notes"></div><h3>日记</h3><div id="growth-diary"></div></section>
    <section id="view-activity" class="companion-view" hidden><h2>桌宠自己做的事</h2><div class="quick-actions"><button id="agenda-brief">今日简报</button><button id="agenda-pulse">只读巡检</button><button id="agenda-tip">来个小技巧</button><button id="summary-now">今日小结</button></div><div id="background-tasks" class="item-list"></div><h2>最近的动态</h2><div id="activity-list" class="item-list"></div></section>
    <section id="view-settings" class="companion-view" hidden>
      <h2>安静地陪着你</h2>
      <form id="observation-form" class="stack-form">
        <label class="check-row"><input id="observe-enabled" type="checkbox">主动观察当前窗口</label>
        <p class="setting-help">将当前窗口画面交给已配置的 Codex 模型，使用账户额度。截图不存入桌宠；模型服务按其数据政策处理。</p>
        <label class="check-row"><input id="observe-consent" type="checkbox">我了解观察范围及 AI 处理方式，允许安静地运行</label>
        <div class="settings-grid"><label>观察间隔<select id="observe-interval"><option value="60">1 分钟</option><option value="120">2 分钟</option><option value="300">5 分钟</option><option value="900">15 分钟</option></select></label><label>每小时最多互动<input id="observe-max" type="number" min="0" max="12" value="4"></label></div>
        <label>不看的应用或窗口<textarea id="observe-exclude" placeholder="一行一个，例如工作群名称或应用名称"></textarea></label>
        <p class="setting-help">默认跳过密码、支付、私密浏览、聊天和会议窗口。开启后不逐次提示，可随时暂停。</p>
        <div class="quick-actions"><button class="primary">保存观察设置</button><button id="observe-pause" type="button">暂停 1 小时</button><button id="observe-permission" type="button">授权屏幕访问</button></div><p id="observer-state" role="status"></p>
      </form>
      <h2>AI 与工作目录</h2><form id="companion-settings" class="stack-form"><label>聊天与任务后端<select id="companion-backend"><option value="codex">Codex</option><option value="dsh">DeepSeek Harness（Windows 兼容）</option></select></label><details><summary>DSH 兼容设置</summary><label>DSH 可执行文件<input id="companion-dsh" placeholder="自动查找"></label><label>Profile<input id="companion-profile" placeholder="desktop"></label><label>Provider<input id="companion-provider" placeholder="继承原配置"></label><label>DSH 模型<input id="companion-dsh-model" placeholder="继承原配置"></label></details><label>Codex 可执行文件<input id="companion-codex" placeholder="自动查找"></label><label>模型<input id="companion-model" placeholder="使用 Codex 默认模型"></label><label>观察模型<input id="companion-glance-model" placeholder="与聊天相同"></label><label>工作目录<input id="companion-cwd" placeholder="未设置时只在独立工作目录中运行"></label><label>任务权限<select id="companion-permission"><option value="read-only">只读</option><option value="workspace-write">工作区可写</option><option value="danger-full-access">完全访问（谨慎）</option></select></label><div class="settings-grid"><label>安静开始<input id="quiet-start" type="time"></label><label>安静结束<input id="quiet-end" type="time"></label></div><button class="primary">保存</button><span id="companion-saved" role="status"></span></form><h2>天气与更新</h2><form id="weather-form" class="workspace-row"><input id="weather-city" aria-label="所在城市" placeholder="城市留空时不查询天气"><button>查天气</button></form><p id="weather-state" role="status"></p><button id="update-check" type="button">检查更新</button><p id="update-state" role="status"></p>
    </section>`
  const call = async (command,args={}) => {const result=await invoke('companion_command',{command,args});showError('');return result}
  const bind = (id,work) => $(id).addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{await work()}catch(e){showError(e)}finally{button.disabled=false}})
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
  submit('todo-form',async()=>{await call('todo:add',{text:$('todo-text').value,due:dateValue($('todo-due').value)});$('todo-text').value=''})
  submit('reminder-form',async()=>{await call('reminder:add',{text:$('reminder-text').value,at:dateValue($('reminder-at').value),repeat:$('reminder-repeat').value});$('reminder-text').value=''})
  submit('goal-form',async()=>{await call('goal:add',{title:$('goal-title').value,detail:$('goal-detail').value,every:$('goal-every').value,at:$('goal-at').value});$('goal-title').value='';$('goal-detail').value=''})
  submit('memory-form',async()=>{await call('memory:add',{text:$('memory-text').value});$('memory-text').value=''})
  bind('pomo-start',()=>call('pomodoro:start',{minutes:Number($('pomo-minutes').value)}));bind('pomo-stop',()=>call('pomodoro:stop'))
  submit('observation-form',async()=>{await call('observation:set',{enabled:$('observe-enabled').checked,consentVersion:$('observe-consent').checked?1:0,intervalSeconds:Number($('observe-interval').value),maxPerHour:Number($('observe-max').value),quiet:true,excludeApps:$('observe-exclude').value});$('observer-state').textContent='已保存'})
  bind('observe-pause',()=>call('screen:pause',{minutes:60}))
  bind('observe-permission',async()=>{const allowed=await invoke('observer_permission');$('observer-state').textContent=allowed?'屏幕权限已就绪':'请在系统设置中允许屏幕访问，再回到这里。'})
  submit('companion-settings',async()=>{await call('settings:set',{backend:$('companion-backend').value,dshExe:$('companion-dsh').value,sourceProfile:$('companion-profile').value||'desktop',provider:$('companion-provider').value,model:$('companion-dsh-model').value,codexExe:$('companion-codex').value.trim(),codexModel:$('companion-model').value.trim(),codexGlanceModel:$('companion-glance-model').value.trim(),cwd:$('companion-cwd').value.trim(),permission:$('companion-permission').value,quietStart:$('quiet-start').value,quietEnd:$('quiet-end').value});$('companion-saved').textContent='已保存'})
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
    $('chat-send').disabled=!!current.chatTask; $('chat-stop').hidden=!current.chatTask
    list('chat-messages',d.chat.messages.slice(-100),m=>text('div',m.text,`chat-message ${m.role}`))
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
    $('observer-state').textContent=conf.pausedUntil>Date.now()?`暂停至 ${date(conf.pausedUntil)}`:o.error||(!o.permission?'尚未授予屏幕访问权限':conf.enabled?'已开启 · 安静运行':'未开启')
  }
  function fill() {const d=current.data,s=d.settings,o=d.observation
    $('weather-city').value=s.weatherCity||''
    $('observe-enabled').checked=!!o.enabled;$('observe-consent').checked=o.consentVersion===1;$('observe-interval').value=o.intervalSeconds;$('observe-max').value=o.maxPerHour;$('observe-exclude').value=o.excludeApps
    for(const [id,key]of [['companion-backend','backend'],['companion-dsh','dshExe'],['companion-profile','sourceProfile'],['companion-provider','provider'],['companion-dsh-model','model'],['companion-codex','codexExe'],['companion-model','codexModel'],['companion-glance-model','codexGlanceModel'],['companion-cwd','cwd'],['companion-permission','permission'],['quiet-start','quietStart'],['quiet-end','quietEnd']])$(id).value=s[key]||''
  }
  function select(name) {tab=name;for(const [n]of tabs){const node=$(`view-${n}`);node.hidden=n!==name;nav.querySelector(`[data-tab="${n}"]`).setAttribute('aria-current',String(n===name))}if(name==='settings'){fill();invoke('observer_status').then(permission=>{current.observer.permission=permission;render()}).catch(showError)}render()}
  fill();select(tab)
  return { update(value){current=value;render()}, select, taskUpdated(tasks){const task=tasks.find(t=>t.id===current.chatTask);$('chat-live').textContent=task ? task.output||task.activity : ''; $('chat-send').disabled=!!current.chatTask; $('chat-stop').hidden=!current.chatTask; $('chat-pending').hidden=!task?.pending} }
}
