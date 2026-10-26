'use strict'
// Stored DSH session IDs remain unchanged; Codex threads have their own namespace.
const backendId = (settings) => (settings.backend === 'codex' ? 'codex' : 'dsh')
const backendName = (settings) => (backendId(settings) === 'codex' ? 'Codex' : 'DeepSeek Harness')

function sessionForBackend(id, backend) {
  if (!id) return null
  const codex = String(id).startsWith('codex:')
  if (backend === 'codex') return codex ? id.slice(6) : null
  return codex ? null : id
}

function namespaceSession(run, backend) {
  const tag = (value) => (value && backend === 'codex' ? `codex:${value}` : value)
  run.on('event', (event) => {
    if (event.type === 'session') event.sessionId = tag(event.sessionId)
  })
  run.on('done', (result) => { result.sessionId = tag(result.sessionId) })
  return run
}

function codexOptions(settings, { prompt, persona, sessionId, permission, tools = 'full', images = [] }) {
  const restricted = tools !== 'full'
  return {
    prompt, persona, images, tools,
    sessionId: sessionForBackend(sessionId, 'codex'),
    permission: restricted ? 'read-only' : permission || settings.permission,
    cwd: settings.cwd,
    scanRoot: settings.cwd || '',
    model: (restricted && settings.codexGlanceModel) || settings.codexModel || '',
    reasoningEffort: (restricted && settings.codexGlanceEffort) || settings.codexEffort || '',
    loadAgentsMd: !restricted && !!settings.loadAgentsMd,
    loadSkills: !restricted && !!settings.loadSkills,
  }
}

module.exports = { backendId, backendName, sessionForBackend, namespaceSession, codexOptions }
