'use strict'
const assert = require('assert/strict')
const { EventEmitter, once } = require('events')
const { PassThrough, Writable } = require('stream')
const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { CodexRun, locateCodex } = require('../src/main/codex')

const cases = []
const test = (name, fn) => cases.push({ name, fn })
const tick = () => new Promise((resolve) => setImmediate(resolve))

function fakeServer(options = {}, handlers = {}) {
  const requests = [], events = []
  let spawned
  const child = new EventEmitter()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.killed = false
  child.kill = () => { child.killed = true; child.exitCode = 1; child.emit('close', 1) }
  const send = (message) => child.stdout.write(JSON.stringify(message) + '\n')
  child.stdin = new Writable({
    write(chunk, _, callback) {
      const message = JSON.parse(chunk.toString())
      requests.push(message)
      callback()
      if (message.method) queueMicrotask(() => {
        if (handlers[message.method]) handlers[message.method](message, send)
        else if (message.id !== undefined) {
          const result = message.method === 'config/read' ? { config: { mcp_servers: { dangerous: { enabled: true }, 'with.dot': { enabled: true } } } }
            : message.method.startsWith('thread/') ? { thread: { id: options.sessionId || 'thread-1' } }
              : message.method === 'turn/start' ? { turn: { id: 'turn-1', status: 'inProgress' } } : {}
          send({ id: message.id, result })
        }
      })
    },
    final(callback) { child.exitCode = 0; child.emit('close', 0); callback() },
  })
  const run = new CodexRun({ codex: { exe: '/fake/codex', args: [] }, prompt: 'hello', persona: 'pet persona', cwd: os.tmpdir(), ...options }, {
    spawnProcess(exe, args, opts) { spawned = { exe, args, opts: { cwd: opts.cwd, shell: opts.shell, windowsHide: opts.windowsHide } }; return child },
  })
  run.on('event', (event) => events.push(event))
  const done = once(run, 'done').then(([result]) => result)
  const ready = async () => { for (let i = 0; i < 10 && !requests.some((r) => r.method === 'turn/start'); i++) await tick() }
  return { run, child, requests, events, send, done, ready, spawned: () => spawned }
}

function complete(server, text = 'done') {
  server.send({ method: 'item/completed', params: { threadId: server.run.sessionId, item: { id: 'final', type: 'agentMessage', phase: 'final_answer', text } } })
  server.send({ method: 'turn/completed', params: { threadId: server.run.sessionId, turn: { id: 'turn-1', status: 'completed' } } })
}

test('handshake precedes thread and turn; full permissions and persona are explicit', async () => {
  const s = fakeServer({ permission: 'workspace-write', model: 'chosen-model', reasoningEffort: 'low' })
  await s.ready()
  assert.deepEqual(s.requests.filter((r) => r.method).map((r) => r.method), ['initialize', 'initialized', 'thread/start', 'turn/start'])
  const thread = s.requests.find((r) => r.method === 'thread/start').params
  assert.equal(thread.developerInstructions, 'pet persona')
  assert.equal(thread.model, 'chosen-model')
  assert.equal(thread.sandbox, 'workspace-write')
  assert.equal(thread.approvalPolicy, 'on-request')
  assert.equal(s.requests.at(-1).params.effort, 'low')
  assert.equal(s.spawned().opts.shell, false)
  complete(s)
  assert.equal((await s.done).ok, true)
})

test('resume passes the exact thread ID and never falls back to another session', async () => {
  const s = fakeServer({ sessionId: 'existing-thread' })
  await s.ready()
  const request = s.requests.find((r) => r.method === 'thread/resume')
  assert.equal(request.params.threadId, 'existing-thread')
  assert.equal(s.requests.some((r) => r.method === 'thread/start'), false)
  complete(s)
  assert.equal((await s.done).sessionId, 'existing-thread')
})

