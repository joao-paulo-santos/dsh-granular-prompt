
const padSrc = require('fs').readFileSync('/mnt/prometheus/Dev/Repos/Dsh-Plugins/dsh-scratchpad/lib/client.js','utf8')
const gsSrc = require('fs').readFileSync('/mnt/prometheus/Dev/Repos/Dsh-Plugins/dsh-granular-settings/lib/client.js','utf8')
const gpSrc = require('fs').readFileSync(__dirname + '/../lib/client.js','utf8')
let padC, gsC, gpC
global.window = { __ModuleLoader__: { load: (d) => { if (d.id.includes('scratch')) padC = d; else if (d.id.includes('granular-prompt')) gpC = d; else gsC = d } }, addEventListener(){}, removeEventListener(){} }
global.document = { createElement: () => ({ dataset: {}, remove(){}, getContext: () => ({ font: '', measureText: (t) => ({ width: t.length * 7.5 }) }) }), head: { appendChild(){} }, addEventListener(){}, removeEventListener(){}, activeElement: null }
let censusResponse = null
let posts = []
global.fetch = (url, opts) => {
  if (String(url).includes('/granular-prompt/census')) return Promise.resolve({ ok: true, json: async () => censusResponse })
  if (opts && opts.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true, json: async () => ({ ok: true }) }) }
  return Promise.resolve({ ok: true, json: async () => ({ registrations: [], globalValues: {}, workspaceValues: {}, sessionValues: {} }) })
}
eval(padSrc); eval(gsSrc); eval(gpSrc)
let hookIdx = 0; const hookSlots = {}
const freshHooks = () => { for (const k of Object.keys(hookSlots)) delete hookSlots[k] }
const R = { useState: (v) => { const i = hookIdx++; if (!(i in hookSlots)) hookSlots[i] = v; return [hookSlots[i], (fn) => { hookSlots[i] = typeof fn === 'function' ? fn(hookSlots[i]) : fn }] }, useEffect: (fn) => { fn(); return () => {} }, useRef: (v) => ({ current: v }), createElement: (t, p, ...k) => ({ type: t, props: p || {}, kids: k.flat(Infinity) }) }
const mkCtx = (injectList, provided) => { const declared = new Set(injectList)
  const ctx = { get: (n) => (declared.has(n) ? provided[n] : undefined), provide: (n, a) => { provided[n] = a }, on: () => () => {} }
  for (const name of ['slots', 'granularSettings', 'granularSettingsClient', 'scratchpad', 'eventRelay']) Object.defineProperty(ctx, name, { get() { if (!declared.has(name)) throw new Error('cannot get property "' + name + '" without inject'); return provided[name] } })
  return ctx }
