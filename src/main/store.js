'use strict'
// Tiny JSON-file store with debounced atomic writes. One file per app.
const fs = require('fs')
const path = require('path')

const sharedDefaults = require('../../assets/companion-defaults.json')
const DEFAULTS = {
  ...sharedDefaults,
  settings: {
    ...sharedDefaults.settings,
    backend: process.platform === 'win32' ? 'dsh' : 'codex',
    permission: process.platform === 'win32' ? 'workspace-write' : 'read-only',
  },
}

const DEFAULT_RULES = DEFAULTS.settings.rules

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'pet-data.json')
    fs.mkdirSync(dir, { recursive: true })
    let data = {}
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {}
    this.data = {}
    for (const [k, v] of Object.entries(DEFAULTS)) {
      if (Array.isArray(v)) this.data[k] = Array.isArray(data[k]) ? data[k] : []
      else this.data[k] = { ...v, ...(data[k] || {}) }
    }
    // Upgrading an existing installation must not switch its agent or model.
    if (data.settings && !data.settings.backend) {
      this.data.settings.backend = 'dsh'
      if (!data.settings.permission) this.data.settings.permission = 'workspace-write'
    }
    // Nested defaults: keep rules added in newer versions.
    this.data.settings.rules = { ...DEFAULT_RULES, ...(this.data.settings.rules || {}) }
    this.timer = null
  }

  get(key) {
    return this.data[key]
  }

  set(key, value) {
    this.data[key] = value
    this.save()
  }

  patch(key, partial) {
    this.data[key] = { ...this.data[key], ...partial }
    this.save()
    return this.data[key]
  }

  save() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 300)
  }

  flush() {
    clearTimeout(this.timer)
    const tmp = this.file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.file)
  }
}

module.exports = { Store, DEFAULTS, DEFAULT_RULES }
