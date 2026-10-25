// Evaluate an expression in the running pet's main process via the Node inspector.
// Start the pet with:  electron --inspect=9229 .   (and CLAUDE_PET_DEBUG=1)
// Usage: node tools/cdp.js "<expression>" [port]
const expr = process.argv[2]
const port = process.argv[3] || 9229

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const ws = new WebSocket(list[0].webSocketDebuggerUrl)
  await new Promise((r, j) => {
    ws.onopen = r
    ws.onerror = j
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  const call = (method, params) =>
    new Promise((r) => {
      const i = ++id
      pending.set(i, r)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const res = await call('Runtime.evaluate', {
    expression: `(async () => { return (${expr}) })()`,
    awaitPromise: true,
    returnByValue: true,
    includeCommandLineAPI: true,
  })
  if (res.result && res.result.exceptionDetails) console.log('EXCEPTION', JSON.stringify(res.result.exceptionDetails).slice(0, 1500))
  else console.log(JSON.stringify(res.result && res.result.result && res.result.result.value, null, 1))
  ws.close()
}
main().catch((e) => {
  console.error('cdp error', e.message)
  process.exit(1)
})
