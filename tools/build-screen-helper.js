'use strict'
// Compile during development/packaging. Installed macOS apps ship this executable, not a compiler dependency.
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function build({ platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'darwin') return []
  if (!['arm64', 'x64', 'universal'].includes(arch)) throw new Error(`Unsupported macOS architecture: ${arch}`)
  const root = path.join(__dirname, '..', 'src', 'main', 'platform')
  const arches = arch === 'universal' ? ['arm64', 'x64'] : [arch]
  const outputs = arches.map((a) => {
    const dir = path.join(root, 'bin', `darwin-${a}`)
    const output = path.join(dir, 'screen-helper')
    fs.mkdirSync(dir, { recursive: true })
    execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-target', `${a === 'x64' ? 'x86_64' : a}-apple-macosx12.0`,
      '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Vision',
      path.join(root, 'screen-helper-macos.swift'), '-o', output], { stdio: 'inherit' })
    fs.chmodSync(output, 0o755)
    return output
  })
  if (arch === 'universal') {
    const output = path.join(root, 'bin', 'darwin-universal', 'screen-helper')
    fs.mkdirSync(path.dirname(output), { recursive: true })
    execFileSync('xcrun', ['lipo', '-create', ...outputs, '-output', output], { stdio: 'inherit' })
    fs.chmodSync(output, 0o755)
    outputs.push(output)
  }
  return outputs
}

if (require.main === module) {
  const i = process.argv.indexOf('--arch')
  const arch = i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith('--arch='))?.slice(7) || process.arch
  for (const file of build({ arch })) console.log(`Built ${file}`)
}

module.exports = { build }
