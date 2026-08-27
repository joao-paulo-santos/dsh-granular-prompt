const padSrc = require('fs').readFileSync('/mnt/prometheus/Dev/Repos/Dsh-Plugins/dsh-scratchpad/lib/client.js','utf8')
const adSrc = require('fs').readFileSync('/mnt/prometheus/Dev/Repos/Dsh-Plugins/dsh-approval-diff/lib/client.js','utf8')
const gsSrc = require('fs').readFileSync('/mnt/prometheus/Dev/Repos/Dsh-Plugins/dsh-granular-settings/lib/client.js','utf8')
const gpSrc = require('fs').readFileSync(__dirname + '/../lib/client.js','utf8')
const captures = {}
global.window = { __ModuleLoader__: { load: (d) => { captures[d.id] = d } }, addEventListener(){}, removeEventListener(){} }
global.document = { createElement: () => ({ dataset: {}, remove(){}, getContext: () => ({ font:'', measureText:(t)=>({width:0}) }) }), head: { appendChild(){} }, addEventListener(){}, removeEventListener(){}, activeElement: null }
let posts = []
let censusResponse = null
global.fetch = (url, opts) => {
  if (String(url).includes('/granular-prompt/census')) return Promise.resolve({ ok: true, json: async () => censusResponse })
  if (opts && opts.method === 'POST') { posts.push({ url: String(url), body: JSON.parse(opts.body) }); return Promise.resolve({ ok: true, json: async () => ({ ok: true }) }) }
  return Promise.resolve({ ok: true, json: async () => ({ registrations: [], globalValues: {}, workspaceValues: {}, sessionValues: {} }) })
}
eval(adSrc); eval(padSrc); eval(gsSrc); eval(gpSrc)
let hookIdx = 0; const hookSlots = {}
const fresh = () => { for (const k of Object.keys(hookSlots)) delete hookSlots[k] }
const R = { useState: (v) => { const i = hookIdx++; if (!(i in hookSlots)) hookSlots[i] = v; return [hookSlots[i], (fn) => { hookSlots[i] = typeof fn === 'function' ? fn(hookSlots[i]) : fn }] }, useEffect: (fn) => { fn(); return () => {} }, useRef: (v) => ({ current: v }), createElement: (t, p, ...k) => ({ type: t, props: p || {}, kids: k.flat(Infinity) }) }
const mkCtx = (l, p) => { const d = new Set(l); const ctx = { get: (n) => p[n], provide: (n, a) => { p[n] = a }, on: () => () => {} }
  for (const n of ['slots','granularSettings','granularSettingsClient','scratchpad','approvalDiffView','eventRelay']) Object.defineProperty(ctx, n, { get() { if (!d.has(n)) throw new Error('no ' + n); return p[n] } }); return ctx }
