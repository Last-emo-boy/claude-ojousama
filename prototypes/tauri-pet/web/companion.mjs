import { desktopPayload, desktopStatus, clipboardWatchPayload, clipboardWatchStatus } from './desktop-entry.mjs'
import { observationPayload, observationStatus, observationPermissions } from './observation.mjs'
import { habitPayload, moodLabel } from './behavior.mjs'
import { agendaPayload, agendaStatus, backgroundLabel, backgroundText } from './agenda.mjs'
import { watchPayload, fileGroups, watchStatus } from './files.mjs'
const $=id=>document.getElementById(id)
const text=(tag,value,className='')=>{const n=document.createElement(tag);n.textContent=value;n.className=className;return n}
const date=ts=>ts?new Date(ts).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):''
export const dateValue=value=>value?new Date(value).getTime():null
const filters=[['activity','动态'],['chat','对话'],['tasks','任务'],['todos','提醒'],['goals','目标'],['files','文件'],['growth','成长']]
export function mountCompanion({invoke,initial,showError,platform}){
  let current=initial, tab='records', filter='activity', desktopValue=null
  const header=document.querySelector('.panel-header'), tasks=$('task-history').closest('section')
  tasks.id='view-tasks'
  const sidebar=document.createElement('aside');sidebar.className='companion-sidebar'
  const brand=header.querySelector('.brand');brand.querySelector('h1').textContent='大小姐';brand.querySelector('.brand-mark').textContent='✿'
  const nav=document.createElement('nav');nav.className='companion-nav';nav.setAttribute('aria-label','控制面板')
  sidebar.append(brand,nav)
  for(const [name,label]of [['records','记录'],['settings','设置']]){
    const b=text('button',label);b.type='button';b.dataset.tab=name;b.addEventListener('click',()=>select(name));nav.append(b)
  }
  const main=document.createElement('main');main.className='companion-main'
  const title=document.createElement('div');title.className='panel-title';title.innerHTML='<h2 id="companion-title">一起做过的事</h2>'
  header.prepend(title)
  const records=document.createElement('section');records.id='view-records';records.className='companion-view'
  records.innerHTML='<nav id="record-filters" class="record-filters" aria-label="记录类型"></nav><div id="record-items" class="record-items"></div>'
  for(const [name,label]of filters){const b=text('button',label);b.type='button';b.dataset.filter=name;b.addEventListener('click',()=>{filter=name;render()});records.querySelector('nav').append(b)}
  const preferences=document.createElement('section');preferences.id='view-settings';preferences.className='companion-view';preferences.hidden=true
  preferences.innerHTML=`<details class="agenda-preferences"><summary>桌面活动</summary><form id="motion-preferences" class="motion-preferences"><label class="check-row"><input id="motion-wander" type="checkbox">自主走动</label><label class="check-row"><input id="motion-windows" type="checkbox">自动爬窗</label><label class="check-row"><input id="motion-cross" type="checkbox">允许跨屏</label><label class="check-row"><input id="motion-fullscreen" type="checkbox">全屏时隐藏</label><button type="submit">保存偏好</button><p id="motion-preferences-state" role="status"></p></form></details><details class="agenda-preferences"><summary>自动安排</summary><form id="agenda-form" class="stack-form"><label class="check-row"><input id="agenda-enabled" type="checkbox">自动准备简报、整理记忆和小技巧</label><label class="check-row"><input id="agenda-morning" type="checkbox">早上准备今日简报</label><label class="check-row"><input id="agenda-workspace" type="checkbox">离开时整理工作区状态</label><div class="settings-grid"><label>每天最多尝试<input id="agenda-limit" type="number" min="0" max="30" step="1" required></label><label>定时小结<input id="agenda-summary-time" type="time"></label></div><p class="setting-help">次数包含手动任务和小结，0 为关闭；小结时间留空即关闭。</p><p class="setting-help">使用已配置的 AI 后端和账户额度；不读取屏幕或剪贴板。巡检只查看已配置工作目录的 Git 状态。</p><button class="primary">保存日程设置</button><p id="agenda-saved" role="status"></p></form></details><details class="agenda-preferences"><summary>照顾新文件</summary><form id="watch-form" class="stack-form"><label class="check-row"><input id="watch-enabled" type="checkbox">发现文件夹里的新文件</label><label>关注目录<textarea id="watch-folders" placeholder="留空使用系统下载目录；多个目录一行一个"></textarea></label><button id="watch-choose" type="button">添加文件夹</button><label>发现之后<select id="watch-mode"><option value="ask">在气泡里问我</option><option value="auto">自动按类型整理</option><option value="off">不再提议整理</option></select></label><p class="setting-help">首次只记住现有文件；新文件稳定 45 秒后才处理。不读取文件内容，不调用 AI。</p><p class="setting-help">首次开启或扩大范围时确认，仅移动新文件到同目录的分类文件夹，不覆盖已有文件。</p><button class="primary">保存文件夹设置</button><p id="watch-saved" role="status"></p></form></details>
      <h2>日常陪伴</h2><form id="habits-form" class="stack-form"><label class="check-row"><input id="habit-idle" type="checkbox">闲时做点小动作，离开时打个盹</label><label class="check-row"><input id="habit-proactive" type="checkbox">喝水提醒和偶尔的小惊喜</label><label class="check-row"><input id="habit-focus" type="checkbox">专注计时中不打扰</label><div class="settings-grid"><label>活跃程度<select id="habit-autonomy"><option value="quiet">安静</option><option value="normal">适中</option><option value="active">活泼</option></select></label><label>小惊喜<select id="habit-mischief"><option value="0">关闭</option><option value="1">偶尔</option><option value="2">适中</option><option value="3">经常</option></select></label></div><label>喝水提醒间隔（分钟）<input id="habit-water" type="number" min="0" max="600" step="1" required></label><p class="setting-help">0 为关闭；只累计你使用电脑的时间。日常动作在本机运行，不调用 AI。</p><button class="primary">保存陪伴设置</button><p id="habits-state" role="status"></p></form>
      <h2>桌面入口</h2><form id="desktop-entry-form" class="stack-form"><label class="check-row"><input id="desktop-autostart" type="checkbox" disabled>登录后启动</label><p class="setting-help">安装到固定位置后再开启。</p><label>剪贴板快捷键<input id="desktop-hotkey" placeholder="CommandOrControl+Alt+Q" spellcheck="false"></label><p class="setting-help">留空关闭。快捷键只打开文字预览，不会自动发送给 AI。</p><div class="quick-actions"><button class="primary">保存桌面设置</button><button id="desktop-refresh" type="button">刷新状态</button></div><p id="desktop-state" role="status"></p></form>
      <form id="clipboard-watch-form" class="stack-form"><label class="check-row"><input id="clipboard-watch-enabled" type="checkbox">复制报错、代码或英文时，问问是否需要帮忙</label><p class="setting-help">后台读取剪贴板文字，仅在本机识别，不保存历史。选择操作后先带入草稿，不会自动发送给 AI。</p><button id="clipboard-watch-save" type="submit">保存剪贴板设置</button><p id="clipboard-watch-state" role="status"></p></form>
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
      <h2>AI 与工作目录</h2><form id="companion-settings" class="stack-form"><label>聊天与任务后端<select id="companion-backend"><option value="codex">Codex</option><option value="dsh">DeepSeek Harness（Windows 兼容）</option></select></label><details><summary>DSH 兼容设置</summary><label>DSH 可执行文件<input id="companion-dsh" placeholder="自动查找"></label><label>Profile<input id="companion-profile" placeholder="desktop"></label><label>Provider<input id="companion-provider" placeholder="继承原配置"></label><label>DSH 模型<input id="companion-dsh-model" placeholder="继承原配置"></label></details><label>Codex 可执行文件<input id="companion-codex" placeholder="自动查找"></label><label>模型<input id="companion-model" placeholder="使用 Codex 默认模型"></label><label>观察模型<input id="companion-glance-model" placeholder="与聊天相同"></label><label>工作目录<input id="companion-cwd" placeholder="未设置时只在独立工作目录中运行"></label><button id="companion-cwd-choose" type="button">选择工作目录</button><label>任务权限<select id="companion-permission"><option value="read-only">只读</option><option value="workspace-write">工作区可写</option><option value="danger-full-access">完全访问（谨慎）</option></select></label><label>再次提醒间隔（分钟）<input id="nag-minutes" type="number" min="0" max="1440" required value="5"></label><p class="setting-help">0 为不重复；最多弹出 3 次，未处理内容留在待办。</p><div class="settings-grid"><label>安静开始<input id="quiet-start" type="time"></label><label>安静结束<input id="quiet-end" type="time"></label></div><button class="primary">保存</button><span id="companion-saved" role="status"></span></form><h2>天气与更新</h2><form id="weather-form" class="workspace-row"><input id="weather-city" aria-label="所在城市" placeholder="城市留空时不查询天气"><button>查天气</button></form><p id="weather-state" role="status"></p><button id="update-check" type="button">检查更新</button><p id="update-state" role="status"></p>`
  main.append(header,$('panel-error'),records,preferences,document.querySelector('.panel-footnote'))
  document.querySelector('#app').prepend(sidebar,main)
  records.append(tasks)
  const call=async(command,args={})=>{const v=await invoke('companion_command',{command,args});showError('');return v}
  const bind=(id,work)=>$(id).addEventListener('click',async event=>{const b=event.currentTarget;b.disabled=true;try{await work()}catch(e){showError(e)}finally{b.disabled=false}})
  const submit=(id,work)=>$(id).addEventListener('submit',async event=>{event.preventDefault();const b=event.target.querySelector('button.primary,button:not([type="button"])');if(b)b.disabled=true;try{await work()}catch(e){showError(e)}finally{if(b)b.disabled=false}})
  const refreshDesktop=async()=>{
    desktopValue=await invoke('desktop_status')
    $('desktop-autostart').disabled=typeof desktopValue.autoStart!=='boolean'
    $('desktop-autostart').checked=desktopValue.autoStart===true
    $('desktop-hotkey').disabled=!desktopValue.shortcutSupported
    $('desktop-state').textContent=desktopStatus(desktopValue,platform)
  }
  bind('desktop-refresh',refreshDesktop)
  submit('clipboard-watch-form',async()=>{await call('settings:set',clipboardWatchPayload($('clipboard-watch-enabled').checked))})
  submit('desktop-entry-form',async()=>{
    if(!desktopValue)throw new Error('请先刷新桌面状态')
    try {await call('settings:set',desktopPayload({hotkey:$('desktop-hotkey').value,autoStart:$('desktop-autostart').disabled?null:$('desktop-autostart').checked,shortcutSupported:desktopValue.shortcutSupported}))}
    finally {await refreshDesktop()}
  })
  submit('habits-form',async()=>{await call('settings:set',habitPayload({idleActions:$('habit-idle').checked,proactive:$('habit-proactive').checked,focusGuard:$('habit-focus').checked,autonomy:$('habit-autonomy').value,mischief:$('habit-mischief').value,waterMinutes:$('habit-water').value}));$('habits-state').textContent='已保存'})
  submit('agenda-form',async()=>{await call('settings:set',agendaPayload(current.data.settings,{enabled:$('agenda-enabled').checked,morningBrief:$('agenda-morning').checked,workspacePulse:$('agenda-workspace').checked,agendaPerDay:Number($('agenda-limit').value),summaryTime:$('agenda-summary-time').value}));$('agenda-saved').textContent='日程设置已保存'})
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
  bind('companion-cwd-choose',async()=>{const path=await invoke('choose_workspace');if(path)$('companion-cwd').value=path})
  bind('watch-choose',async()=>{const path=await invoke('choose_folder');if(path)$('watch-folders').value=[$('watch-folders').value.trim(),path].filter(Boolean).join('\n')})
  submit('watch-form',async()=>{await call('watch:set',watchPayload({enabled:$('watch-enabled').checked,folders:$('watch-folders').value,mode:$('watch-mode').value}));$('watch-saved').textContent='已保存；从新的文件基线开始发现。'})
  submit('weather-form',async()=>{await call('settings:set',{weatherCity:$('weather-city').value.trim()});await call('weather:refresh')})
  bind('update-check',async()=>{const value=await call('update:check');$('update-state').textContent=value?`最新发布：${value.version}`:'暂时没有新发布'})
  if(!['windows','win32'].includes(platform))$('companion-backend').querySelector('[value="dsh"]').disabled=true
  submit('motion-preferences',async()=>{await call('settings:set',{wander:$('motion-wander').checked,climbWindows:$('motion-windows').checked,crossScreens:$('motion-cross').checked,hideOnFullscreen:$('motion-fullscreen').checked});$('motion-preferences-state').textContent='桌面活动偏好已保存'})
  function fill() {const d=current.data,s=d.settings,o=d.observation
    $('watch-enabled').checked=d.watch?.native?.enabled===true && d.watch.native.consentVersion===1;$('watch-folders').value=(s.watchFolders||[]).join('\n');$('watch-mode').value=s.rules?.tidy||'ask'
    $('agenda-enabled').checked=s.rules?.agenda!=='off';$('agenda-morning').checked=s.morningBrief!==false;$('agenda-workspace').checked=s.workspacePulse!==false;$('agenda-limit').value=s.agendaPerDay??6;$('agenda-summary-time').value=s.summaryTime||''
    $('clipboard-watch-enabled').checked=s.clipboardWatch===true && s.clipboardWatchConsent===1
    for(const [id,key]of [['habit-idle','idleActions'],['habit-proactive','proactive'],['habit-focus','focusGuard']])$(id).checked=s[key]!==false
    $('habit-autonomy').value=s.autonomy||'active';$('habit-mischief').value=s.mischief??2;$('habit-water').value=s.waterMinutes??60
    $('weather-city').value=s.weatherCity||''
    $('nag-minutes').value=s.nagMinutes??5
    $('desktop-hotkey').value=s.hotkey||''
    for(const [id,key]of [['motion-wander','wander'],['motion-windows','climbWindows'],['motion-cross','crossScreens'],['motion-fullscreen','hideOnFullscreen']])$(id).checked=s[key]!==false
    $('observe-enabled').checked=!!o.enabled;$('observe-text').checked=!!o.accessibility;$('observe-consent').checked=o.accessibility?o.consentVersion===2:[1,2].includes(o.consentVersion);$('observe-interval').value=o.intervalSeconds;$('observe-max').value=o.maxPerHour;$('observe-exclude').value=o.excludeApps
    for(const [id,key]of [['companion-backend','backend'],['companion-dsh','dshExe'],['companion-profile','sourceProfile'],['companion-provider','provider'],['companion-dsh-model','model'],['companion-codex','codexExe'],['companion-model','codexModel'],['companion-glance-model','codexGlanceModel'],['companion-cwd','cwd'],['companion-permission','permission'],['quiet-start','quietStart'],['quiet-end','quietEnd']])$(id).value=s[key]||''
  }

  function button(label,command,args){const b=text('button',label);b.type='button';b.addEventListener('click',async()=>{b.disabled=true;try{await call(command,args)}catch(e){showError(e)}finally{b.disabled=false}});return b}
  function row(title,meta='',body=''){const n=text('article','','record-row');n.append(text('p',title,'record-title'));if(meta)n.append(text('small',meta));if(body)n.append(text('p',body,'record-body'));return n}
  function render(){
    const d=current.data, list=$('record-items');list.replaceChildren();tasks.hidden=filter!=='tasks'
    for(const b of $('record-filters').children)b.setAttribute('aria-current',String(b.dataset.filter===filter))
    if(filter==='activity'){
      for(const t of d.backgroundTasks||[]){const n=row(backgroundText(t),`${backgroundLabel(t.kind)} · ${t.automatic?'自动':'手动'} · ${date(t.at)}`);if(t.kind==='summary')n.append(button('打开小结','summary:open',{id:t.id,at:t.at}));list.append(n)}
      for(const a of d.activity||[])list.append(row(a.text,date(a.ts)))
    }else if(filter==='chat'){
      for(const m of (d.chat.messages||[]).slice(-100))list.append(row(m.text,`${m.role==='user'?'你':'大小姐'} · ${date(m.ts)}`))
    }else if(filter==='tasks'){
      for(const t of d.tasks||[]){const n=row(t.title||t.prompt,`${t.status} · ${date(t.startedAt)}`,t.result||t.error);n.append(button('重新开始','legacy:retry',{id:t.id}));list.append(n)}
    }else if(filter==='todos'){
      for(const a of d.alerts||[])list.append(row(a.text,`待处理 · ${date(a.createdAt)}`))
      for(const t of d.todos||[]){const n=row(t.text,t.done?'已完成':date(t.due));n.append(button(t.done?'重新打开':'已完成','todo:update',{id:t.id,patch:{done:!t.done}}),button('移除','todo:remove',{id:t.id}));list.append(n)}
      for(const r of d.reminders||[]){const n=row(r.text,`${date(r.at)}${r.fired?' · 已提醒':''}`);n.append(button('移除','reminder:remove',{id:r.id}));list.append(n)}
    }else if(filter==='goals'){
      for(const g of d.goals||[]){const n=row(g.title,`${({active:'进行中',paused:'已暂停',waiting:'等待回答',done:'已完成'})[g.status]||g.status} · 下次 ${date(g.nextAt)}`,g.detail);n.append(button('推进一步','goal:run',{id:g.id}),button(g.status==='active'?'暂停':'继续','goal:update',{id:g.id,patch:{status:g.status==='active'?'paused':'active'}}),button('移除','goal:remove',{id:g.id}));for(const l of (g.log||[]).slice(-3))n.append(text('p',`${date(l.ts)} ${l.text}`,'record-body'));list.append(n)}
    }else if(filter==='files'){
      for(const g of fileGroups(d.watch?.ready))list.append(row(`${g.files.length} 个新文件`,g.folder,g.files.map(f=>f.name).join('、')))
      if(d.tidyLog?.moves?.length)list.append(button('撤销上次整理','tidy:undo',{}))
      for(const m of d.tidyLog?.moves||[])list.append(row(m.name||m.from,'整理记录',`${m.from} → ${m.to}`))
    }else if(filter==='growth'){
      list.append(row(`Lv.${d.growth.level||1} · ${d.growth.xp||0} XP`,`好感度 ${d.pet.affection||0} · ${moodLabel(d.pet.mood)}`))
      for(const m of d.memories||[]){const n=row(m.text,'记住的事');n.append(button('忘记','memory:remove',{id:m.id}));list.append(n)}
      for(const n of [...(d.growth.notes||[]),...(d.growth.diary||[])])list.append(row(typeof n==='string'?n:n.text,n.day||n.date||''))
    }
    if(!list.childElementCount&&filter!=='tasks')list.append(text('p','这里还没有记录。','empty-state'))
    $('clipboard-watch-state').textContent=clipboardWatchStatus(d.settings,current.clipboard)
    for(const id of ['clipboard-watch-enabled','clipboard-watch-save'])$(id).disabled=current.clipboard?.supported!==true
    $('watch-saved').textContent=watchStatus(d,current.files)
    $('agenda-saved').textContent=agendaStatus(d,current.agenda)
    $('observer-state').textContent=observationStatus(d.observation,current.observer)
    $('observer-permissions').textContent=observationPermissions(current.observer.capabilities)
    $('weather-state').textContent=d.weather?`${d.weather.city} · ${d.weather.desc||''} ${d.weather.temp}°C`:''
  }
  function select(name){
    if(name==='settings'||name==='actions')tab='settings'
    else{tab='records';if(filters.some(([n])=>n===name))filter=name}
    records.hidden=tab!=='records';preferences.hidden=tab!=='settings'
    for(const b of nav.children)b.setAttribute('aria-current',String(b.dataset.tab===tab))
    $('companion-title').textContent=tab==='settings'?'按你的节奏。':'一起做过的事'
    if(tab==='settings'){fill();refreshObservation().catch(showError);refreshDesktop().catch(showError)}
    render()
  }
  fill();select('records')
  return{update(value){current=value;render()},select,taskUpdated(){},motionUpdated(){},previewClipboard(){return invoke('open_pet')}}
}
