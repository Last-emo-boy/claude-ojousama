'use strict'
// Bridge to DeepSeek Harness: spawns `dsh --profile headless --json` per turn and
// streams its newline-delimited run events.
const { spawn } = require('child_process')
const { EventEmitter } = require('events')
const fs = require('fs')
const os = require('os')
const path = require('path')

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CLI_REL = path.join('resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')

/** Locate the DeepSeek Harness desktop executable and its bundled CLI entry. */
function locateDsh(override) {
  const candidates = []
  if (override) candidates.push(override)
  if (process.env.DSH_DESKTOP_NODE_EXECUTABLE) candidates.push(process.env.DSH_DESKTOP_NODE_EXECUTABLE)
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  candidates.push(path.join(local, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'))
  candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'DeepSeek Harness', 'DeepSeek Harness.exe'))
  for (const exe of candidates) {
    if (!exe) continue
    const root = path.dirname(exe)
    const cli = path.join(root, CLI_REL)
    // Electron's fs understands .asar archives, so this works for the packed CLI.
    if (fs.existsSync(exe) && fs.existsSync(cli)) return { exe, cli }
  }
  return null
}

/** Split a DSH patch YAML (top-level sequence) into entries keyed by id. */
function splitPatchEntries(text) {
  const entries = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    if (/^- /.test(line)) {
      cur = { lines: [line], id: (line.match(/^- id:\s*(\S+)/) || [])[1] || null }
      entries.push(cur)
    } else if (cur && (/^\s/.test(line) || line === '')) {
      cur.lines.push(line)
    } else if (!/^#/.test(line)) {
      cur = null
    }
  }
  for (const e of entries) {
    if (!e.id) {
      const m = e.lines.join('\n').match(/^\s+id:\s*(\S+)/m)
      e.id = m ? m[1] : null
    }
    e.text = e.lines.join('\n').replace(/\s+$/, '')
  }
  return entries
}