let SectionComp, PadComp
const slotsApi = { inject: (k, fn) => { fn(); return () => {} }, register: (o, C) => { if (o.id === 'granular') SectionComp = C; if (o.id === 'scratchpad') PadComp = C; return C } }
const provided = { slots: slotsApi, eventRelay: { subscribe: () => () => {} } }
let failures = 0
const check = (name, fn) => { try { fn(); console.log('  ok ' + name) } catch (e) { failures++; console.log('  FAIL ' + name + ' - ' + e.message) } }
;(async () => {
  check('inject guard at apply', () => {
    try { gpC.factory((id) => R).apply(mkCtx(['granularSettings'], provided)); throw new Error('guard-missed') }
    catch (e) { if (!/without inject/.test(String(e.message))) throw e } })
  padC.factory((id) => R).apply(mkCtx(['slots'], provided))
  gsC.factory((id) => R).apply(mkCtx(['eventRelay', 'slots'], provided))
  gpC.factory((id) => R).apply(mkCtx(['granularSettings', 'scratchpad', 'slots'], provided))
  console.log('  ok three plugins mounted; Prompt tab registered via registerTab')
  censusResponse = { scope: 'session', sections: [
    { name: 'harness:identity', index: 0, textPreview: 'You…', fullText: 'You are an AI agent powered by DeepSeek Harness.', rendersEmpty: false },
    { name: 'tool:read', index: 1, textPreview: 'read…', fullText: 'Use the read tool — not shell commands like cat.', rendersEmpty: false },
    { name: 'tool:goal', index: 2, textPreview: 'goal', fullText: 'goal tools', rendersEmpty: false },
  ], contexts: [], suppressed: [], replacements: ['tool:goal'], systemPrompts: [{ id: 'terse-core', name: 'Terse Core' }], activeSystemPrompt: 'terse-core', systemMode: 'additive', personas: [{ id: 'reviewer', name: 'Reviewer' }], defaultPersona: 'reviewer' }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const findEl = (t, pred, out = []) => { if (t == null) return out; if (Array.isArray(t)) { for (const k of t) findEl(k, pred, out); return out } if (typeof t === 'object') { if (pred(t)) out.push(t); for (const k of (t.kids || [])) findEl(k, pred, out) } return out }
  const findComp = (t) => { const walk = (n) => { if (n == null || typeof n !== 'object') return null; if (Array.isArray(n)) { for (const k of n) { const r = walk(k); if (r) return r } return null } if (typeof n.type === 'function') return n; for (const k of (n.kids || [])) { const r = walk(k); if (r) return r } return null }; return walk(t) }
  const rowOf = (tree, name) => { const r = findEl(tree, (n) => n.props && n.props.className === 'gp-row' && JSON.stringify(n.kids).includes(name)); if (r.length === 0) throw new Error('row not found: ' + name); return r[0] }
  const renderSection = () => { hookIdx = 0; freshHooks(); return SectionComp({ useSessions: (sel) => sel({ current: 's1' }) }) }
  const renderPad = () => { hookIdx = 0; freshHooks(); return PadComp() }
  let SectionTabEl
  // two-pass tab render: mount+fetch settles, then re-render for content
  const renderPrompt = async () => {
    hookIdx = 0; freshHooks()
    SectionTabEl.type(SectionTabEl.props)          // mount (fetch fires)
    await wait(20)
    hookIdx = 0; freshHooks()
    const tabTree = SectionTabEl.type(SectionTabEl.props)   // content pass
    const sub = findComp(tabTree)
    if (sub === null) return tabTree
    hookIdx = 0; freshHooks()
    return sub.type(sub.props)
  }
  let t = null
  renderSection(); await wait(20)
  t = renderSection()
  findEl(t, (n) => n.type === 'button' && n.kids[0] === 'Prompt')[0].props.onClick()
  t = renderSection()
  SectionTabEl = findComp(t)
  let inner = await renderPrompt()
  check('live list rows + replaced badge', () => {
    if (!JSON.stringify(inner).includes('tool:goal')) throw new Error('rows')
    if (!JSON.stringify(inner).includes('replaced')) throw new Error('badge') })
  findEl(rowOf(inner, 'tool:read'), (n) => n.type === 'button' && n.props.className === 'gp-icon' && n.kids[0] === '\u29E2'.replace('\u29E2','\u29E2')) // noop guard against encoding
  const viewBtn = findEl(rowOf(inner, 'tool:read'), (n) => n.type === 'button' && n.props.className === 'gp-icon')[0]
  viewBtn.props.onClick()
  check('view opens the real pad (read mode, right text)', () => {
    const padTree = renderPad()
    if (padTree === null) throw new Error('closed')
    const area = findEl(padTree, (n) => n.type === 'textarea')[0]
    if (!String(area.props.value).includes('cat')) throw new Error('text')
    if (area.props.readOnly !== true) throw new Error('not readOnly') })
  posts.length = 0
  const editBtn = findEl(rowOf(inner, 'tool:read'), (n) => n.type === 'button' && n.props.className === 'gp-icon' && n.kids[0] === '\u270E')[0]
  editBtn.props.onClick()
  findEl(renderPad(), (n) => n.type === 'textarea')[0].props.onChange({ target: { value: 'MY REPLACEMENT' } })
  findEl(renderPad(), (n) => n.type === 'button' && n.kids[0] === 'Save')[0].props.onClick()
  await wait(20)
  check('replace round-trip via the real pad', () => {
    const rep = posts.find((p) => p.url.includes('replacement'))
    if (!rep || rep.body.text !== 'MY REPLACEMENT' || rep.body.name !== 'tool:read') throw new Error('payload: ' + JSON.stringify(posts)) })
  posts.length = 0
  inner = await renderPrompt()
  const unchecked = findEl(inner, (n) => n.type === 'input' && n.props.type === 'checkbox').find((c) => c.props.checked !== true)
  check('suppress checkbox POSTs', () => {
    if (unchecked === undefined) throw new Error('no unchecked box')
    unchecked.props.onChange({ target: { checked: true } }) })
  await wait(20)
  check('suppress POST observed', () => { if (!posts.some((p) => p.url.includes('suppressed'))) throw new Error('missing') })
  hookIdx = 0; freshHooks()
  let tabTree = SectionTabEl.type(SectionTabEl.props)
  findEl(tabTree, (n) => n.type === 'button' && n.kids[0] === 'System prompts')[0].props.onClick()
  inner = await renderPrompt()
  posts.length = 0
  findEl(inner, (n) => n.type === 'button' && n.kids[0] === 'Complete')[0].props.onClick()
  await wait(20)
  check('system mode POST', () => { if (!posts.some((p) => p.url.includes('active') && p.body.kind === 'systemMode')) throw new Error('missing') })
  hookIdx = 0; freshHooks()
  tabTree = SectionTabEl.type(SectionTabEl.props)
  findEl(tabTree, (n) => n.type === 'button' && n.kids[0] === 'Personas')[0].props.onClick()
  inner = await renderPrompt()
  posts.length = 0
  findEl(inner, (n) => n.type === 'input' && n.props.type === 'radio')[0].props.onChange({ target: {} })
  await wait(20)
  check('persona default POST', () => { if (!posts.some((p) => p.url.includes('active') && p.body.kind === 'defaultPersona')) throw new Error('missing') })

  // ---- rename flow (Personas, already mounted) ----
  posts.length = 0
  const reviewerName = findEl(inner, (n) => n.props && n.props.className === 'gp-name gp-name-editable' && String(n.kids[0]) === 'Reviewer')
  check('library names are click-to-rename', () => { if (reviewerName.length === 0) throw new Error('editable name span missing') })
  reviewerName[0].props.onClick()
  inner = await renderPrompt()
  const renameInput = findEl(inner, (n) => n.type === 'input' && n.props['aria-label'] === 'Rename Reviewer')
  check('rename input seeds the current name (controlled)', () => {
    if (renameInput.length === 0) throw new Error('no rename input')
    if (renameInput[0].props.value !== 'Reviewer') throw new Error('seed value: ' + renameInput[0].props.value) })
  renameInput[0].props.onChange({ target: { value: 'Strict Reviewer' } })
  inner = await renderPrompt()
  findEl(inner, (n) => n.type === 'button' && n.props['aria-label'] === 'Save name')[0].props.onClick()
  await wait(20)
  check('rename POST carries the new name', () => {
    const renamePost = posts.find((p) => p.url.includes('library') && p.body.op === 'update')
    if (!renamePost || renamePost.body.name !== 'Strict Reviewer' || renamePost.body.kind !== 'persona') throw new Error('payload: ' + JSON.stringify(posts)) })

  // ---- personas: None pinned row selects no-default ----
  posts.length = 0
  censusResponse = Object.assign({}, censusResponse, { defaultPersona: null })
  inner = await renderPrompt()
  const noneRadio = findEl(inner, (n) => n.type === 'input' && n.props.type === 'radio' && n.props.name === 'gp-default-persona' && n.props.checked === true)
  check('None row is the checked default when none set', () => { if (noneRadio.length === 0) throw new Error('none radio not checked') })

  // ---- system prompts: Default pinned row + named create ----
  censusResponse = Object.assign({}, censusResponse, {
    activeSystemPrompt: null,
    sections: censusResponse.sections.concat([
      { name: 'deployment:persona', index: 3, textPreview: 'The deployment persona text\u2026', fullText: 'FULL DEPLOYMENT PERSONA TEXT', rendersEmpty: false },
    ]),
  })
  hookIdx = 0; freshHooks()
  tabTree = SectionTabEl.type(SectionTabEl.props)
  findEl(tabTree, (n) => n.type === 'button' && n.kids[0] === 'System prompts')[0].props.onClick()
  inner = await renderPrompt()
  posts.length = 0
  const defaultRadio = findEl(inner, (n) => n.type === 'input' && n.props.type === 'radio' && n.props.name === 'gp-active-system' && n.props.checked === true)
  check('Default row renders from the census and is checked', () => {
    if (defaultRadio.length === 0) throw new Error('default radio not checked')
    if (!JSON.stringify(inner).includes('deployment:persona')) throw new Error('deployment badge missing') })
  defaultRadio[0].props.onChange({ target: {} })
  await wait(20)
  check('selecting Default POSTs id null', () => {
    if (!posts.some((p) => p.url.includes('active') && p.body.kind === 'system' && p.body.id === null)) throw new Error('missing') })
  findEl(inner, (n) => n.type === 'button' && n.props['aria-label'] === 'View default system prompt')[0].props.onClick()
  check('default row views the deployment persona text', () => {
    const padTree = renderPad()
    const area = findEl(padTree, (n) => n.type === 'textarea')[0]
    if (!String(area.props.value).includes('FULL DEPLOYMENT')) throw new Error('text')
    if (area.props.readOnly !== true) throw new Error('not readOnly') })

  // create with a name: draft round-trip, pad save posts the name
  posts.length = 0
  inner = await renderPrompt()
  const draftInput = findEl(inner, (n) => n.type === 'input' && n.props['aria-label'] === 'New system prompt name')[0]
  draftInput.props.onChange({ target: { value: 'Terse Reviewer' } })
  inner = await renderPrompt()
  check('create draft survives re-render (controlled input)', () => {
    const again = findEl(inner, (n) => n.type === 'input' && n.props['aria-label'] === 'New system prompt name')[0]
    if (again.props.value !== 'Terse Reviewer') throw new Error('draft lost: ' + again.props.value) })
  findEl(inner, (n) => n.type === 'button' && n.kids[0] === '+ Create system prompt')[0].props.onClick()
  const createArea = findEl(renderPad(), (n) => n.type === 'textarea')[0]
  check('create opens the pad editable', () => { if (createArea.props.readOnly === true) throw new Error('readOnly') })
  createArea.props.onChange({ target: { value: 'BODY TEXT' } })
  findEl(renderPad(), (n) => n.type === 'button' && n.kids[0] === 'Save')[0].props.onClick()
  await wait(20)
  check('create POST carries the typed name', () => {
    const createPost = posts.find((p) => p.url.includes('library') && p.body.op === 'create')
    if (!createPost || createPost.body.kind !== 'systemPrompt' || createPost.body.name !== 'Terse Reviewer' || createPost.body.text !== 'BODY TEXT') throw new Error('payload: ' + JSON.stringify(posts)) })

  // empty draft: inline rejection, no POST (banner lives in the PromptTab tree)
  posts.length = 0
  inner = await renderPrompt()
  findEl(inner, (n) => n.type === 'button' && n.kids[0] === '+ Create system prompt')[0].props.onClick()
  hookIdx = 0; freshHooks()
  const bannerTree = SectionTabEl.type(SectionTabEl.props)
  check('empty name create is rejected inline', () => {
    const banner = findEl(bannerTree, (n) => n.props && n.props.className === 'gp-error')
    if (banner.length === 0 || !JSON.stringify(banner).includes('Enter a name')) throw new Error('no inline error')
    if (posts.some((p) => p.url.includes('library') && p.body.op === 'create')) throw new Error('posted anyway') })
  console.log(failures === 0 ? 'CLIENT: ALL PASS' : 'CLIENT: ' + failures + ' FAILURES')
  process.exit(failures === 0 ? 0 : 1)
})().catch(e => { console.error(e); process.exit(1) })
