'use strict'
// Codex app-server bridge. Each run owns its connection; threads persist in Codex.
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')

/** Item types a restricted (look / scan / none) run must never start. */
const RESTRICTED_FORBIDDEN = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch'])

function locateCodex(override) {
  const candidates = override ? [override] : (process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap((dir) =>
    process.platform === 'win32' ? [path.join(dir, 'codex.exe'), path.join(dir, 'codex.cmd')] : [path.join(dir, 'codex')])
  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue
    const resolved = fs.realpathSync(candidate)
    if (/\.(cmd|bat)$/i.test(resolved)) {
      // Launch the official npm entry directly, never through cmd.exe or a shell.
      const dir = path.dirname(resolved)
      const entries = [path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), path.join(dir, '..', '@openai', 'codex', 'bin', 'codex.js')]
      const entry = entries.find((p) => fs.existsSync(p))
      if (entry) return { exe: process.execPath, args: [entry], electronRunAsNode: true, displayPath: candidate }
      continue
    }
    // npm's Unix bin is a symlink to codex.js. GUI apps may not have node on PATH.
    if (/\.js$/i.test(resolved)) return { exe: process.execPath, args: [resolved], electronRunAsNode: true, displayPath: candidate }
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return { exe: candidate, args: [] }
    } catch (e) {
      if (e.code !== 'EACCES') throw e
    }
  }
  return null
}

const SCAN_TOOLS = [
  { type: 'function', name: 'pet_read_file', description: 'Read a UTF-8 text file inside the configured workspace only. Returns at most 64 KiB. No writes, shell or network.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { type: 'function', name: 'pet_search_files', description: 'Search a literal text string in workspace text files. Empty query lists files. Skips .git, node_modules and symlink directories. Bounded to 500 files and 100 matches.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Optional workspace-relative directory.' } }, required: ['query'], additionalProperties: false } },
]

const within = (root, file) => {
  const rel = path.relative(root, file)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

async function scanPath(root, value = '.') {
  if (typeof value !== 'string') throw new Error('path must be a string')
  const file = await fs.promises.realpath(path.resolve(root, value))
  if (!within(root, file)) throw new Error('Path is outside the configured workspace')
  return file
}

async function readText(file) {
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Not a regular file')
    const buffer = Buffer.alloc(Math.min(stat.size, 65536))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) throw new Error('Not a text file')
    return { text: bytes.toString('utf8'), truncated: stat.size > bytesRead }
  } finally {
    await handle.close()
  }
}

async function scanTool(root, name, args) {
  if (!root) throw new Error('No workspace has been configured for file access')
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments')
  if (name === 'pet_read_file') {
    const file = await scanPath(root, args.path)
    return { path: path.relative(root, file), ...await readText(file) }
  }
  if (name !== 'pet_search_files' || typeof args.query !== 'string' || args.query.length > 1000) throw new Error('Unsupported scan tool or query')
  const start = await scanPath(root, args.path || '.')
  if (!(await fs.promises.stat(start)).isDirectory()) throw new Error('Search path must be a directory')
  const directories = [start], matches = []
  let files = 0, entries = 0
  while (directories.length && files < 500 && entries < 5000 && matches.length < 100) {
    const dir = await scanPath(root, directories.shift())
    for await (const entry of await fs.promises.opendir(dir)) {
      if (++entries > 5000 || files >= 500 || matches.length >= 100) break
      const file = path.join(dir, entry.name)
      if (entry.isDirectory() && !['.git', 'node_modules'].includes(entry.name)) directories.push(file)
      else if (entry.isFile()) {
        files++
        const relative = path.relative(root, file)
        if (!args.query) matches.push({ path: relative })
        else {
          let content
          try { content = await readText(await scanPath(root, file)) } catch (e) {
            if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(e.code) || e.message === 'Not a text file') continue
            throw e
          }
          const lines = content.text.split(/\r?\n/)
          for (let i = 0; i < lines.length && matches.length < 100; i++) if (lines[i].includes(args.query)) matches.push({ path: relative, line: i + 1, text: lines[i].slice(0, 400) })
        }
      }
    }
  }
  return { matches, filesScanned: files, truncated: directories.length > 0 || files >= 500 || entries >= 5000 || matches.length >= 100 }
}