let SectionComp, PadOverlay
const slotsApi = { inject: (k, fn) => { fn(); return () => {} }, register: (o, C) => { if (o.id === 'granular') SectionComp = C; if (o.id === 'scratchpad') PadOverlay = C; return C } }
const provided = { slots: slotsApi, eventRelay: { subscribe: () => () => {} } }
captures['dsh-approval-diff'].factory((id) => R).apply({ get: () => undefined, provide: (n, a) => { provided[n] = a }, on: () => () => {}, slots: { inject: () => () => {}, register: () => () => {} } })
captures['dsh-scratchpad'].factory((id) => R).apply(mkCtx(['slots'], provided))
captures['dsh-granular-settings'].factory((id) => R).apply(mkCtx(['eventRelay', 'slots'], provided))
captures['dsh-granular-prompt'].factory((id) => R).apply(mkCtx(['granularSettings', 'scratchpad', 'slots'], provided))
censusResponse = { scope: 'session', sections: [
  { name: 'tool:read', index: 0, textPreview: 'read', fullText: 'Use the read tool — not shell commands like cat.', rendersEmpty: false },
], contexts: [], suppressed: [], replacements: ['tool:read'], replacementTexts: { 'tool:read': 'READ THE FILES.' }, systemPrompts: [], activeSystemPrompt: null, systemMode: 'additive', personas: [], defaultPersona: null }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const find = (t, pred, out = []) => { if (t == null) return out; if (Array.isArray(t)) { for (const k of t) find(k, pred, out); return out } if (typeof t === 'object') { if (pred(t)) out.push(t); for (const k of (t.kids || [])) find(k, pred, out) } return out }
const findFn = (t) => { const walk = (n) => { if (n == null || typeof n !== 'object') return null; if (Array.isArray(n)) { for (const k of n) { const r = walk(k); if (r) return r } return null } if (typeof n.type === 'function') return n; for (const k of (n.kids || [])) { const r = walk(k); if (r) return r } return null }; return walk(t) }
const renderSection = () => { hookIdx = 0; fresh(); return SectionComp({ useSessions: (sel) => sel({ current: 's1' }) }) }
const renderPad = () => { hookIdx = 0; fresh(); return PadOverlay() }
let SectionTabEl
const openReplacements = async () => {
  renderSection(); await wait(20)
  let t = renderSection()
  find(t, (n) => n.type === 'button' && n.kids[0] === 'Prompt')[0].props.onClick()
  t = renderSection()
  SectionTabEl = findFn(t)
  hookIdx = 0; fresh(); SectionTabEl.type(SectionTabEl.props); await wait(20)
  // switch to Replacements subtab
  hookIdx = 0; fresh()
  let tree = SectionTabEl.type(SectionTabEl.props)
  const btn = find(tree, (n) => n.type === 'button' && n.kids[0] === 'Replacements')
  if (btn.length === 0) throw new Error('Replacements button missing')
  btn[0].props.onClick()
  await wait(15)
  hookIdx = 0; fresh()
  tree = SectionTabEl.type(SectionTabEl.props)
  const sub = findFn(tree)
  if (sub === null) throw new Error('no subtab body')
  hookIdx = 0; fresh()
  return sub.type(sub.props)
}
;(async () => {
  let inner = await openReplacements()
  const j = JSON.stringify(inner)
  if (!j.includes('tool:read') || !j.includes('READ THE FILES')) throw new Error('row/preview: ' + j.slice(0, 150))
  console.log('1. row shows the replacement preview')
  const iconBtns = find(inner, (n) => n.type === 'button' && n.props.className === 'gp-icon')
  const glyphs = iconBtns.map((b) => b.kids[0])
  if (glyphs.join() !== '\u21C4,\u270E,\u21BA') throw new Error('actions: ' + glyphs.join())
  console.log('2. three actions: \u21C4 diff, \u270E edit, \u21BA revert')
  // diff
  iconBtns[0].props.onClick()
  const padTree = renderPad()
  if (padTree === null) {
    // dump the tab's error banner (fail() wrote it)
    hookIdx = 0; fresh()
    const dbgTree = SectionTabEl.type(SectionTabEl.props)
    const dbgSub = findFn(dbgTree)
    hookIdx = 0; fresh()
    const dbgInner = dbgSub.type(dbgSub.props)
    throw new Error('pad closed; tab banner: ' + JSON.stringify(dbgInner).slice(0, 300))
  }
  const diffComp = findFn(padTree)
  hookIdx = 0
  const dj = JSON.stringify(diffComp.type(diffComp.props))
  if (!dj.includes('adf-diffview-grid') || !dj.includes('adf-del')) throw new Error('grid: ' + dj.slice(0, 120))
  console.log('3. \u21C4 opens the pad in DIFF mode (real grid, red/green)')
  // close pad
  const closeBtn = find(padTree, (n) => n.type === 'button' && n.props['aria-label'] === 'Close scratch pad')
  closeBtn[0].props.onClick()
  // edit
  posts.length = 0
  inner = await openReplacements()
  const editBtn = find(inner, (n) => n.type === 'button' && n.props.className === 'gp-icon' && n.kids[0] === '\u270E')[0]
  editBtn.props.onClick()
  const padTree2 = renderPad()
  const area = find(padTree2, (n) => n.type === 'textarea')[0]
  if (String(area.props.value) !== 'READ THE FILES.') throw new Error('seed: ' + area.props.value)
  area.props.onChange({ target: { value: 'EDITED' } })
  find(renderPad(), (n) => n.type === 'button' && n.kids[0] === 'Save')[0].props.onClick()
  await wait(20)
  const rep = posts.find((p) => p.url.includes('replacement'))
  if (!rep || rep.body.text !== 'EDITED') throw new Error('edit: ' + JSON.stringify(posts))
  console.log('4. \u270E seeds the current replacement; edit -> Save -> POST')
  // revert asks
  posts.length = 0
  inner = await openReplacements()
  find(inner, (n) => n.type === 'button' && n.props.className === 'gp-icon' && n.kids[0] === '\u21BA')[0].props.onClick()
  await wait(10)
  hookIdx = 0; fresh()
  const tree = SectionTabEl.type(SectionTabEl.props)
  const sub = findFn(tree)
  hookIdx = 0; fresh()
  const confirmInner = sub.type(sub.props)
  if (!JSON.stringify(confirmInner).includes('Delete your replacement')) throw new Error('no confirm')
  if (posts.length !== 0) throw new Error('revert fired early')
  find(confirmInner, (n) => n.type === 'button' && n.kids[0] === 'Yes, revert')[0].props.onClick()
  await wait(20)
  if (!posts.some((p) => p.url.includes('replacement') && p.body.text === null)) throw new Error('no revert POST')
  console.log('5. \u21BA asks; Yes -> POST { text: null }')
  console.log('REPLACEMENTS: ALL PASS')
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
