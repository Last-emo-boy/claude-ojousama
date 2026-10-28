export const CANVAS_SIZE = 180
export const SPRITE_SCALE = 1.35

export function frameGeometry(sheet, index, reduced = false) {
  const frame = reduced ? 0 : sheet.loop === false ? Math.min(index, sheet.frames - 1) : index % sheet.frames
  const scale = sheet.displayHeight ? sheet.displayHeight / sheet.h : SPRITE_SCALE
  const width = sheet.w * scale, height = sheet.h * scale
  return { frame, scale, width, height, x: (CANVAS_SIZE - width) / 2,
    y: CANVAS_SIZE - height + (sheet.offsetsY?.[frame] ?? sheet.offsetY ?? 0) }
}

export function createSheetCache(load, limit = 3) {
  const ready = new Map(), pending = new Map()
  const get = name => {
    const sheet = ready.get(name)
    if (sheet) { ready.delete(name); ready.set(name, sheet) }
    return sheet
  }
  return { get, load(name) {
    const cached=get(name)
    if (cached) return Promise.resolve(cached)
    if (pending.has(name)) return pending.get(name)
    const work = Promise.resolve().then(() => load(name)).then(sheet => {
      ready.set(name, sheet)
      while (ready.size > limit) ready.delete(ready.keys().next().value)
      return sheet
    }).finally(() => pending.delete(name))
    pending.set(name, work)
    return work
  } }
}
