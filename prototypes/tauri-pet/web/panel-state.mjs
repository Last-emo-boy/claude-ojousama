// Only edited forms are retained, in native session memory rather than storage.
export function readFields(root) {
  return Object.fromEntries([...root.querySelectorAll('input[id],select[id],textarea[id]')].map(field => [field.id,
    field.type === 'checkbox' || field.type === 'radio' ? field.checked : field.value]))
}
export function restoreFields(root, fields = {}) {
  for (const field of root.querySelectorAll('input[id],select[id],textarea[id]')) {
    if (!Object.hasOwn(fields, field.id)) continue
    if (field.type === 'checkbox' || field.type === 'radio') field.checked = fields[field.id] === true
    else field.value = fields[field.id]
  }
}
export function readDrafts(root, dirty) {
  return Object.fromEntries([...root.querySelectorAll('form')].filter(form => dirty.has(form.id)).map(form => [form.id, readFields(form)]))
}
export function restoreDrafts(root, drafts = {}) {
  for (const form of root.querySelectorAll('form')) if(drafts[form.id])restoreFields(form,drafts[form.id])
}
