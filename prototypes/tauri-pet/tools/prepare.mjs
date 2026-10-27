import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const SPRITES = ['idle', 'thinking', 'typing', 'dangle', 'happy', 'error', 'wave']

export function prepareAssets({ root = ROOT, repository = path.resolve(root, '../..') } = {}) {
  const source = path.join(repository, 'assets', 'sprites')
  const destination = path.join(root, 'web', 'assets', 'sprites')
  fs.mkdirSync(destination, { recursive: true })
  for (const name of [...SPRITES.map(name => `${name}.png`), 'manifest.json']) {
    fs.copyFileSync(path.join(source, name), path.join(destination, name))
  }
  const icons = path.join(root, 'src-tauri', 'icons')
  fs.mkdirSync(icons, { recursive: true })
  fs.copyFileSync(path.join(repository, 'assets', 'icon-256.png'), path.join(icons, 'icon.png'))
  fs.copyFileSync(path.join(repository, 'assets', 'icon.ico'), path.join(icons, 'icon.ico'))
  return { sprites: destination, icon: path.join(icons, 'icon.png') }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = prepareAssets()
    console.log(`Prepared ${SPRITES.length} sprite sheets: ${output.sprites}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
