import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { ROOT, prepareAssets } from './prepare.mjs'

const require = createRequire(import.meta.url)

export function buildEnvironment({ platform = process.platform, home = os.homedir(), root = ROOT, env = process.env } = {}) {
  const target = env.CARGO_TARGET_DIR
    ? path.resolve(root, env.CARGO_TARGET_DIR)
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'ojousama-lite', 'target')
      : path.join(root, 'src-tauri', 'target')
  const result = { ...env, CARGO_TARGET_DIR: target }
  delete result.ELECTRON_RUN_AS_NODE
  return result
}

export function buildArguments(args = [], platform = process.platform) {
  const explicit = args.some(arg => arg === '--bundles' || arg.startsWith('--bundles=') || arg === '--no-bundle')
  if (explicit) return ['build', ...args]
  const bundles = { darwin: 'app,dmg', win32: 'nsis', linux: 'deb,appimage' }[platform]
  if (!bundles) throw new Error(`Unsupported desktop platform: ${platform}`)
  return ['build', '--bundles', bundles, ...args]
}

export function releaseDirectory(targetDir, args = []) {
  const index = args.findIndex(arg => arg === '--target' || arg === '-t')
  const target = index >= 0 ? args[index + 1] : args.find(arg => arg.startsWith('--target='))?.slice(9)
  if (index >= 0 && (!target || target.startsWith('-'))) throw new Error('--target requires a target triple')
  return path.join(targetDir, ...(target ? [target] : []), args.some(arg => ['--debug', '-d'].includes(arg)) ? 'debug' : 'release')
}

export function buildApp(args = []) {
  prepareAssets()
  const env = buildEnvironment()
  const cli = require.resolve('@tauri-apps/cli/tauri.js')
  const result = spawnSync(process.execPath, [cli, ...buildArguments(args)], { cwd: ROOT, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Tauri build exited with ${result.status}`)
  const release = releaseDirectory(env.CARGO_TARGET_DIR, args)
  console.log(`Build output: ${release}`)
  return release
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { buildApp(process.argv.slice(2)) } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
