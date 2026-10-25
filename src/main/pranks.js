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
  pet.once('giggle', 3)
  await pet.say(pick(LINES.prankBugReveal), { ttl: 2600 })
}

async function dragJunk(pet) {
  await pet.fileTrip({ icon: null, label: pick(FAKE_FILES) }, null, pick(LINES.prankDrag))
}

async function chase(pet) {
  pet.say(pick(LINES.prankChase), { ttl: 3500 })
  pet.hold('walk')
  const end = Date.now() + 4500
  const [w] = pet.size()
  while (Date.now() < end) {
    const c = screen.getCursorScreenPoint()
    const [x] = pet.position().arr
    const target = c.x - w / 2
    if (Math.abs(target - x) < 12) break
    await pet.motion.walkTo(x + Math.sign(target - x) * Math.min(80, Math.abs(target - x)), 160)
  }
  pet.once('happy', 1)
}

async function knock(pet) {
  pet.say(pick(LINES.prankKnock), { ttl: 3000 })
  await pet.motion.shake(450, 5)
  await sleep(250)
  await pet.motion.shake(450, 5)
  pet.once('wave', 2)
}

async function hide(pet) {
  const home = pet.position()
  const wa = pet.workArea()
  const [w] = pet.size()
  const goLeft = home.x + w / 2 < wa.x + wa.width / 2
  // Talk before slipping off-screen: a bubble on a half-hidden window would be clipped.
  await pet.say(pick(LINES.prankHide), { ttl: 1800 })
  pet.hold('walk')
  await pet.motion.walkTo(goLeft ? wa.x - w * 0.62 : wa.x + wa.width - w * 0.38, 110, { allowOffscreen: true })
  pet.release()
  await sleep(6500)
  pet.hold('walk')
  await pet.motion.walkTo(home.x, 110)
  pet.release()
  pet.once('surprise', 1)
  pet.say('找到我了吗？嘿嘿～', { ttl: 2500 })
}

async function dance(pet) {
  pet.once('happy', 4)
  await pet.say(pick(LINES.prankDance), { ttl: 3000 })
}

/** Desktop-Goose style: haul a silly memo onto the screen and stick it there. */
async function pinNote(pet) {
  await pet.postMemo()
}

const ALL = { peek, fakeBug, dragJunk, chase, knock, hide, dance, pinNote }

async function runRandom(pet, name) {
  const keys = Object.keys(ALL)
  const key = name && ALL[name] ? name : pick(keys)
  await ALL[key](pet)
  return key
}

module.exports = { runRandom, ALL }
