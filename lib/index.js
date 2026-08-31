/**
 * dsh-granular-prompt — host half.
 *
 * The prompt-composition manager:
 *
 *   census        GET  /granular-prompt/census(?session=)
 *   suppression   POST /granular-prompt/suppressed     { name, suppressed }
 *   replacement   POST /granular-prompt/replacement     { name, text|null }
 *   library CRUD  POST /granular-prompt/library         { kind, op, id?, name?, text? }
 *   selections    POST /granular-prompt/active          { kind, id|mode|null }
 *
 * Mechanisms:
 * - The census calls systemPrompt.assemble({agent, scope}) directly with a
 *   BYPASS MARKER our waterfall listener honors — the control surface must
 *   see the UNFILTERED table (Case 25: a self-filtering surface eats its
 *   own controls).
 * - ONE waterfall listener, fixed pipeline: suppress -> replace. Filter
 *   failures fall through unfiltered (assembly can never break).
 * - The two USER SECTIONS are REGISTERED sections with provider functions
 *   (complete is a registration-time property — the registry restores a
 *   registered complete section AFTER the waterfall, so purist mode cannot
 *   be imposed by mutation):
 *     user:system  order -98  text = active system prompt (or empty)
 *     user:persona order   5  text = resolved persona (or empty)
 *   Providers re-read the in-memory store every assembly — switching a
 *   persona or system prompt applies to the NEXT request, no re-mount.
 *   `complete` mode re-registers user:system with complete:true.
 * - Persona resolution: the session's granular 'active-persona' setting ->
 *   the global 'default-persona' -> none ('inherit' falls through).
 * - The two DEFAULT selections ('default-persona', 'default-system-prompt')
 *   are granular global enums whose onChange is AUTHORITATIVE: the Plugin tab
 *   radio writes state + persists + doorbells. Boot seeds each setting from
 *   the store once (store wins), so both control surfaces never drift.
 *
 * Store: ~/.dsh/settings/prompt-manager.json (defensive reads, write-through
 * memory, serialized writes).
 */
export const name = 'granular-prompt'

export const inject = ['systemPrompt', 'webServer', 'fs', 'agents', 'granularSettings']

import { homedir } from 'node:os'

const HOME = process.env.DSH_HOME && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : homedir() + '/.dsh'
const STORE_FILE = HOME + '/settings/prompt-manager.json'

const NS = 'prompt-manager'
const SYSTEM_SECTION = 'user:system'
const PERSONA_SECTION = 'user:persona'

const msg = (error) => String((error && error.message) || error)

const slugOf = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

const previewOf = (text) => {
  const flat = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim()
  return flat.length <= 140 ? flat : flat.slice(0, 140) + '…'
}