test('restricted modes disable inherited MCPs and environment access before the turn', async () => {
  for (const tools of ['look', 'scan', 'none']) {
    const s = fakeServer({ tools, scanRoot: '' })
    await s.ready()
    assert.deepEqual(s.requests.filter((r) => r.method).map((r) => r.method), ['initialize', 'initialized', 'config/read', 'thread/start', 'turn/start'])
    const p = s.requests.find((r) => r.method === 'thread/start').params
    assert.equal(p.sandbox, 'read-only')
    assert.equal(p.approvalPolicy, 'never')
    assert.deepEqual(p.environments, [])
    assert.deepEqual(s.requests.at(-1).params.environments, [])
    assert.deepEqual(p.config.mcp_servers, { dangerous: { enabled: false }, 'with.dot': { enabled: false } })
    for (const feature of ['hooks', 'shell_tool', 'view_image', 'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'code_mode', 'artifact', 'workspace_dependencies', 'memories', 'goals']) assert.equal(p.config['features.' + feature], false)
    assert.equal(p.config.web_search, 'disabled')
    assert.equal(p.config.project_doc_max_bytes, 0)
    assert.equal(p.config['skills.include_instructions'], false)
    assert.equal(p.config['features.skip_host_skill_discovery'], true)
    assert.equal(p.dynamicTools, undefined)
    complete(s)
    await s.done
  }
})

test('native screenshot attachments do not require a filesystem tool', async () => {
  const image = path.join(os.tmpdir(), 'screen image.png')
  const s = fakeServer({ tools: 'look', images: [image] })
  await s.ready()
  assert.deepEqual(s.requests.at(-1).params.input, [{ type: 'text', text: 'hello', text_elements: [] }, { type: 'localImage', path: image }])
  complete(s)
  await s.done
})

test('stream events drive text, tools, thinking and final result without mixing threads', async () => {
  const s = fakeServer()
  await s.ready()
  s.send({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } })
  s.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'm', delta: 'Hello ' } })
  s.send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'm', delta: 'world' } })
  s.send({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', itemId: 'm', delta: 'wrong' } })
  s.send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thread-1' } })
  const item = { id: 'cmd', type: 'commandExecution', command: 'git status', status: 'inProgress' }
  s.send({ method: 'item/started', params: { item } })
  s.send({ method: 'item/completed', params: { item: { ...item, status: 'completed' } } })
  complete(s, 'Hello world')
  const result = await s.done
  assert.equal(result.final, 'Hello world')
  assert.equal(s.events.some((e) => e.type === 'text' && e.text === 'Hello worldwrong'), false)
  assert.equal(s.events.some((e) => e.type === 'thinking'), true)
  assert.equal(s.events.some((e) => e.type === 'status' && e.phase === 'turn_start'), true)
  assert.equal(s.events.some((e) => e.type === 'tool_call' && e.tool === 'shell' && e.input.command === 'git status'), true)
  assert.equal(s.events.some((e) => e.type === 'tool_result' && e.status === 'completed'), true)
})

test('approval decisions require explicit user response and are only per request', async () => {
  const s = fakeServer()
  await s.ready()
  s.send({ id: 50, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', itemId: 'cmd', command: 'npm test', cwd: '/workspace' } })
  assert.equal(s.requests.some((r) => r.id === 50), false)
  assert.equal(s.events.at(-1).type, 'approval')
  assert.equal(s.events.at(-1).command, 'npm test')
  assert.equal(s.run.respondApproval(50, 'acceptForSession'), false)
  assert.equal(s.run.respondApproval(50, 'accept'), true)
  assert.deepEqual(s.requests.at(-1), { id: 50, result: { decision: 'accept' } })
  assert.equal(s.run.respondApproval(50, 'accept'), false)
  s.send({ id: 51, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } })
  s.run.respondApproval(51, 'decline')
  assert.deepEqual(s.requests.at(-1).result, { permissions: {}, scope: 'turn' })
  complete(s)
  await s.done
})

test('restricted requests cannot obtain elevated access or unregistered tools', async () => {
  const s = fakeServer({ tools: 'none' })
  await s.ready()
  s.send({ id: 50, method: 'item/commandExecution/requestApproval', params: { command: 'bad' } })
  assert.deepEqual(s.requests.at(-1), { id: 50, result: { decision: 'decline' } })
  s.send({ id: 51, method: 'item/permissions/requestApproval', params: { permissions: { fileSystem: {} } } })
  assert.deepEqual(s.requests.at(-1).result, { permissions: {}, scope: 'turn' })
  s.send({ id: 52, method: 'item/tool/call', params: { threadId: 'thread-1', tool: 'pet_read_file', arguments: { path: 'secret' } } })
  await tick()
  assert.equal(s.requests.find((r) => r.id === 52).result.success, false)
  complete(s)
  await s.done
})

test('full user input preserves questions and returns the exact keyed answer shape', async () => {
  const s = fakeServer()
  await s.ready()
  const questions = [
    { id: 'language', header: 'Language', question: 'Which language?', options: [{ label: '中文', description: 'Chinese output' }] },
    { id: 'name', header: 'Name', question: 'What name?', options: null, isSecret: false },
  ]
  s.send({ id: 60, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'question', isBlocking: true, questions } })
  assert.deepEqual(s.events.at(-1), { type: 'user_input', id: 60, threadId: 'thread-1', turnId: 'turn-1', itemId: 'question', isBlocking: true, questions })
  assert.equal(s.requests.some((r) => r.id === 60), false)
  assert.equal(s.run.respondApproval(60, 'accept'), false)
  assert.equal(s.run.respondUserInput(60, { unknown: { answers: ['x'] } }), false)
  assert.equal(s.run.respondUserInput(60, { language: { answers: '中文' } }), false)
  assert.equal(s.run.respondUserInput(60, { language: { answers: [1] } }), false)
  const answers = { language: { answers: ['中文'] }, name: { answers: ['Ojousama'] } }
  assert.equal(s.run.respondUserInput(60, answers), true)
  assert.deepEqual(s.requests.at(-1), { id: 60, result: { answers } })
  assert.equal(s.run.respondUserInput(60, answers), false)
  complete(s)
  await s.done
})