/** Read provider/model information from the source profile (desktop or web). */
function readSourceProfile(profile) {
  const file = path.join(DSH_HOME, 'profiles', profile, 'cordis.patch.yml')
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { entries: [], providers: {}, defaultModel: null, file }
  }
  const entries = splitPatchEntries(text)
  const providers = {}
  const llm = entries.find((e) => e.id === 'llm-pi-ai')
  if (llm) {
    let provider = null
    for (const line of llm.lines) {
      const p = line.match(/^ {6}([\w.-]+):\s*$/)
      if (p) {
        provider = p[1]
        providers[provider] = providers[provider] || []
        continue
      }
      const m = line.match(/^ {10}- id:\s*(.+?)\s*$/)
      if (m && provider) providers[provider].push(m[1].replace(/^['"]|['"]$/g, ''))
    }
  }
  let defaultModel = null
  const dm = entries.find((e) => e.id === 'agent-default-model')
  if (dm) {
    const get = (k) => ((dm.text.match(new RegExp(`^\\s+${k}:\\s*(.+?)\\s*$`, 'm')) || [])[1] || '').replace(/^['"]|['"]$/g, '')
    defaultModel = { provider: get('provider'), model: get('model'), reasoningEffort: get('reasoningEffort') }
  }
  return { entries, providers, defaultModel, file }
}

function yamlBlock(str, indent) {
  const pad = ' '.repeat(indent)
  return '|-\n' + str.split('\n').map((l) => (l ? pad + l : '')).join('\n')
}

// DSH plugins that give a run its tools (patch ids). Disabled per run kind, so limits on
// unattended runs are enforced by DSH, not just requested in the prompt.
const TOOL_PLUGINS = [
  'tool-ask-user', 'tool-bash', 'tool-bash-persistent', 'tool-cordis', 'tool-fs', 'tool-fs-search', 'tool-goal', 'tool-jobs',
  'tool-present', 'tool-pwsh', 'tool-pwsh-persistent', 'tool-ralph', 'tool-schedule', 'tool-session-query', 'tool-skill',
  'tool-str-replace-editor', 'tool-subagent', 'tool-subagent-control', 'tool-terminal', 'tool-todo', 'tool-web', 'tool-workflow',
  'tool-working-directory', 'tool-workspace-dependencies', 'experimental-tool-agent-team', 'subagent-fork-in-process', 'plan-mode',
  'mcp-client', // tools of any MCP servers configured in DSH
]
const TOOLSETS = {
  full: [], // chat, tasks the user asked for or accepted, goals
  look: TOOL_PLUGINS.filter((id) => id !== 'tool-fs'), // screen looks: read_image; no shell, no network, no agents
  scan: TOOL_PLUGINS.filter((id) => id !== 'tool-fs' && id !== 'tool-fs-search'), // unattended file reading/search only
  none: TOOL_PLUGINS, // reflection, brief, tip, summary: text in, text out
}

/** Write the overlay patch the pet passes to every headless run. `disable` = plugin ids to switch off. */
function writePetPatch(file, settings, persona, { disable = [] } = {}) {
  const src = readSourceProfile(settings.sourceProfile || 'desktop')
  const keep = new Set(['llm-pi-ai', 'llm-deepseek', 'llm-deepseek-account'])
  const parts = ['# Generated by claude-ojousama; edits are overwritten.']
  for (const e of src.entries) if (keep.has(e.id)) parts.push(e.text)
  const dm = src.defaultModel || {}
  const provider = settings.provider || dm.provider
  const model = settings.model || dm.model
  if (provider && model) {
    // Effort names are provider specific (DeepSeek V4.1 rejects "low" through some routes),
    // so only pin one when the user picked it or the source profile already does.
    const effort = settings.reasoningEffort || (provider === dm.provider && model === dm.model ? dm.reasoningEffort : '')
    const lines = [
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      `    provider: ${JSON.stringify(provider)}`,
      `    model: ${JSON.stringify(model)}`,
    ]
    if (effort) lines.push(`    reasoningEffort: ${JSON.stringify(effort)}`)
    parts.push(lines.join('\n'))
  }
  parts.push('- id: credentials\n  name: "@deepseek-ai/dsh-credentials-local"\n  disabled: false')
  parts.push(`- id: system-prompt\n  name: "@deepseek-ai/dsh-system-prompt"\n  config:\n    personaPrefix: ${yamlBlock(persona, 6)}`)
  if (!settings.loadAgentsMd) parts.push('- id: agent-instructions\n  name: "@deepseek-ai/dsh-agent-instructions"\n  disabled: true')
  if (!settings.loadSkills) parts.push('- id: skill-filesystem\n  name: "@deepseek-ai/dsh-skill-filesystem"\n  disabled: true')
  for (const id of disable) parts.push(`- id: ${id}\n  name: "@deepseek-ai/dsh-${id}"\n  disabled: true`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, parts.join('\n') + '\n', 'utf8')
  return { providers: src.providers, defaultModel: dm, provider, model }
}

/**
 * One headless DSH run. Emits: 'event' (raw json event), 'stderr' (text),
 * 'done' ({ ok, final, sessionId, error, code }).
 */
class DshRun extends EventEmitter {
  constructor({ dsh, patchFile, prompt, sessionId, permission, cwd }) {
    super()
    this.sessionId = sessionId || null
    this.final = ''
    this.texts = []
    this.stderr = ''
    this.killed = false
    const args = ['--expose-internals', dsh.cli, '--profile', 'headless', '--patch', patchFile, '--json']
    if (sessionId) args.push('--session-id', sessionId)
    args.push('-')
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_PERMISSION_MODE: permission || 'workspace-write' }
    for (const k of ['DSH_SESSION_ID', 'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SHELL', 'DSH_WEB_URL']) delete env[k]
    this.child = spawn(dsh.exe, args, { cwd: cwd || os.homedir(), env, windowsHide: true })
    let buf = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) this._line(line)
      }
    })
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (t) => {
      this.stderr += t
      this.emit('stderr', t)
    })
    this.child.on('error', (err) => this._finish(-1, err.message))
    this.child.on('close', (code) => {
      if (buf.trim()) this._line(buf.trim())
      this._finish(code)
    })
    this.child.stdin.on('error', () => {})
    this.child.stdin.end(prompt, 'utf8')
  }

  _line(line) {
    let evt
    try {
      evt = JSON.parse(line)
    } catch {
      return
    }
    if (evt.type === 'session' && evt.sessionId) this.sessionId = evt.sessionId
    if (evt.type === 'text' && evt.text) this.texts.push(evt.text)
    if (evt.type === 'final') this.final = evt.text || ''
    this.emit('event', evt)
  }

  _finish(code, spawnError) {
    if (this.done) return
    this.done = true
    const ok = code === 0 && !this.killed
    const error = ok ? null : spawnError || this.stderr.trim().split(/\r?\n/).slice(-3).join(' ') || (this.killed ? '已取消' : `退出码 ${code}`)
    this.emit('done', { ok, final: this.final || this.texts[this.texts.length - 1] || '', sessionId: this.sessionId, error, code })
  }

  kill() {
    this.killed = true
    try {
      this.child.kill()
    } catch {}
  }
}

module.exports = { locateDsh, readSourceProfile, writePetPatch, DshRun, DSH_HOME, TOOLSETS }
