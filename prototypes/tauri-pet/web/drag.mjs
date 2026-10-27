// One native command in flight; pointer samples coalesce to the latest position.
export function createDragQueue(send, onError) {
  let tail = Promise.resolve()
  return point => {
    let latest = null
    let ending = false
    let wake = null
    const notify = () => {
      if (wake) {
        wake()
        wake = null
      }
    }
    const finished = tail.then(async () => {
      await send('drag_begin', point)
      try {
        while (!ending || latest) {
          if (latest) {
            const sample = latest
            latest = null
            await send('drag_move', sample)
          } else {
            await new Promise(resolve => { wake = resolve })
          }
        }
      } finally {
        await send('drag_end')
      }
    })
    tail = finished.catch(onError)
    return {
      move(sample) {
        if (ending) return
        latest = sample
        notify()
      },
      end(sample) {
        if (!ending) {
          if (sample) latest = sample
          ending = true
          notify()
        }
        return finished
      },
    }
  }
}