test('user input cancellation and server resolution do not grant permissions or leave pending requests', async () => {
  const s = fakeServer()
  await s.ready()
  const params = { threadId: 'thread-1', questions: [{ id: 'choice', question: 'Choose', header: 'Choice' }] }
  for (const [id, answers] of [[60, null], [61, {}]]) {
    s.send({ id, method: 'item/tool/requestUserInput', params })
    assert.equal(s.run.respondUserInput(id, answers), true)
    assert.deepEqual(s.requests.at(-1), { id, result: { answers: {} } })
    assert.equal(s.run.userInputs.has(id), false)
  }
  s.send({ id: 62, method: 'item/tool/requestUserInput', params })
  s.send({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 62 } })
  assert.equal(s.run.respondUserInput(62, { choice: { answers: ['A'] } }), false)
  s.send({ id: 63, method: 'mcpServer/elicitation/request', params: { mode: 'form', message: 'External request' } })
  assert.deepEqual(s.requests.at(-1), { id: 63, result: { action: 'decline', content: null } })
  assert.equal(s.events.some((e) => e.type === 'approval'), false)
  complete(s)
  await s.done
})

test('restricted questions are answered empty immediately without user input UI', async () => {
  for (const tools of ['none', 'look', 'scan']) {
    const s = fakeServer({ tools, scanRoot: '' })
    await s.ready()
    s.send({ id: 60, method: 'item/tool/requestUserInput', params: { questions: [{ id: 'q', question: 'Choose', header: 'Choice' }] } })
    assert.deepEqual(s.requests.at(-1), { id: 60, result: { answers: {} } })
    assert.equal(s.events.some((e) => e.type === 'user_input'), false)
    assert.equal(s.run.respondUserInput(60, { q: { answers: ['A'] } }), false)
    complete(s)
    await s.done
  }
})

test('bounded scan reads/searches only its canonical workspace, including symlink boundaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-scan-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-outside-'))
  try {
    fs.writeFileSync(path.join(root, 'a.txt'), 'alpha\nTODO fix me\n')
    fs.writeFileSync(path.join(root, 'binary'), Buffer.from([0, 1, 2]))
    fs.writeFileSync(path.join(root, 'large.txt'), 'x'.repeat(70000))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside secret')
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'))
    fs.symlinkSync(outside, path.join(root, 'escape-dir'), 'dir')
    const s = fakeServer({ tools: 'scan', cwd: root, scanRoot: root })
    await s.ready()
    assert.deepEqual(s.requests.find((r) => r.method === 'thread/start').params.dynamicTools.map((t) => t.name), ['pet_read_file', 'pet_search_files'])
    let id = 100
    async function call(tool, args) {
      const requestId = id++
      s.send({ id: requestId, method: 'item/tool/call', params: { threadId: 'thread-1', tool, arguments: args } })
      for (let i = 0; i < 50; i++) {
        const response = s.requests.find((r) => r.id === requestId)
        if (response) return response.result
        await new Promise((r) => setTimeout(r, 2))
      }
      throw new Error('No scan response')
    }
    const read = await call('pet_read_file', { path: 'a.txt' })
    assert.equal(read.success, true)
    assert.equal(JSON.parse(read.contentItems[0].text).text, 'alpha\nTODO fix me\n')
    const search = await call('pet_search_files', { query: 'TODO' })
    assert.deepEqual(JSON.parse(search.contentItems[0].text).matches, [{ path: 'a.txt', line: 2, text: 'TODO fix me' }])
    for (const file of [path.join(outside, 'secret.txt'), '../' + path.basename(outside) + '/secret.txt', 'escape.txt', 'escape-dir/secret.txt', 'binary']) assert.equal((await call('pet_read_file', { path: file })).success, false)
    assert.equal((await call('pet_search_files', { path: 'escape-dir', query: '' })).success, false)
    const large = JSON.parse((await call('pet_read_file', { path: 'large.txt' })).contentItems[0].text)
    assert.equal(Buffer.byteLength(large.text), 65536)
    assert.equal(large.truncated, true)
    assert.equal((await call('shell', { command: 'bad' })).success, false)
    complete(s)
    await s.done
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('turn failure and protocol errors are not reported as successful process exits', async () => {
  const failed = fakeServer()
  await failed.ready()
  failed.send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'model unavailable' } } } })
  assert.equal((await failed.done).error, 'model unavailable')
  const malformed = fakeServer()
  await malformed.ready()
  malformed.child.stdout.write('not-json\n')
  assert.match((await malformed.done).error, /malformed JSON/)
  const invalid = fakeServer()
  await invalid.ready()
  invalid.child.stdout.write('[]\n')
  assert.equal((await invalid.done).ok, false)
  const exited = fakeServer()
  await exited.ready()
  exited.child.emit('close', 0)
  assert.equal((await exited.done).ok, false)
})

