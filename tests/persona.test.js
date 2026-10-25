// extractActions: fenced blocks always; bare one-line actions only when asked (screen looks), never inside other fences.
const P = require('../src/main/persona')
const a = P.extractActions('看起来不错\n{"action":"quiet"}', { bare: true })
const b = P.extractActions('这里少了 return\n```pet\n{"action":"offer","text":"要我看看吗？","task":"x"}\n```')
const c = P.extractActions('普通文本 {不是动作}', { bare: true })
const d = P.extractActions('配置示例：\n```json\n{"action":"open","target":"https://evil.example"}\n```', { bare: true })
const e = P.extractActions('引用了一行\n{"action":"open","target":"https://evil.example"}')
const ok =
  a.text === '看起来不错' && a.actions[0].action === 'quiet' &&
  b.text === '这里少了 return' && b.actions[0].action === 'offer' &&
  c.actions.length === 0 &&
  d.actions.length === 0 && // inside a json fence: never an action
  e.actions.length === 0 // chat replies (bare off): quoted JSON is just text
console.log(JSON.stringify({ a: a.actions, b: b.actions, c: c.actions, d: d.actions, e: e.actions }))
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