function runConfig({ tools, loadAgentsMd, loadSkills }) {
  const restricted = tools !== 'full'
  // Hooks and notify commands belong to the CLI UI, not an embedded pet connection.
  const config = { 'features.hooks': false, notify: [], 'features.tool_suggest': false }
  if (restricted || !loadAgentsMd) config.project_doc_max_bytes = 0
  if (restricted || !loadSkills) {
    config['features.skip_host_skill_discovery'] = true
    config['features.skill_search'] = false
    config['features.skill_mcp_dependency_install'] = false
    config['skills.include_instructions'] = false
    config['skills.bundled.enabled'] = false
  }
  if (restricted) {
    for (const feature of ['shell_tool', 'view_image', 'apps', 'plugins', 'multi_agent', 'multi_agent_v2', 'browser_use', 'computer_use', 'code_mode', 'artifact', 'workspace_dependencies', 'memories', 'goals']) config['features.' + feature] = false
    config.web_search = 'disabled'
  }
  return config
}

class CodexRun extends EventEmitter {
  constructor(options, { spawnProcess = spawn } = {}) {
    super()
    this.options = { tools: 'full', permission: 'workspace-write', images: [], ...options }
    this.sessionId = options.sessionId || null
    this.final = ''
    this.stderr = ''
    this.killed = false
    this.pending = new Map()
    this.approvals = new Map()
    this.userInputs = new Map()
    this.items = new Map()
    this.messages = new Map()
    this.nextId = 1
    this.spawnProcess = spawnProcess
    queueMicrotask(() => this._start().catch((e) => this._finish(false, e.message, -1)))
  }

  async _start() {
    if (this.done || this.killed) return
    const o = this.options
    if (!['full', 'look', 'scan', 'none'].includes(o.tools)) throw new Error('Unknown Codex tool mode')
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(o.permission)) throw new Error('Unknown Codex permission mode')
    const codex = typeof o.codex === 'string' ? { exe: o.codex } : o.codex
    if (!codex || !codex.exe) throw new Error('找不到 Codex CLI，请先安装 Codex 并运行 codex login')
    this.restricted = o.tools !== 'full'
    const config = runConfig(o)
    const args = [...(codex.args || []), 'app-server', '--listen', 'stdio://']
    for (const [key, value] of Object.entries(config)) args.push('-c', key + '=' + JSON.stringify(value))
    const env = { ...process.env }
    if (codex.electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1'
    this.child = this.spawnProcess(codex.exe, args, { cwd: o.cwd || os.homedir(), env, windowsHide: true, shell: false })
    let buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk
      let i
      while ((i = buffer.indexOf('\n')) >= 0 && !this.done) {
        const line = buffer.slice(0, i).trim()
        buffer = buffer.slice(i + 1)
        if (line) this._line(line)
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (text) => { this.stderr = (this.stderr + text).slice(-8192); this.emit('stderr', text) })
    this.child.stdin.on('error', (e) => { if (!this.done) this._finish(false, e.message, -1) })
    this.child.on('error', (e) => this._finish(false, e.message, -1))
    this.child.on('close', (code) => {
      if (buffer.trim() && !this.done) this._line(buffer.trim())
      if (!this.done) this._finish(false, this.killed ? '已取消' : this.stderr.trim().split(/\r?\n/).slice(-3).join(' ') || 'Codex 在任务完成前退出', code)
    })
    await this._request('initialize', { clientInfo: { name: 'ojousama_codex', title: 'Ojousama', version: '2.0.0' }, capabilities: { experimentalApi: true } })
    this._send({ method: 'initialized' })
    const threadConfig = {}
    if (this.restricted) {
      // Empty TOML tables merge with user config; disable every inherited server by name.
      const result = await this._request('config/read', { includeLayers: false })
      threadConfig.mcp_servers = Object.fromEntries(Object.keys(result.config?.mcp_servers || {}).map((name) => [name, { enabled: false }]))
    }
    if (o.tools === 'scan' && (o.scanRoot === undefined ? o.cwd : o.scanRoot)) {
      this.scanRoot = await fs.promises.realpath(o.scanRoot === undefined ? o.cwd : o.scanRoot)
      if (!(await fs.promises.stat(this.scanRoot)).isDirectory()) throw new Error('Scan workspace must be a directory')
    }
    const params = { cwd: o.cwd || os.homedir(), sandbox: this.restricted ? 'read-only' : o.permission, approvalPolicy: this.restricted ? 'never' : 'on-request', developerInstructions: o.persona || '', config: { ...config, ...threadConfig } }
    if (o.model) params.model = o.model
    if (this.restricted) params.environments = []
    if (this.scanRoot) params.developerInstructions += '\nWorkspace file access is available only through pet_read_file and pet_search_files. Paths are relative to ' + this.scanRoot + '. No shell, network or writes are available.'
    if (this.sessionId) params.threadId = this.sessionId
    else if (this.scanRoot) params.dynamicTools = SCAN_TOOLS
    const response = await this._request(this.sessionId ? 'thread/resume' : 'thread/start', params)
    if (!response.thread?.id) throw new Error('Codex did not return a thread ID')
    this.sessionId = response.thread.id
    this.emit('event', { type: 'session', sessionId: this.sessionId })
    const turn = { threadId: this.sessionId, input: [{ type: 'text', text: o.prompt || '', text_elements: [] }, ...o.images.map((image) => ({ type: 'localImage', path: image }))] }
    if (o.reasoningEffort) turn.effort = o.reasoningEffort
    if (this.restricted) turn.environments = []
    const result = await this._request('turn/start', turn)
    this.turnId = result.turn?.id || this.turnId
    if (this.killed) this._interrupt()
  }

