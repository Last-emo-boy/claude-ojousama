const invoke=(command,args)=>window.__TAURI__.core.invoke(command,args)
const app=document.getElementById('app')
app.innerHTML='<header data-tauri-drag-region><strong>今天的小事</strong><button id="note-close" aria-label="关闭便签">×</button></header><div id="note-todos"></div><form id="note-add"><input id="note-text" aria-label="新待办" placeholder="再记一件事…" required><button>＋</button></form><p id="note-error" role="alert"></p>'
const fail=e=>document.getElementById('note-error').textContent=String(e)
function render(data){const box=document.getElementById('note-todos');box.replaceChildren(...data.todos.map(t=>{const label=document.createElement('label');const check=document.createElement('input');check.type='checkbox';check.checked=!!t.done;const name=document.createElement('span');name.textContent=t.text;name.style.textDecoration=t.done?'line-through':'none';check.addEventListener('change',()=>invoke('note_update',{id:t.id,done:check.checked}).catch(fail));label.append(check,name);return label}))}
document.getElementById('note-close').addEventListener('click',()=>invoke('note_toggle').catch(fail))
document.getElementById('note-add').addEventListener('submit',async e=>{e.preventDefault();try{await invoke('note_add',{text:document.getElementById('note-text').value});document.getElementById('note-text').value=''}catch(error){fail(error)}})
await window.__TAURI__.event.listen('companion:update',e=>render(e.payload.data))
render((await invoke('bootstrap')).companion.data)
