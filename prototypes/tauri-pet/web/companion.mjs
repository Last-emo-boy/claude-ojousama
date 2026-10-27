const $ = id => document.getElementById(id)
const text = (tag, value, className = '') => { const node = document.createElement(tag); node.textContent = value; node.className = className; return node }
const date = ts => ts ? new Date(ts).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''
export const dateValue = value => value ? new Date(value).getTime() : null
export function mountCompanion({invoke, initial, showError, onTasks}) {
  let current = initial
  let tab = 'chat'
  const header = document.querySelector('.panel-header')
  const tasks = document.createElement('div'); tasks.id = 'view-tasks'
  const form = $('task-form'), result = document.querySelector('.tasks-section') || $('task-history').closest('section')
  form.before(tasks); tasks.append(form, result); tasks.hidden = true
  const nav = document.createElement('nav'); nav.className = 'companion-nav'; nav.setAttribute('aria-label','控制面板')
  header.after(nav)
  const host = document.createElement('div'); nav.after(host)
  const tabs = [['chat','聊天'],['todos','待办'],['goals','目标'],['tasks','任务'],['growth','成长'],['activity','动态'],['settings','设置']]
  for (const [name, label] of tabs) {
    const button = text('button',label); button.type='button'; button.dataset.tab=name
    button.addEventListener('click',()=>select(name)); nav.append(button)
  }
  host.innerHTML = `
    <section id="view-chat" class="companion-view">
      <div id="chat-messages" class="chat-messages" aria-live="polite"></div><p id="chat-live" role="status"></p>
      <form id="chat-form" class="chat-compose"><label for="chat-text">和大小姐说点什么</label><textarea id="chat-text" required maxlength="20000" placeholder="聊聊今天，或者交给我一件事…"></textarea><div class="compose-footer"><button id="chat-new" type="button">新对话</button><button class="primary">发送 ↗</button></div></form>
      <div class="quick-actions"><button id="look-open" type="button">看看我在做什么</button><button id="note-open" type="button">贴便签</button><button id="prank-dance" type="button">跳支舞</button></div>
      <details id="look-controls"><summary>选择观察窗口</summary><p class="muted">选中窗口的画面会交给当前 Codex 模型理解，不读取其他窗口。</p><div class="workspace-row"><select id="look-window" aria-label="观察窗口"></select><button id="look-refresh" type="button">刷新窗口</button><button id="look-now" type="button">看一下</button></div><p id="look-state" role="status"></p></details>
    </section>
    <section id="view-todos" class="companion-view" hidden>
      <h2>待办</h2><form id="todo-form" class="inline-compose"><input id="todo-text" aria-label="待办内容" required maxlength="2000" placeholder="记下一件事"><input id="todo-due" type="datetime-local" aria-label="截止时间"><button class="primary">添加</button></form><div id="todo-list" class="item-list"></div>
      <h2>提醒</h2><form id="reminder-form" class="inline-compose"><input id="reminder-text" aria-label="提醒内容" required placeholder="提醒我…"><input id="reminder-at" type="datetime-local" aria-label="提醒时间" required><select id="reminder-repeat" aria-label="重复"><option value="">仅一次</option><option value="daily">每天</option></select><button>设提醒</button></form><div id="reminder-list" class="item-list"></div>
      <h2>专注一会儿</h2><div class="quick-actions"><input id="pomo-minutes" type="number" min="1" max="180" value="25" aria-label="专注分钟"><button id="pomo-start">开始专注</button><button id="pomo-stop">结束</button><span id="pomo-state" role="status"></span></div>
    </section>
    <section id="view-goals" class="companion-view" hidden>
      <h2>持续推进的目标</h2><form id="goal-form" class="stack-form"><input id="goal-title" aria-label="目标" required placeholder="想持续推进什么？"><textarea id="goal-detail" aria-label="目标标准" placeholder="做到什么程度，哪些事情需要先问你？"></textarea><div class="workspace-row"><select id="goal-every" aria-label="跟进频率"><option value="daily">每天</option><option value="3h">每 3 小时</option><option value="hourly">每小时</option></select><input id="goal-at" type="time" value="09:00" aria-label="每日跟进时间"><button class="primary">添加目标</button></div></form><div id="goal-list" class="item-list"></div>
    </section>
    <section id="view-growth" class="companion-view" hidden><h2 id="growth-level"></h2><h3>记住的事</h3><form id="memory-form" class="workspace-row"><input id="memory-text" aria-label="长期记忆" required placeholder="希望大小姐记住的偏好"><button>记住</button></form><div id="memory-list" class="item-list"></div><h3>成长笔记</h3><div id="growth-notes"></div><h3>日记</h3><div id="growth-diary"></div></section>
    <section id="view-activity" class="companion-view" hidden><h2>最近的动态</h2><div id="activity-list" class="item-list"></div></section>
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
      <h2>AI 与工作目录</h2><form id="companion-settings" class="stack-form"><label>Codex 可执行文件<input id="companion-codex" placeholder="自动查找"></label><label>模型<input id="companion-model" placeholder="使用 Codex 默认模型"></label><label>观察模型<input id="companion-glance-model" placeholder="与聊天相同"></label><label>工作目录<input id="companion-cwd" placeholder="未设置时只在独立工作目录中运行"></label><label>任务权限<select id="companion-permission"><option value="read-only">只读</option><option value="workspace-write">工作区可写</option></select></label><div class="settings-grid"><label>安静开始<input id="quiet-start" type="time"></label><label>安静结束<input id="quiet-end" type="time"></label></div><button class="primary">保存</button><span id="companion-saved" role="status"></span></form>
    </section>`
  const call = async (command,args={}) => {const result=await invoke('companion_command',{command,args});showError('');return result}
  const bind = (id,work) => $(id).addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;try{await work()}catch(e){showError(e)}finally{button.disabled=false}})
  const submit=(id,work)=>$(id).addEventListener('submit',async e=>{e.preventDefault();const button=e.target.querySelector('button.primary,button:not([type="button"])');if(button)button.disabled=true;try{await work()}catch(error){showError(error)}finally{if(button)button.disabled=false}})
  submit('chat-form', async()=>{await call('chat:send',{text:$('chat-text').value.trim()});$('chat-text').value=''})
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
  submit('companion-settings',async()=>{await call('settings:set',{codexExe:$('companion-codex').value.trim(),codexModel:$('companion-model').value.trim(),codexGlanceModel:$('companion-glance-model').value.trim(),cwd:$('companion-cwd').value.trim(),permission:$('companion-permission').value,quietStart:$('quiet-start').value,quietEnd:$('quiet-end').value});$('companion-saved').textContent='已保存'})
  function button(label,command,args) {const n=text('button',label);n.type='button';n.addEventListener('click',()=>call(command,args).catch(showError));return n}
  function list(id,items,render){$(id).replaceChildren(...items.map(render))}
  function row(title,meta=''){const n=text('div','', 'companion-item');const body=text('div','');body.append(text('p',title),text('small',meta));n.append(body);return n}
  function render() {
    const d=current.data
    list('chat-messages',d.chat.messages.slice(-100),m=>text('div',m.text,`chat-message ${m.role}`))
    list('todo-list',d.todos,t=>{const n=row(t.text,t.done?'已完成':date(t.due));const check=document.createElement('input');check.type='checkbox';check.checked=!!t.done;check.setAttribute('aria-label',`完成 ${t.text}`);check.addEventListener('change',()=>call('todo:update',{id:t.id,patch:{done:check.checked}}).catch(showError));n.prepend(check);n.append(button('移除','todo:remove',{id:t.id}));return n})
    list('reminder-list',d.reminders.filter(r=>!r.fired),r=>{const n=row(r.text,date(r.at));n.append(button('移除','reminder:remove',{id:r.id}));return n})
    list('goal-list',d.goals,g=>{const n=row(g.title,`${g.status==='active'?'进行中':'已暂停'} · 下次 ${date(g.nextAt)}`);const controls=text('div','', 'quick-actions');controls.append(button('推进一步','goal:run',{id:g.id}),button(g.status==='active'?'暂停':'继续','goal:update',{id:g.id,patch:{status:g.status==='active'?'paused':'active'}}),button('移除','goal:remove',{id:g.id}));const logs=text('div','', 'goal-log');for(const l of (g.log||[]).slice(-3))logs.append(text('p',`${date(l.ts)} ${l.text}`));n.append(controls,logs);return n})
    list('memory-list',d.memories,m=>{const n=row(m.text);n.append(button('忘记','memory:remove',{id:m.id}));return n})
    $('growth-level').textContent=`Lv.${d.growth.level||1} · ${d.growth.xp||0} XP`
    $('growth-notes').replaceChildren(...(d.growth.notes||[]).map(n=>text('p',typeof n==='string'?n:n.text||'')))
    $('growth-diary').replaceChildren(...(d.growth.diary||[]).slice(-10).map(n=>text('p',typeof n==='string'?n:`${n.day||''} ${n.text||''}`)))
    list('activity-list',d.activity.slice(0,100),a=>row(a.text,date(a.ts)))
    $('pomo-state').textContent=d.pomodoro.until>Date.now()?`专注至 ${date(d.pomodoro.until)}`:'尚未开始'
    const o=current.observer, conf=d.observation
    $('observer-state').textContent=conf.pausedUntil>Date.now()?`暂停至 ${date(conf.pausedUntil)}`:o.error||(!o.permission?'尚未授予屏幕访问权限':conf.enabled?'已开启 · 安静运行':'未开启')
  }
  function fill() {const d=current.data,s=d.settings,o=d.observation
    $('observe-enabled').checked=!!o.enabled;$('observe-consent').checked=o.consentVersion===1;$('observe-interval').value=o.intervalSeconds;$('observe-max').value=o.maxPerHour;$('observe-exclude').value=o.excludeApps
    for(const [id,key]of [['companion-codex','codexExe'],['companion-model','codexModel'],['companion-glance-model','codexGlanceModel'],['companion-cwd','cwd'],['companion-permission','permission'],['quiet-start','quietStart'],['quiet-end','quietEnd']])$(id).value=s[key]||''
  }
  function select(name) {tab=name;for(const [n]of tabs){const node=$(`view-${n}`);node.hidden=n!==name;nav.querySelector(`[data-tab="${n}"]`).setAttribute('aria-current',String(n===name))}if(name==='settings')fill();render()}
  fill();select(tab)
  return { update(value){current=value;render()}, select, taskUpdated(tasks){const task=tasks.find(t=>t.id===current.chatTask);$('chat-live').textContent=task ? task.output||task.activity : ''} }
}
