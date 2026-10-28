import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { frameGeometry, createSheetCache } from './sprites.mjs'

test('CSS frames retain every atlas frame, foot offset, one-shot and reduced-motion geometry', () => {
  for (const file of ['../../../assets/sprites/manifest.json','../../../assets/sprites-extra/manifest.json']) {
    const manifest = JSON.parse(fs.readFileSync(new URL(file, import.meta.url)))
    for (const sheet of Object.values(manifest.anims)) {
      for (let index=0; index<sheet.frames*2; index++) {
        const frame=sheet.loop===false?Math.min(index,sheet.frames-1):index%sheet.frames
        const scale=sheet.displayHeight?sheet.displayHeight/sheet.h:1.35
        assert.deepEqual(frameGeometry(sheet,index),{frame,scale,width:sheet.w*scale,height:sheet.h*scale,
          x:(180-sheet.w*scale)/2,y:180-sheet.h*scale+(sheet.offsetsY?.[frame]??sheet.offsetY??0)})
        assert.equal(frameGeometry(sheet,index,true).frame,0)
      }
    }
  }
})

test('decoded sheets are bounded, shared while loading, and evicted actions reload without losing frames', async () => {
  const calls=[]
  const cache=createSheetCache(async name=>{calls.push(name);return{name,frames:4}},3)
  const a=cache.load('idle'),b=cache.load('idle')
  assert.equal(a,b)
  await a
  await cache.load('walk');await cache.load('climb');cache.get('idle');await cache.load('wave')
  assert.equal(cache.get('walk'),undefined)
  assert.equal(cache.get('idle').frames,4)
  assert.equal((await cache.load('walk')).frames,4)
  assert.deepEqual(calls,['idle','walk','climb','wave','walk'])
})

test('failed loads report their error and can be retried rather than poisoning the cache', async () => {
  let attempts=0
  const cache=createSheetCache(async()=>{if(++attempts===1)throw Error('missing sheet');return{frames:4}})
  await assert.rejects(cache.load('wave'),/missing sheet/)
  assert.equal((await cache.load('wave')).frames,4)
})
