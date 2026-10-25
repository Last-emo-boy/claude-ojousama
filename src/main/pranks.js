'use strict'
// Local, free "mischief" routines. Each receives the pet controller from main.js.
const { screen } = require('electron')
const { LINES, FAKE_FILES, pick } = require('./persona')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Peek in from the screen edge — and really look: the model sees the window you are using. */
async function peek(pet) {
  const looking = pet.peekLook ? pet.peekLook().catch(() => null) : Promise.resolve(null) // captures before she moves
  const home = pet.position()
  const wa = pet.workArea()
  await pet.fade(0)
  const [w] = pet.size()
  const y = wa.y + Math.round(wa.height * (0.2 + Math.random() * 0.4))
  pet.place(wa.x + wa.width - w, y)
  pet.hold('peek')
  await pet.fade(1)
  pet.say('（盯——）', { ttl: 0, sticky: true })
  const seen = await Promise.race([looking, sleep(45000).then(() => null)])
  const line = (seen && seen.text) || pick(LINES.prankPeek)
  await pet.say(line, { ttl: Math.min(9000, 3200 + line.length * 120) })
  await pet.fade(0)
  pet.place(home.x, home.y)
  pet.release()
  await pet.fade(1)
  pet.once('giggle', 2)
}

async function fakeBug(pet) {
  pet.once('error', 3)
  await pet.say(pick(LINES.prankBug), { ttl: 2600 })
  pet.once('laugh', 3)
  await pet.say(pick(LINES.prankBugReveal), { ttl: 2600 })
}

async function dragJunk(pet) {
  await pet.fileTrip({ icon: null, label: pick(FAKE_FILES) }, null, pick(LINES.prankDrag))
}

async function chase(pet) {
  pet.say(pick(LINES.prankChase), { ttl: 3500 })
  pet.hold('run')
  const end = Date.now() + 4500
  const [w] = pet.size()
  while (Date.now() < end) {
    const c = screen.getCursorScreenPoint()
    const [x] = pet.position().arr
    const target = c.x - w / 2
    if (Math.abs(target - x) < 12) break
    await pet.motion.walkTo(x + Math.sign(target - x) * Math.min(80, Math.abs(target - x)), 220)
  }
  pet.release()
  pet.once('laugh', 1)
}

/** Face pressed against the inside of your screen, knocking to be let out. */
async function knock(pet) {
  pet.hold('squish')
  pet.say(pick(LINES.prankKnock), { ttl: 3000 })
  await pet.motion.shake(450, 5)
  await sleep(250)
  await pet.motion.shake(450, 5)
  await sleep(900)
  pet.release()
  pet.once('wave', 2)
}

async function hide(pet) {
  const home = pet.position()
  const wa = pet.workArea()
  const [w] = pet.size()
  const goLeft = home.x + w / 2 < wa.x + wa.width / 2
  // Talk before slipping off-screen: a bubble on a half-hidden window would be clipped.
  await pet.say(pick(LINES.prankHide), { ttl: 1800 })
  pet.hold('run')
  await pet.motion.walkTo(goLeft ? wa.x - w * 0.62 : wa.x + wa.width - w * 0.38, 200, { allowOffscreen: true })
  pet.release()
  await sleep(6500)
  pet.hold('walk')
  await pet.motion.walkTo(home.x, 110)
  pet.release()
  pet.once('surprise', 1)
  pet.say('找到我了吗？嘿嘿～', { ttl: 2500 })
}

async function dance(pet) {
  pet.once('dance', 3)
  await pet.say(pick(LINES.prankDance), { ttl: 3000 })
}

/** Haul a silly memo onto the screen and stick it there. */
async function pinNote(pet) {
  await pet.postMemo()
}

/** A little magic show that ends with a memo appearing on your desktop (unlocked at Lv.3). */
async function magic(pet) {
  pet.say(pick(LINES.magicShow), { ttl: 3000 })
  await pet.once('magic', 3)
  await pet.postMemo(pick(LINES.magicMemo))
}

const ALL = { peek, fakeBug, dragJunk, chase, knock, hide, dance, pinNote, magic }
const LOCKED = { magic: 'magic' } // prank -> unlock id

async function runRandom(pet, name) {
  const keys = Object.keys(ALL).filter((k) => !LOCKED[k] || (pet.hasUnlock && pet.hasUnlock(LOCKED[k])))
  const key = name && ALL[name] ? name : pick(keys)
  await ALL[key](pet)
  return key
}

module.exports = { runRandom, ALL }