test('request rejection and spawn errors resolve the run once', async () => {
  const s = fakeServer({}, { initialize: (request, send) => send({ id: request.id, error: { message: 'protocol unsupported' } }) })
  assert.equal((await s.done).error, 'protocol unsupported')
  const spawn = fakeServer({}, { initialize: () => {} })
  await tick()
  spawn.child.emit('error', new Error('spawn failed'))
  assert.equal((await spawn.done).error, 'spawn failed')
})

test('cancellation sends turn interrupt and cannot turn into success', async () => {
  const s = fakeServer()
  await s.ready()
  s.run.kill()
  assert.equal(s.requests.at(-1).method, 'turn/interrupt')
  complete(s)
  const result = await s.done
  assert.equal(result.ok, false)
  assert.equal(result.error, '已取消')
  const early = fakeServer()
  early.run.kill()
  assert.equal((await early.done).ok, false)
  await tick()
  assert.equal(early.spawned() === undefined, true)
  const connecting = fakeServer({}, { initialize: () => {} })
  await tick()
  connecting.run.kill()
  assert.equal((await connecting.done).ok, false)
  connecting.send({ id: 1, result: {} })
  await tick()
  assert.equal(connecting.requests.some((r) => r.method === 'thread/start'), false)
})

test('locator finds executables without using a shell', () => {
  assert.equal(locateCodex('/definitely/not/a/codex'), null)
  const found = locateCodex(process.execPath)
  assert.equal(found.exe, process.execPath)
  assert.deepEqual(found.args, [])
})

test('npm symlink entries use the bundled runtime when GUI PATH has no node', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-codex-npm-'))
  const bin = path.join(root, 'bin')
  const entry = path.join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const link = path.join(bin, process.platform === 'win32' ? 'codex.exe' : 'codex')
  const originalPath = process.env.PATH
  const originals = { existsSync: fs.existsSync, statSync: fs.statSync, realpathSync: fs.realpathSync }
  try {
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.mkdirSync(bin)
    fs.writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("npm entry launched")\n')
    fs.chmodSync(entry, 0o755)
    try { fs.symlinkSync(entry, link, 'file') } catch (e) {
      if (process.platform !== 'win32' || e.code !== 'EPERM') throw e
      // Windows without symlink privilege: exercise the same filesystem responses.
      fs.existsSync = (p) => p === link || originals.existsSync(p)
      fs.statSync = (p) => originals.statSync(p === link ? entry : p)
      fs.realpathSync = (p) => originals.realpathSync(p === link ? entry : p)
    }
    process.env.PATH = bin
    for (const found of [locateCodex(), locateCodex(link)]) {
      assert.equal(found.exe, process.execPath)
      assert.deepEqual(found.args, [originals.realpathSync(entry)])
      assert.equal(found.electronRunAsNode, true)
      assert.equal(found.displayPath, link)
      const result = spawnSync(found.exe, found.args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', shell: false })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0)
      assert.equal(result.stdout.trim(), 'npm entry launched')
    }
  } finally {
    Object.assign(fs, originals)
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    fs.rmSync(root, { recursive: true, force: true })
  }
})

;(async () => {
  let failed = 0
  for (const { name, fn } of cases) {
    try { await fn(); console.log('PASS', name) } catch (e) { failed++; console.error('FAIL', name, e) }
  }
  console.log(`${cases.length - failed}/${cases.length} passed`)
  process.exitCode = failed ? 1 : 0
})()
