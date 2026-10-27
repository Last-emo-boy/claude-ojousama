'use strict'
// Pure classifiers used by the autonomy loop (no Electron here, easy to unit-test).

const DEFAULT_BLOCK = require('../../assets/observation-policy.json').blockedApps
const DEFAULT_DISTRACT = ['bilibili', '哔哩哔哩', '微博', 'weibo', '抖音', 'douyin', '快手', '小红书', 'youtube', 'twitter', 'x.com', 'reddit', 'netflix', '爱奇艺', '优酷', '腾讯视频', '虎牙', '斗鱼', 'twitch', 'steam', '淘宝', '京东']
const MEETING_PROCS = /^(zoom|teams|ms-teams|wemeetapp|wemeet|tencentmeeting|voovmeeting|webex|ciscowebex)/i
// Only titles that mean "a meeting is running now" (not "Meeting notes", not an idle meeting app).
const MEETING_TITLE = /(会议中|正在开会|视频会议中|共享屏幕|正在共享|屏幕共享中|Zoom Meeting|Zoom 会议|screen sharing|you are sharing)/i
const MUSIC_PROCS = ['cloudmusic', 'QQMusic', 'Spotify', 'KuGou', 'kuwomusic', 'foobar2000', 'AIMP', 'MusicBee', 'Music.UI']
const EDITOR_PROCS = /^(code|code - insiders|cursor|windsurf|idea64|pycharm64|webstorm64|clion64|goland64|rider64|devenv|sublime_text|notepad\+\+|vim|nvim|zed|trae)$/i
const TERMINAL_PROCS = /^(windowsterminal|wt|cmd|powershell|pwsh|conhost|mintty|alacritty|wezterm-gui|tabby)$/i

const norm = (s) => String(s || '').toLowerCase()
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Keyword match against a title: Latin words must stand alone ("tim" must not match
 * "timer.js", "x.com" must not match "dropbox.com"); CJK keywords match as substrings.
 */
function titleHas(title, word) {
  if (!/[a-z0-9]/i.test(word)) return title.includes(word)
  return new RegExp(`(^|[^a-z0-9_])${escapeRe(word)}($|[^a-z0-9_])`, 'i').test(title)
}

/** Does the block list match this window (exact process name or a title keyword)? */
function isBlocked(info, list) {
  const words = (Array.isArray(list) && list.length ? list : DEFAULT_BLOCK).map(norm).filter(Boolean)
  const proc = norm(info.process)
  const title = norm(info.title)
  return words.some((w) => proc === w || titleHas(title, w))
}

function isMeeting(info) {
  return MEETING_PROCS.test(info.process || '') || MEETING_TITLE.test(info.title || '')
}

function isDistraction(info, list) {
  const words = (Array.isArray(list) && list.length ? list : DEFAULT_DISTRACT).map(norm).filter(Boolean)
  const proc = norm(info.process)
  const title = norm(info.title)
  return words.find((w) => proc === w || titleHas(title, w)) || null
}

function appKind(info) {
  if (EDITOR_PROCS.test(info.process || '')) return 'editor'
  if (TERMINAL_PROCS.test(info.process || '')) return 'terminal'
  if (/^(msedge|chrome|firefox|brave|opera|vivaldi|arc)$/i.test(info.process || '')) return 'browser'
  return 'app'
}

// Strong signals only: words like "error" alone appear in normal code all the time.
const ERROR_PATTERNS = [
  /Traceback \(most recent call last\)/i,
  /\b(?:[A-Z][a-zA-Z]+)?(?:Error|Exception): .{3,}/,
  /\bUncaught \w+/,
  /npm ERR!/,
  /\berror (?:TS|CS|C)\d{3,5}\b/,
  /\berror\[E\d{4}\]/,
  /^\s*(?:fatal|FATAL|panic):/m,
  /Exception in thread/,
  /Segmentation fault/,
  /\b(?:BUILD|Build|Compilation|build) (?:FAILED|failed)\b/,
  /\bFAILED\b.*\btests?\b|\b[1-9]\d* (?:failed|failing)\b/i, // "0 failed" is a pass
  /(?:编译|构建|运行|执行|安装)失败/,
  /(?:报错|异常)[:：]/,
]

/** First line that looks like a real error, or null. */
function findError(text) {
  const lines = String(text || '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (ERROR_PATTERNS.some((re) => re.test(l))) return { line: l.trim().slice(0, 160), index: i }
  }
  // Multi-line patterns (Traceback headers can be split by OCR).
  const all = lines.join('\n')
  for (const re of ERROR_PATTERNS) {
    const m = all.match(re)
    if (m) return { line: m[0].trim().slice(0, 160), index: -1 }
  }
  return null
}

/** Stable-ish signature so the same error is not offered twice. */
function errorSignature(line) {
  return norm(line)
    .replace(/[0-9]+/g, '#')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
}

const SECRET_HINT = /(password|passwd|pwd|token|secret|api[_-]?key|sk-[a-z0-9]|bearer|private key|BEGIN [A-Z ]*KEY)/i

/**
 * What kind of text was copied: 'error' | 'code' | 'english' | null (ignore).
 * Secrets, one-time codes, URLs and short snippets are ignored.
 */
function classifyClip(text) {
  const t = String(text || '').trim()
  if (t.length < 24 || t.length > 8000) return null
  if (SECRET_HINT.test(t)) return null
  if (!/\s/.test(t)) return null // tokens, keys, single words, bare URLs
  if (/^https?:\/\/\S+$/.test(t)) return null
  // Wallet recovery phrases: 12-24 plain lowercase words and nothing else.
  const plain = t.split(/\s+/)
  if (plain.length >= 12 && plain.length <= 24 && plain.every((w) => /^[a-z]{3,8}$/.test(w))) return null
  if (findError(t)) return 'error'
  const lines = t.split(/\r?\n/)
  const symbols = (t.match(/[{}();=<>[\]]/g) || []).length
  const indented = lines.filter((l) => /^\s{2,}\S/.test(l)).length
  if (lines.length >= 2 && (symbols / t.length > 0.04 || indented >= 2)) return 'code'
  const ascii = t.replace(/[^\x20-\x7e]/g, '').length / t.length
  const words = t.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w)).length
  if (ascii > 0.9 && words >= 8) return 'english'
  return null
}

/** "Song - Artist" style title of a music player, or null when it only shows the app name. */
function musicTitle(win) {
  const t = String(win.title || '').trim()
  if (!t || t.length < 3) return null
  if (/^(网易云音乐|QQ音乐|Spotify( Free| Premium)?|酷狗音乐|酷我音乐|foobar2000|AIMP|MusicBee|Media Player|Groove)/i.test(t) && !/ - /.test(t)) return null
  return t.replace(/\s*[-|–]\s*(网易云音乐|QQ音乐|酷狗音乐|酷我音乐)$/, '').slice(0, 60)
}

module.exports = {
  DEFAULT_BLOCK,
  DEFAULT_DISTRACT,
  MUSIC_PROCS,
  MEETING_TITLE,
  isBlocked,
  isMeeting,
  isDistraction,
  appKind,
  findError,
  errorSignature,
  classifyClip,
  musicTitle,
}