export function apply(ctx) {
  const systemPrompt = ctx.systemPrompt
  const webServer = ctx.webServer
  const granularSettings = ctx.granularSettings

  // ---- store: memory serves, file persists ----
  const state = {
    suppressed: [],            // section names
    replacements: {},          // section name -> text
    systemPrompts: [],         // [{ id, name, text }]
    activeSystemPrompt: null,  // id
    systemMode: 'additive',    // 'additive' | 'complete'
    personas: [],              // [{ id, name, text }]
    defaultPersona: null,      // id
  }

  let tail = Promise.resolve()
  const readStore = async () => {
    try {
      const raw = await ctx.fs.readText(await ctx.fs.resolve(STORE_FILE))
      const parsed = raw === '' ? {} : JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      if (Array.isArray(parsed.suppressed)) state.suppressed = parsed.suppressed.filter((n) => typeof n === 'string' && n !== '' && n.length <= 200)
      if (parsed.replacements !== null && typeof parsed.replacements === 'object' && !Array.isArray(parsed.replacements)) {
        for (const [name, text] of Object.entries(parsed.replacements)) {
          if (typeof name === 'string' && typeof text === 'string' && text.length <= 100000) state.replacements[name] = text
        }
      }
      const cleanLib = (list) => Array.isArray(list)
        ? list.filter((e) => e !== null && typeof e === 'object' && typeof e.id === 'string' && typeof e.name === 'string'
          && typeof e.text === 'string' && e.text.length <= 100000)
          .map((e) => ({ id: e.id.slice(0, 40), name: e.name.slice(0, 60), text: e.text }))
        : []
      state.systemPrompts = cleanLib(parsed.systemPrompts)
      state.personas = cleanLib(parsed.personas)
      if (typeof parsed.activeSystemPrompt === 'string') state.activeSystemPrompt = parsed.activeSystemPrompt
      if (parsed.systemMode === 'complete') state.systemMode = 'complete'
      if (typeof parsed.defaultPersona === 'string') state.defaultPersona = parsed.defaultPersona
    } catch (e) { /* absent/corrupt reads as defaults */ }
  }
  const persistStore = () => {
    tail = tail.then(async () => {
      const body = JSON.stringify(state, null, 2) + '\n'
      await ctx.fs.writeText(await ctx.fs.resolve(STORE_FILE), body, undefined, undefined,
        { mode: 'workspace-write', workspaceRoot: HOME + '/settings' })
    })
    return tail
  }
  tail = tail.then(() => readStore())

  const suppressedNames = () => new Set(state.suppressed)
  const systemPromptById = (id) => state.systemPrompts.find((e) => e.id === id)
  const personaById = (id) => state.personas.find((e) => e.id === id)

  // ---- the two registered user sections ----
  const activeSystemText = () => {
    const entry = systemPromptById(state.activeSystemPrompt)
    return entry !== undefined ? entry.text : ''
  }
  const personaTextForSession = async (sessionId) => {
    if (sessionId === undefined || sessionId === null) return ''
    try {
      const selection = personaSelectionSetting
      if (selection === undefined) return ''
      const value = await selection.get(sessionId)
      if (typeof value === 'string' && value !== '' && value !== 'inherit') {
        const persona = personaById(value)
        if (persona !== undefined) return persona.text
      }
    } catch (e) { /* settings unavailable: fall through to default */ }
    const fallback = personaById(state.defaultPersona)
    return fallback !== undefined ? fallback.text : ''
  }
  // The persona provider needs a SYNC answer per assembly (providers may be
  // functions evaluated synchronously), but the session setting is async.
  // Resolution: a small write-through mirror keyed by sessionId, refreshed
  // by the granular onChange + doorbell; assemblies read the mirror and, on
  // a miss, fall back to the default persona (never stale-wrong for long).
  const personaMirror = new Map()      // sessionId -> personaId | 'inherit' | undefined
  let personaSelectionSetting = undefined
  const refreshPersonaMirror = async () => {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || personaSelectionSetting === undefined) return
    try {
      for (const sid of personaMirror.keys()) {
        personaMirror.set(sid, await personaSelectionSetting.get(sid))
      }
    } catch (e) { /* mirror refresh is best-effort */ }
  }
  const personaTextProvider = (assemblyContext) => {
    const agent = assemblyContext !== null && typeof assemblyContext === 'object' ? assemblyContext.agent : undefined
    const sid = agent !== null && typeof agent === 'object' && typeof agent.id === 'string' ? agent.id : undefined
    if (sid !== undefined && personaMirror.has(sid)) {
      const value = personaMirror.get(sid)
      if (typeof value === 'string' && value !== '' && value !== 'inherit') {
        const persona = personaById(value)
        if (persona !== undefined) return persona.text
      }
    }
    const fallback = personaById(state.defaultPersona)
    return fallback !== undefined ? fallback.text : ''
  }

  let offSystemSection = undefined
  const registerSystemSection = () => {
    if (offSystemSection !== undefined) { try { offSystemSection() } catch (e) {} }
    offSystemSection = systemPrompt.section({
      name: SYSTEM_SECTION,
      order: -98,
      complete: state.systemMode === 'complete',
      text: () => activeSystemText(),
    })
  }
  const offPersonaSection = systemPrompt.section({
    name: PERSONA_SECTION,
    order: 5,
    text: personaTextProvider,
  })
  registerSystemSection()

  // Boot uniqueness guard: our names must not collide with anything.
  // (A duplicate registration throws by registry design — assert ours clean.)
  const assertSectionNamesFree = async () => {
    try {
      const markerFree = {}
      const assembly = await systemPrompt.assemble(markerFree)
      for (const section of (assembly.sections || [])) {
        if (section.name === SYSTEM_SECTION || section.name === PERSONA_SECTION) {
          // present because WE registered them — fine; collision would have thrown at section()
        }
      }
    } catch (e) { /* registry duplicates throw at registration time already */ }
  }
  tail = tail.then(() => assertSectionNamesFree())

  // ---- ONE waterfall listener: bypass -> suppress -> replace ----
  const CENSUS_MARKER = '__granularPromptCensus'
  ctx.on('system-prompt/assemble', (assembly, context, next) => {
    try {
      if (context !== null && typeof context === 'object' && context[CENSUS_MARKER] === true) {
        return next()
      }
      const suppressed = suppressedNames()
      if (Array.isArray(assembly.sections)) {
        let sections = assembly.sections
        if (suppressed.size > 0) {
          sections = sections.filter((section) => !suppressed.has(section.name))
        }
        if (Object.keys(state.replacements).length > 0) {
          sections = sections.map((section) => {
            const replacement = state.replacements[section.name]
            return replacement === undefined ? section : { ...section, text: replacement }
          })
        }
        assembly.sections = sections
      }
    } catch (e) { /* render unfiltered rather than fail the request */ }
    return next()
  })

  // ---- doorbell (optional transport) ----
  const publishChange = () => {
    const relay = ctx.get('eventRelay')
    if (relay === undefined) return
    try { relay.publish('granular-prompt/change', null) } catch (e) { /* push degrades to pull */ }
  }
  ctx.on('system-prompt/change', () => { publishChange() })
  const changeAndPersist = async () => { await persistStore(); publishChange() }

  // ---- granular settings: persona selections (dynamic options) ----
  const personaOptionList = () => [
    { value: 'inherit', label: 'Inherit (default persona)' },
    ...state.personas.map((p) => ({ value: p.id, label: p.name })),
  ]
  const defaultPersonaOptionList = () => [
    { value: 'none', label: 'None' },
    ...state.personas.map((p) => ({ value: p.id, label: p.name })),
  ]
  personaSelectionSetting = granularSettings.register({
    namespace: NS, owner: 'Prompt Manager', scope: 'session',
    key: 'active-persona', type: 'enum', label: 'Active persona',
    description: 'Persona text applied to this session (Persona section). Inherit uses the default persona.',
    options: personaOptionList, defaultValue: 'inherit',
    onChange: (value, target) => {
      if (typeof target === 'string' && target !== '') {
        personaMirror.set(target, value)
        refreshPersonaMirror()
      }
      publishChange()
    },
  })
  const defaultPersonaSetting = granularSettings.register({
    namespace: NS, owner: 'Prompt Manager', scope: 'global',
    key: 'default-persona', type: 'enum', label: 'Default persona',
    description: 'Persona applied when a session inherits.',
    options: defaultPersonaOptionList, defaultValue: 'none',
    onChange: (value) => {
      const entry = value === 'none' || value === undefined ? undefined : personaById(String(value))
      const id = entry !== undefined ? entry.id : null
      if (state.defaultPersona === id) return
      state.defaultPersona = id
      changeAndPersist().catch(() => {})
    },
  })
  // Composer picker visibility (read reactively client-side; the host only
  // owns persistence here).
  const composerPickerSetting = granularSettings.register({
    namespace: NS, owner: 'Prompt Manager', scope: 'global',
    key: 'composer-persona-picker', type: 'toggle',
    label: 'Persona picker in chat composer',
    description: 'Show the active-persona selector at the left end of the chat input tool row.',
    defaultValue: true,
  })
  const systemPromptOptionList = () => [
    { value: 'none', label: 'None' },
    ...state.systemPrompts.map((e) => ({ value: e.id, label: e.name })),
  ]
  const defaultSystemPromptSetting = granularSettings.register({
    namespace: NS, owner: 'Prompt Manager', scope: 'global',
    key: 'default-system-prompt', type: 'enum', label: 'Default system prompt',
    description: 'System prompt applied to every session (the user:system section). None keeps the deployment default.',
    options: systemPromptOptionList, defaultValue: 'none',
    onChange: (value) => {
      const entry = value === 'none' || value === undefined ? undefined : systemPromptById(String(value))
      const id = entry !== undefined ? entry.id : null
      if (state.activeSystemPrompt === id) return
      state.activeSystemPrompt = id
      changeAndPersist().catch(() => {})
    },
  })
  const refreshPersonaMirrorSeed = async () => {
    const sessions = ctx.get('sessions')
    if (sessions === undefined || typeof sessions.list !== 'object' || personaSelectionSetting === undefined) return
    try {
      for (const sid of Object.keys(sessions.list.byId || {})) {
        personaMirror.set(sid, await personaSelectionSetting.get(sid))
      }
    } catch (e) { /* best effort */ }
  }

  // seed the mirror for live sessions at boot
  tail = tail.then(async () => { await refreshPersonaMirrorSeed() })

  // seed the granular default-selection controls from the store (store wins,
  // once): both Plugin-tab radios then start in agreement with the census
  tail = tail.then(async () => {
    const seedSelectionSetting = async (setting, id, library) => {
      if (setting === undefined) return
      const value = typeof id === 'string' && library.some((e) => e.id === id) ? id : 'none'
      try { await setting.set('global', value) } catch (e) { /* best-effort mirror */ }
    }
    await seedSelectionSetting(defaultSystemPromptSetting, state.activeSystemPrompt, state.systemPrompts)
    await seedSelectionSetting(defaultPersonaSetting, state.defaultPersona, state.personas)
  })

  // ---- routes ----
  const sendJson = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 256 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
  const parseObjectBody = async (req) => {
    const body = JSON.parse(await readBody(req))
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('object body required')
    return body
  }

  const disposers = []

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/granular-prompt/census',
    handler: async (req, res) => {
      try {
        await tail.then(() => undefined)
        const url = new URL(req.url, 'http://localhost')
        const sessionId = url.searchParams.get('session')
        let assembleContext = {}
        let scopeName = 'global'
        if (sessionId !== null && sessionId !== '') {
          const agent = ctx.agents.get(sessionId)
          if (agent !== undefined) { assembleContext = { agent: agent, scope: agent }; scopeName = 'session' }
        }
        assembleContext[CENSUS_MARKER] = true
        const assembly = await systemPrompt.assemble(assembleContext)
        const sections = (Array.isArray(assembly.sections) ? assembly.sections : [])
          .map((section, index) => ({
            name: String(section.name),
            index,
            textPreview: previewOf(section.text),
            fullText: String(section.text === undefined || section.text === null ? '' : section.text),
            rendersEmpty: previewOf(section.text) === '',
          }))
        const contexts = (Array.isArray(assembly.contexts) ? assembly.contexts : [])
          .map((ctxEntry, index) => ({
            name: String(ctxEntry.name),
            index,
            textPreview: previewOf(ctxEntry.text),
            fullText: String(ctxEntry.text === undefined || ctxEntry.text === null ? '' : ctxEntry.text),
          }))
        sendJson(res, 200, {
          scope: scopeName,
          sections, contexts,
          suppressed: [...state.suppressed],
          replacements: Object.keys(state.replacements),
          replacementTexts: state.replacements,
          systemPrompts: state.systemPrompts.map((e) => ({ id: e.id, name: e.name, text: e.text })),
          activeSystemPrompt: state.activeSystemPrompt,
          systemMode: state.systemMode,
          personas: state.personas.map((e) => ({ id: e.id, name: e.name, text: e.text })),
          defaultPersona: state.defaultPersona,
        })
      } catch (error) { sendJson(res, 500, { error: msg(error) }) }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/granular-prompt/suppressed',
    handler: async (req, res) => {
      try {
        const body = await parseObjectBody(req)
        const name = body.name
        if (typeof name !== 'string' || name === '' || name.length > 200) throw new Error('name must be a non-empty string (max 200)')
        if (body.suppressed === true) {
          if (!state.suppressed.includes(name)) state.suppressed.push(name)
          // mutual exclusivity: suppressing clears any replacement
          if (state.replacements[name] !== undefined) delete state.replacements[name]
        } else if (body.suppressed === false) {
          state.suppressed = state.suppressed.filter((n) => n !== name)
        } else throw new Error('suppressed must be a boolean')
        await changeAndPersist()
        sendJson(res, 200, { ok: true, suppressed: [...state.suppressed] })
      } catch (error) { sendJson(res, 400, { error: msg(error) }) }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/granular-prompt/replacement',
    handler: async (req, res) => {
      try {
        const body = await parseObjectBody(req)
        const name = body.name
        if (typeof name !== 'string' || name === '' || name.length > 200) throw new Error('name must be a non-empty string (max 200)')
        if (body.text === null) {
          delete state.replacements[name]
        } else if (typeof body.text === 'string' && body.text.length <= 100000) {
          state.replacements[name] = body.text
          // mutual exclusivity: replacing clears suppression
          state.suppressed = state.suppressed.filter((n) => n !== name)
        } else throw new Error('text must be a string (max 100000) or null to revert')
        await changeAndPersist()
        sendJson(res, 200, { ok: true, replacements: Object.keys(state.replacements) })
      } catch (error) { sendJson(res, 400, { error: msg(error) }) }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/granular-prompt/library',
    handler: async (req, res) => {
      try {
        const body = await parseObjectBody(req)
        const kind = body.kind === 'systemPrompt' ? 'systemPrompts' : body.kind === 'persona' ? 'personas' : undefined
        if (kind === undefined) throw new Error('kind must be "systemPrompt" or "persona"')
        const list = state[kind]
        if (body.op === 'create') {
          if (typeof body.name !== 'string' || body.name.trim() === '' || body.name.length > 60) throw new Error('name required (max 60)')
          const text = typeof body.text === 'string' ? body.text.slice(0, 100000) : ''
          let id = slugOf(body.name)
          if (id === '') id = 'entry'
          let candidate = id, n = 2
          while (list.some((e) => e.id === candidate)) { candidate = id + '-' + n; n += 1 }
          list.push({ id: candidate, name: body.name.trim(), text: text })
          await changeAndPersist()
          sendJson(res, 200, { ok: true, id: candidate })
        } else if (body.op === 'update') {
          const entry = list.find((e) => e.id === body.id)
          if (entry === undefined) throw new Error('unknown id')
          if (body.name !== undefined) {
            if (typeof body.name !== 'string' || body.name.trim() === '') throw new Error('name must be non-empty')
            entry.name = body.name.trim().slice(0, 60)
          }
          if (body.text !== undefined) {
            if (typeof body.text !== 'string' || body.text.length > 100000) throw new Error('text too long')
            entry.text = body.text
          }
          await changeAndPersist()
          sendJson(res, 200, { ok: true })
        } else if (body.op === 'delete') {
          const id = body.id
          const before = list.length
          state[kind] = list.filter((e) => e.id !== id)
          if (state[kind].length === before) throw new Error('unknown id')
          if (kind === 'systemPrompts' && state.activeSystemPrompt === id) {
            state.activeSystemPrompt = null
            try { await defaultSystemPromptSetting.set('global', 'none') } catch (e) { /* mirror best-effort */ }
          }
          if (kind === 'personas' && state.defaultPersona === id) {
            state.defaultPersona = null
            try { await defaultPersonaSetting.set('global', 'none') } catch (e) { /* mirror best-effort */ }
            personaMirror.forEach((value, sid) => { if (value === id) personaMirror.set(sid, 'inherit') })
          }
          await changeAndPersist()
          sendJson(res, 200, { ok: true })
        } else throw new Error('op must be create, update, or delete')
      } catch (error) { sendJson(res, 400, { error: msg(error) }) }
    },
  }))

  disposers.push(webServer.register({
    kind: 'exact',
    path: '/granular-prompt/active',
    handler: async (req, res) => {
      try {
        const body = await parseObjectBody(req)
        if (body.kind === 'system') {
          const entry = body.id === null ? undefined : state.systemPrompts.find((e) => e.id === body.id)
          if (body.id !== null && entry === undefined) throw new Error('unknown system prompt id')
          state.activeSystemPrompt = body.id === null ? null : body.id
          try { await defaultSystemPromptSetting.set('global', entry !== undefined ? entry.id : 'none') } catch (e) { /* best effort */ }
        } else if (body.kind === 'defaultPersona') {
          const entry = body.id === null || body.id === 'none' ? undefined : state.personas.find((e) => e.id === body.id)
          if (body.id !== null && body.id !== 'none' && entry === undefined) throw new Error('unknown persona id')
          state.defaultPersona = entry !== undefined ? entry.id : null
          try { await defaultPersonaSetting.set('global', entry !== undefined ? entry.id : 'none') } catch (e) { /* best effort */ }
        } else if (body.kind === 'systemMode') {
          if (body.mode !== 'additive' && body.mode !== 'complete') throw new Error('mode must be additive or complete')
          state.systemMode = body.mode
          registerSystemSection()   // complete is registration-time: re-register
        } else throw new Error('kind must be system, defaultPersona, or systemMode')
        await changeAndPersist()
        sendJson(res, 200, { ok: true })
      } catch (error) { sendJson(res, 400, { error: msg(error) }) }
    },
  }))

  return () => {
    for (const dispose of disposers) { try { dispose() } catch (e) {} }
    try { if (offSystemSection !== undefined) offSystemSection() } catch (e) {}
    try { offPersonaSection() } catch (e) {}
    try { personaSelectionSetting.dispose() } catch (e) {}
    try { defaultPersonaSetting.dispose() } catch (e) {}
    try { defaultSystemPromptSetting.dispose() } catch (e) {}
    try { composerPickerSetting.dispose() } catch (e) {}
  }
}