  _send(message) {
    if (this.done || !this.child || this.child.stdin.destroyed) return
    this.child.stdin.write(JSON.stringify(message) + '\n')
  }

  _request(method, params) {
    if (this.done) return Promise.reject(new Error(this.killed ? '已取消' : 'Codex connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex request timed out: ' + method)) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this._send({ id, method, params })
    })
  }

  _line(line) {
    let message
    try { message = JSON.parse(line) } catch { this._finish(false, 'Codex returned malformed JSON', -1); return }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this._finish(false, 'Codex returned an invalid protocol message', -1); return }
    if (message.method && message.id !== undefined) { this._serverRequest(message).catch((e) => this._finish(false, e.message, -1)); return }
    if (message.id !== undefined) {
      const request = this.pending.get(message.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error.message || 'Codex request failed'))
      else request.resolve(message.result || {})
      return
    }
    const p = message.params || {}
    if (p.threadId && this.sessionId && p.threadId !== this.sessionId) return
    if (message.method === 'serverRequest/resolved') {
      this.approvals.delete(p.requestId)
      this.userInputs.delete(p.requestId)
    } else if (message.method === 'turn/started') {
      this.turnId = p.turn?.id
      this.emit('event', { type: 'status', phase: 'turn_start' })
    } else if (message.method === 'item/agentMessage/delta') {
      const text = (this.messages.get(p.itemId) || '') + (p.delta || '')
      this.messages.set(p.itemId, text)
      this.emit('event', { type: 'text', text })
    } else if (message.method?.startsWith('item/reasoning/')) this.emit('event', { type: 'thinking' })
    else if (message.method === 'item/started' || message.method === 'item/completed') this._item(p.item, message.method === 'item/completed')
    else if (message.method === 'turn/completed') {
      const turn = p.turn || {}
      this._finish(turn.status === 'completed' && !this.killed, this.killed ? '已取消' : turn.error?.message || (turn.status === 'completed' ? null : 'Codex turn ' + turn.status), turn.status === 'completed' ? 0 : 1)
    } else if (message.method === 'error' && !p.willRetry) this._finish(false, p.error?.message || p.message || 'Codex error', 1)
  }

  _item(item, completed) {
    if (!item) return
    this.items.set(item.id, item)
    if (item.type === 'reasoning') { this.emit('event', { type: 'thinking' }); return }
    if (item.type === 'agentMessage') {
      if (completed) {
        this.final = item.text || this.messages.get(item.id) || ''
        this.emit('event', { type: 'text', text: this.final })
      }
      return
    }
    const names = { commandExecution: 'shell', fileChange: 'edit_file', mcpToolCall: item.tool, dynamicToolCall: item.tool, webSearch: 'web_search' }
    const tool = names[item.type]
    if (!tool) return
    // Backstop for restricted runs: if Codex ever starts a shell, edit, MCP or web item anyway
    // (a renamed feature flag, a weak sandbox), stop the whole run instead of letting it continue.
    if (this.restricted && !completed && RESTRICTED_FORBIDDEN.has(item.type)) {
      this.emit('event', { type: 'tool_call', tool, blocked: true })
      this.blockedItem = item.type
      this.kill()
      this._finish(false, `受限任务里出现了不允许的操作（${item.type}），已停止`, 1)
      return
    }
    if (completed) this.emit('event', { type: 'tool_result', tool, status: item.status || 'completed' })
    else this.emit('event', { type: 'tool_call', tool, input: item.arguments || { command: item.command, query: item.query, path: item.changes?.[0]?.path } })
  }

  async _serverRequest(message) {
    const { id, method, params: p = {} } = message
    if (method === 'item/tool/requestUserInput') {
      this.userInputs.set(id, p)
      if (this.restricted) this.respondUserInput(id, {})
      else this.emit('event', { ...p, type: 'user_input', id })
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      this._send({ id, result: { action: 'decline', content: null } })
      return
    }
    if (method === 'item/tool/call') {
      try {
        if (this.options.tools !== 'scan' || p.threadId !== this.sessionId) throw new Error('Tool is not available in this run')
        const result = await scanTool(this.scanRoot, p.tool, p.arguments)
        this._send({ id, result: { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } })
      } catch (e) { this._send({ id, result: { success: false, contentItems: [{ type: 'inputText', text: e.message }] } }) }
      return
    }
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
      this.approvals.set(id, { method, params: p })
      if (this.restricted) this.respondApproval(id, 'decline')
      else this.emit('event', { ...p, type: 'approval', id, method, changes: this.items.get(p.itemId)?.changes, canAccept: true })
    } else this._send({ id, error: { code: -32601, message: 'Unsupported client request: ' + method } })
  }

  respondUserInput(id, answers) {
    const request = this.userInputs.get(id)
    if (!request || this.done) return false
    if (answers === null) answers = {}
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return false
    const questionIds = new Set((request.questions || []).map((q) => q.id))
    for (const [questionId, answer] of Object.entries(answers)) {
      if (!questionIds.has(questionId) || !answer || !Array.isArray(answer.answers) || answer.answers.some((text) => typeof text !== 'string')) return false
    }
    this.userInputs.delete(id)
    this._send({ id, result: { answers: this.restricted ? {} : answers } })
    return true
  }

  respondApproval(id, decision) {
    const request = this.approvals.get(id)
    if (!request || !['accept', 'decline', 'cancel'].includes(decision) || this.done) return false
    const { method, params } = request
    let result
    if (method === 'item/permissions/requestApproval') result = { permissions: decision === 'accept' && !this.restricted ? params.permissions : {}, scope: 'turn' }
    else result = { decision: this.restricted && decision === 'accept' ? 'decline' : decision }
    this.approvals.delete(id)
    this._send({ id, result })
    return true
  }

  _interrupt() {
    if (this.sessionId && this.turnId) this._send({ id: this.nextId++, method: 'turn/interrupt', params: { threadId: this.sessionId, turnId: this.turnId } })
  }

  kill() {
    if (this.done || this.killed) return
    this.killed = true
    this._interrupt()
    this.cancelTimer = setTimeout(() => this._finish(false, '已取消', 1), 1000)
    if (!this.child || !this.turnId) this._finish(false, '已取消', 1)
  }

  _finish(ok, error, code) {
    if (this.done) return
    this.done = true
    clearTimeout(this.cancelTimer)
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(error || 'Codex connection closed')) }
    this.pending.clear()
    this.approvals.clear()
    this.userInputs.clear()
    if (this.child) {
      this.child.stdin.end()
      // Give app-server a chance to shut down the thread and its owned commands.
      this.exitTimer = setTimeout(() => { if (this.child.exitCode === null && !this.child.killed) this.child.kill() }, 1000)
      this.exitTimer.unref()
      this.child.once('close', () => clearTimeout(this.exitTimer))
    }
    this.emit('done', { ok: ok && !this.killed, final: this.final, sessionId: this.sessionId, error: this.killed ? '已取消' : error || null, code })
  }
}

module.exports = { CodexRun, locateCodex }
