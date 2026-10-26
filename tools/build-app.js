'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')

function buildOutput({ platform = process.platform, arch = process.arch, root = ROOT, home = os.homedir() } = {}) {
  // App bundles must never pass through a File Provider workspace before signing or installation.
  return platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'claude-ojousama', 'build', arch) : path.join(root, 'dist')
}

function packagePath(output, { platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') return path.join(output, arch === 'arm64' ? 'mac-arm64' : 'mac', 'Claude Ojousama.app')
  return path.join(output, arch === 'arm64' ? 'linux-arm64-unpacked' : 'linux-unpacked')
}

function builderArguments(output, { dir = false, args = [] } = {}) {
  return [...args, ...(dir ? ['--dir'] : []), `--config.directories.output=${output}`, '--publish', 'never']
}

function deliverArchives(output, destination) {
  fs.mkdirSync(destination, { recursive: true })
  const copied = []
  for (const file of fs.readdirSync(output, { withFileTypes: true })) {
    if (!file.isFile() || !/\.(dmg|zip|exe|AppImage|deb|blockmap)$/.test(file.name)) continue
    fs.copyFileSync(path.join(output, file.name), path.join(destination, file.name))
    copied.push(file.name)
  }
  return copied
}

function run(executable, args, env) {
  const result = spawnSync(executable, args, { cwd: ROOT, stdio: 'inherit', env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${path.basename(executable)} exited with ${result.status}`)
}

function buildApp({ dir = false, args = [] } = {}) {
  const output = buildOutput()
  const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  delete env.ELECTRON_RUN_AS_NODE
  run(process.execPath, [path.join(__dirname, 'build-screen-helper.js')], env)
  run(process.execPath, [require.resolve('electron-builder/cli.js'), ...builderArguments(output, { dir, args })], env)
  if (process.platform === 'darwin' && !dir) deliverArchives(output, path.join(ROOT, 'dist'))
  console.log(`Build output: ${output}`)
  return output
}

if (require.main === module) {
  const args = process.argv.slice(2)
  try { buildApp({ dir: args.includes('--dir'), args: args.filter((arg) => arg !== '--dir') }) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { buildOutput, packagePath, builderArguments, deliverArchives, buildApp }
