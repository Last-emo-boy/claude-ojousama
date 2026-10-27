import test from 'node:test'
import assert from 'node:assert/strict'
import { createBubbleState, bubbleAction } from './bubble.mjs'

const task = (status, pending = null) => ({ id: 1, status, pending, activity: '处理任务' })

test('idle and historical completed tasks never open a bubble on launch', () => {
  const state = createBubbleState()
  assert.equal(state.read(0), null)
  state.task(task('completed'), { snapshot: true, now: 0 })
  assert.equal(state.read(0), null)
})

test('task status briefly appears once; streamed tokens cannot renew its lifetime', () => {
  const state = createBubbleState()
  state.task(task('working'), { now: 0 })
  assert.equal(state.read(1).label, '进行中')
  state.task({ ...task('working'), output: 'more tokens' }, { now: 7900 })
  assert.equal(state.read(8000), null)
  state.task(task('completed'), { now: 9000 })
  assert.equal(state.read(9001).label, '已完成')
  assert.equal(state.read(17000), null)
})

test('pending decisions stay until resolved and cannot leak into a resumed task', () => {
  const state = createBubbleState()
  state.task(task('approval', { id: 'a' }), { snapshot: true, now: 0 })
  state.speak({ text: '我去转转', until: 12000 }, 0)
  assert.equal(state.read(10000).needsAction, true)
  state.task(task('working'), { now: 11000 })
  assert.equal(state.read(11001).source, 'speech')
  assert.equal(state.read(19000), null)
})

test('dismissal is remembered for the current question, not the next one', () => {
  const state = createBubbleState()
  state.task(task('input', { id: 1 }), { now: 0 })
  state.dismiss(1)
  state.task(task('input', { id: 1 }), { now: 2 })
  assert.equal(state.read(3), null)
  state.task(task('input', { id: 2 }), { now: 4 })
  assert.equal(state.read(5).needsAction, true)
})

test('speech expires, errors are bounded and animation-only actions stay silent', () => {
  const state = createBubbleState()
  state.speak({ text: '读完啦', until: 1000 }, 0)
  assert.equal(state.read(999).text, '读完啦')
  assert.equal(state.read(1000), null)
  state.speak({ text: '', animation: 'stretch', until: 10000 }, 1000)
  assert.equal(state.read(1001), null)
  state.error('真实错误', 2000)
  assert.equal(state.read(2001).source, 'error')
  assert.equal(state.read(14000), null)
})

test('closing the visible bubble does not reveal an older notice underneath it', () => {
  const state = createBubbleState()
  state.task(task('completed'), { now: 0 })
  state.speak({ text: '说句话', until: 12000 }, 100)
  state.error('真实错误', 200)
  state.dismiss()
  assert.equal(state.read(201), null)
})

test('an animation-only event cannot erase or extend an existing spoken sentence', () => {
  const state = createBubbleState()
  state.speak({ text: '任务做好了', until: 12000 }, 0)
  state.speak({ text: '', animation: 'shy', until: 7000 }, 3000)
  assert.equal(state.read(3001).text, '任务做好了')
  assert.equal(state.read(11999).text, '任务做好了')
  assert.equal(state.read(12000), null)
})


test('actionable reminders expire, outrank casual speech, but yield to a task approval', () => {
  const state=createBubbleState()
  state.alert({id:'a',token:1,text:'休息一下',buttons:[{id:'ok',label:'知道了'}],until:30000},0)
  state.speak({text:'随便说说',until:10000},0)
  assert.equal(state.read(1).source,'alert')
  assert.equal(state.read(1).buttons[0].id,'ok')
  state.task(task('approval',{id:'decision'}),{now:2})
  assert.equal(state.read(3).source,'task')
  state.task(task('completed'),{now:1000})
  assert.equal(state.read(1001).source,'alert')
  assert.equal(state.read(30000),null)
})
test('a dismissed reminder is not reopened by the same delivery token', () => {
  const state=createBubbleState()
  const alert={id:'a',token:1,text:'提醒',until:30000}
  state.alert(alert,0);state.dismiss();state.alert(alert,100)
  assert.equal(state.read(101),null)
  state.alert({...alert,token:2,until:40000},1000)
  assert.equal(state.read(1001).source,'alert')
  state.clearAlert('other');assert.equal(state.read(1002).source,'alert')
  state.alert({clear:'a'},1003);assert.equal(state.read(1004),null)
})

test('an old clear event cannot dismiss a newer delivery and acknowledgement clears old chatter', () => {
  const state=createBubbleState()
  state.alert({id:'a',token:1,text:'提醒',until:30000},0)
  state.alert({id:'a',token:2,text:'再提醒',until:30000},1)
  state.alert({clear:'a',token:1},2)
  assert.equal(state.read(3).token,2)
  state.speak({text:'旧闲聊',until:10000},3)
  state.clearAlert('a')
  assert.equal(state.read(4),null)
})

test('clipboard offers are finite, dismissible, and never displace decisions or actual speech', () => {
  const state=createBubbleState()
  const offer={token:1,text:'需要翻译吗？',until:20000,buttons:[{id:'translate',label:'翻译…'}]}
  state.clipboard(offer,0);assert.equal(state.read(1).source,'clipboard')
  state.speak({text:'刚才任务的结果',until:1000},2);assert.equal(state.read(3).source,'speech')
  state.task(task('approval',{id:'decision'}),{now:1001});assert.equal(state.read(1002).needsAction,true)
  state.dismiss();state.clipboard(offer,1003);assert.equal(state.read(1004),null)
  state.clipboard({...offer,token:2},1005);state.clipboard({clear:1},1006)
  assert.equal(state.read(1007).source,'clipboard');assert.equal(state.read(20000),null)
  state.alert({id:'a',token:1,text:'提醒',until:30000},21000)
  state.clipboard({clear:2},21001);assert.equal(state.read(21002).source,'alert')
})

test('bubble actions reach the current intent, not the last panel tab', () => {
  assert.deepEqual(bubbleAction(null),{command:'show_panel',args:{tab:'chat'},label:'聊两句'})
  assert.deepEqual(bubbleAction({source:'task',taskId:7}),{command:'show_panel',args:{tab:'tasks',taskId:7},label:'查看任务'})
  assert.equal(bubbleAction({source:'alert'}).args.tab,'todos')
  assert.deepEqual(bubbleAction({source:'clipboard',token:9}),{command:'clipboard_offer_open',args:{token:9,action:'preview'},label:'看看文字'})
  for(const [tab,label]of [['goals','查看目标'],['growth','看看成长'],['activity','查看动态'],['files','看看文件']]) {
    const state=createBubbleState();state.speak({text:'有新结果',tab,until:12000},0)
    assert.equal(bubbleAction(state.read(1)).args.tab,tab)
    assert.equal(bubbleAction(state.read(1)).label,label)
    assert.equal(state.read(12000),null)
  }
})

test('old speech still opens chat and unexpected destinations cannot replace fixed task or alert routes', () => {
  const state=createBubbleState();state.speak({text:'聊两句',until:12000},0)
  assert.equal(bubbleAction(state.read(1)).args.tab,'chat')
  assert.equal(bubbleAction({source:'speech',tab:'https://example.com'}).args.tab,'chat')
  assert.equal(bubbleAction({source:'speech',tab:'toString'}).args.tab,'chat')
  assert.equal(bubbleAction({source:'task',taskId:7,tab:'goals'}).args.tab,'tasks')
  assert.equal(bubbleAction({source:'alert',tab:'chat'}).args.tab,'todos')
})
