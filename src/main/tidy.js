'use strict'
// Watch folders (Downloads by default) for new files and plan "tidy into category folders" moves.
// Pure file logic; the pet decides when to ask and animates the trips.
const fs = require('fs')
const fsp = fs.promises
const path = require('path')

const CATEGORIES = [
  ['图片', 'jpg jpeg png gif webp bmp svg heic heif ico tif tiff avif psd'],
  ['文档', 'pdf doc docx xls xlsx ppt pptx txt md csv rtf odt ods odp epub pages key numbers'],
  ['压缩包', 'zip rar 7z tar gz bz2 xz tgz zst'],
  ['安装包', 'exe msi msix msixbundle appx dmg pkg apk iso'],
  ['视频', 'mp4 mkv mov avi wmv flv webm m4v'],
  ['音乐', 'mp3 wav flac aac ogg m4a wma opus'],
  ['代码', 'js ts jsx tsx py java c cpp h hpp cs go rs json yml yaml xml html css ipynb sql sh ps1 bat'],
].map(([name, exts]) => [name, new Set(exts.split(' '))])

// Partial downloads, Office lock files and shell metadata are never touched.
const SKIP_RE = /\.(crdownload|part|partial|download|tmp|temp|opdownload|aria2)$|^~\$|^desktop\.ini$|^thumbs\.db$|^\./i
const STABLE_MS = 45000 // a new file must keep the same size this long before we touch it

function categoryOf(name) {
  const ext = path.extname(name).slice(1).toLowerCase()
  if (!ext) return null
  for (const [cat, exts] of CATEGORIES) if (exts.has(ext)) return cat
  return null
}

async function listFiles(folder) {
  let entries
  try {
    entries = await fsp.readdir(folder, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isFile() || SKIP_RE.test(e.name)) continue
    const full = path.join(folder, e.name)
    try {
      const st = await fsp.stat(full)
      out.push({ folder, name: e.name, full, size: st.size, mtimeMs: Math.round(st.mtimeMs), cat: categoryOf(e.name) })
    } catch {}
  }
  return out
}

/**
 * Compare the folders with what we have seen before. Returns new files that are
 * categorisable and have stopped changing. `state` = { seen: {folder: {name: mtime}}, pending: {full: {size, since}} }
 * is mutated in place; the first scan of a folder only records a baseline.
 */
async function scanNew(folders, state, now = Date.now()) {
  const ready = []
  state.seen = state.seen || {}
  state.pending = state.pending || {}
  for (const folder of folders) {
    const files = await listFiles(folder)
    const seen = state.seen[folder]
    if (!seen) {
      state.seen[folder] = Object.fromEntries(files.map((f) => [f.name, f.mtimeMs]))
      continue
    }
    const present = new Set(files.map((f) => f.name))
    for (const name of Object.keys(seen)) if (!present.has(name)) delete seen[name]
    for (const f of files) {
      // Only names we have never seen are new; an old file that was edited stays where it is.
      if (seen[f.name] !== undefined) {
        seen[f.name] = f.mtimeMs
        continue
      }
      if (!f.cat) {
        seen[f.name] = f.mtimeMs // nothing to do with unknown types
        continue
      }
      const p = state.pending[f.full]
      if (!p || p.size !== f.size) {
        state.pending[f.full] = { size: f.size, since: now }
        continue
      }
      if (now - p.since >= STABLE_MS && now - f.mtimeMs >= STABLE_MS / 2) ready.push(f)
    }
  }
  for (const full of Object.keys(state.pending)) if (!fs.existsSync(full)) delete state.pending[full]
  return ready
}

/** Mark files as handled so we do not offer them again. */
function markSeen(state, files) {
  for (const f of files) {
    state.seen[f.folder] = state.seen[f.folder] || {}
    state.seen[f.folder][f.name] = f.mtimeMs
    delete state.pending[f.full]
  }
}

function uniqueDest(dir, name, taken = new Set()) {
  const ext = path.extname(name)
  const base = path.basename(name, ext)
  for (let i = 0; i < 1000; i++) {
    const dest = path.join(dir, i ? `${base} (${i})${ext}` : name)
    if (!fs.existsSync(dest) && !taken.has(dest.toLowerCase())) return dest
  }
  return null
}

/** Plan moves into `<folder>/<category>/`; never overwrites. */
function planMoves(files) {
  const taken = new Set()
  const moves = []
  for (const f of files) {
    if (!f.cat) continue
    const to = uniqueDest(path.join(f.folder, f.cat), f.name, taken)
    if (!to) continue
    taken.add(to.toLowerCase())
    moves.push({ from: f.full, to, cat: f.cat, name: f.name, folder: f.folder })
  }
  return moves
}

async function moveFile(from, to, createdDirs) {
  const dir = path.dirname(to)
  if (!fs.existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true })
    if (createdDirs && !createdDirs.includes(dir)) createdDirs.push(dir)
  }
  if (fs.existsSync(to)) throw new Error(`目标已存在：${path.basename(to)}`)
  try {
    await fsp.rename(from, to)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL)
    await fsp.rm(from)
  }
}

/** Summarise moves as "图片 2、文档 1". */
function summarize(moves) {
  const count = {}
  for (const m of moves) count[m.cat] = (count[m.cat] || 0) + 1
  return Object.entries(count)
    .map(([k, v]) => `${k} ${v}`)
    .join('、')
}

module.exports = { categoryOf, listFiles, scanNew, markSeen, planMoves, moveFile, summarize, STABLE_MS }
