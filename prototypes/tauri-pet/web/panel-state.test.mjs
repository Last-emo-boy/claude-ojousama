import test from 'node:test'
import assert from 'node:assert/strict'
import { readDrafts, restoreDrafts } from './panel-state.mjs'
import { restoredSelection } from './model.mjs'

test('reopening selects tasks created while unloaded but preserves deliberate history otherwise', () => {
  const tasks=[{id:1,createdAt:10},{id:2,createdAt:20},{id:3,createdAt:30}]
  assert.equal(restoredSelection(tasks,{selected:1,taskIds:[1,2]}),3)
  assert.equal(restoredSelection(tasks,{selected:1,taskIds:[1,2,3]}),1)
  assert.equal(restoredSelection(tasks,{selected:1,taskIds:[]}),3)
  assert.equal(restoredSelection(tasks,null),null)
})

function fixture() {
  const fields=[{id:'model',type:'text',value:'unsaved'},{id:'enabled',type:'checkbox',checked:false},
    {id:'permission',type:'select-one',value:'read-only'},{id:'notes',type:'textarea',value:'两行\n草稿'}]
  const forms=[{id:'settings',querySelectorAll:()=>fields},{id:'untouched',querySelectorAll:()=>[{id:'new-value',value:'old'}]}]
  return {fields,root:{querySelectorAll:()=>forms}}
}

test('only edited forms survive renderer disposal, including empty, false and multiline values', () => {
  const {root,fields}=fixture(),dirty=new Set(['settings'])
  fields[0].value=''
  const snapshot=readDrafts(root,dirty)
  assert.deepEqual(snapshot,{settings:{model:'',enabled:false,permission:'read-only',notes:'两行\n草稿'}})
  fields[0].value='server default';fields[1].checked=true;fields[3].value=''
  restoreDrafts(root,snapshot)
  assert.equal(fields[0].value,'');assert.equal(fields[1].checked,false);assert.equal(fields[3].value,'两行\n草稿')
  assert.equal(Object.hasOwn(snapshot,'untouched'),false)
})

test('missing old controls do not overwrite new defaults or manufacture consent', () => {
  const {root,fields}=fixture()
  restoreDrafts(root,{settings:{removed:'old',enabled:'true'}})
  assert.equal(fields[0].value,'unsaved')
  assert.equal(fields[1].checked,false)
})
