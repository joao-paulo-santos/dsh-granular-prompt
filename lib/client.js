/**
 * dsh-granular-prompt — browser half (hand-authored client bundle).
 *
 * Registers the "Prompt" tab into Granular Settings (via
 * granularSettings.registerTab). Four subtabs:
 *
 *   Live list      census rows: suppress checkbox · view (scratchpad read) ·
 *                  replace (scratchpad edit) · revert; replaced/suppressed badges
 *   Replacements   managed list of name -> replacement
 *   System prompts Default (deployment persona, pinned row) + named library +
 *                  active selection + additive/complete mode
 *   Personas       None (pinned row) + named library + default selection
 *                  (per-session selection lives in the Session tab as the
 *                  active-persona enum)
 *
 * Library entries are created WITH a name (create row input) and renamed by
 * clicking the name (inline input, Enter/Escape).
 *
 * All text editing goes through the scratchpad service (read + edit modes).
 * Liveness: granular-prompt/change doorbell (optional relay) + focus refetch.
 */
window.__ModuleLoader__.load({ id: 'dsh-granular-prompt', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  const React = require('react')
  // The shell's own dropdown primitive: what the access-mode picker beside
  // us composes (positioning, outside-click, keyboard, item chrome ship
  // with its package CSS).
  const { Menu, IconChevronDownOutline14, IconUserOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives')

  // ---- shared module store ----
  const listeners = new Set()
  const notifyListeners = () => { for (const fn of listeners) { try { fn() } catch (e) {} } }
  let census = undefined            // last census response
  let currentSessionId = undefined  // cacheKey of the mounted tab
  let clickError = undefined        // transient failure message (inline)

  const fetchCensus = () => {
    const url = currentSessionId === undefined
      ? '/granular-prompt/census'
      : '/granular-prompt/census?session=' + encodeURIComponent(currentSessionId)
    return fetch(url)
      .then((r) => (r.ok ? r.json() : null)).then((body) => {
        if (body !== null && typeof body === 'object') { census = body; notifyListeners() }
      }, () => {})
  }

  const post = (path, body) => fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => (r.ok ? r.json() : r.json().then((j) => { throw new Error(j.error || ('HTTP ' + r.status)) })))

  const fail = (error) => { clickError = 'Action failed: ' + String((error && error.message) || error); notifyListeners() }

  const suppressSection = (name, suppressed) => {
    post('/granular-prompt/suppressed', { name, suppressed })
      .then(() => fetchCensus(), (e) => { fail(e); fetchCensus() })
  }
  const replaceSection = (name, text) => {
    post('/granular-prompt/replacement', { name, text })
      .then(() => fetchCensus(), (e) => { fail(e); fetchCensus() })
  }
  const revertReplacement = (name) => {
    post('/granular-prompt/replacement', { name, text: null })
      .then(() => fetchCensus(), (e) => { fail(e); fetchCensus() })
  }
  const libraryOp = (payload) => post('/granular-prompt/library', payload).then(fetchCensus, (e) => { fail(e); fetchCensus() })
  const activeOp = (payload) => post('/granular-prompt/active', payload).then(fetchCensus, (e) => { fail(e); fetchCensus() })

  let scratchpadService = undefined
  let settingsService = undefined   // granularSettings (hooks + metadata)

  const viewInPad = (title, text) => {
    try { scratchpadService.open({ title, text }) } catch (e) { fail(e) }
  }
  const editInPad = (title, text, onSave) => {
    try { scratchpadService.open({ title, text, editable: true, onSave }) } catch (e) { fail(e) }
  }

  // ---- the tab ----
  const SUBTABS = [
    { id: 'list', label: 'Live list' },
    { id: 'replacements', label: 'Replacements' },
    { id: 'system', label: 'System prompts' },
    { id: 'personas', label: 'Personas' },
  ]

  const subtabMemory = new Map()   // cacheKey -> subtab id (Case 23: survives remounts)

  // ---- composer persona selector (conversation.input.left seat) ----
  // The chat card equivalent of the Session tab's "Active persona": same
  // setting, same write path, read and written through the granularSettings
  // facade so the picker, the tab, and the host waterfall can never see
  // different state. Menu rendering is the shell's own primitive — the same
  // component the access-mode picker beside us uses. Renders only when the
  // persona library is non-empty.
  const PERSONA_NS = 'prompt-manager'
  const PersonaCombo = () => {
    const [value, write, , busy] = settingsService.useSetting(PERSONA_NS, 'session', 'active-persona')
    const reg = settingsService.getRegistration(PERSONA_NS, 'session', 'active-persona')
    const options = reg !== undefined && Array.isArray(reg.options) ? reg.options : []
    if (options.filter((o) => o.value !== 'inherit').length === 0) return null
    const [open, setOpen] = React.useState(false)
    const current = options.find((o) => o.value === value)
      || options.find((o) => o.value === 'inherit')
      || options[0]
    return React.createElement(Menu, {      open: open === true,
      side: 'top',
      items: options.map((o) => ({
        id: o.value,
        label: o.label,
        // Person glyphs make "these are people the model plays" legible
        // even when a persona is named something arbitrary.
        icon: React.createElement(IconUserOutline16),
      })),
      selectedId: typeof value === 'string' ? value : 'inherit',
      onSelect: (id) => { write(id); setOpen(false) },
      onClose: () => { setOpen(false) },
      anchor: React.createElement('button', {
        type: 'button',
        className: 'gp-composer-btn' + (busy ? ' gp-composer-busy' : ''),
        'aria-haspopup': 'menu',
        'aria-expanded': open === true ? 'true' : 'false',
        title: 'Active persona for this session',
        onClick: () => { setOpen(!open) },
      },
      React.createElement(IconUserOutline16, null),
      React.createElement('span', { className: 'gp-composer-label' }, current.label),
      React.createElement('span', {
        className: 'gp-composer-chevron' + (open ? ' gp-composer-chevron-open' : ''),
        style: { display: 'inline-flex' },
      }, React.createElement(IconChevronDownOutline14, null))),
    })
  }

  // Seat entry: visibility of the picker is itself the global
  // 'composer-persona-picker' setting (default on). Wrapper keeps hook
  // order stable for the inner combo across show/hide transitions.
  const PersonaSeat = () => {
    const [show] = settingsService.useSetting(PERSONA_NS, 'global', 'composer-persona-picker')
    if (show !== true) return null
    return React.createElement(PersonaCombo)
  }

  const PromptTab = (props) => {
    const sessionId = props.useSessions !== undefined ? props.useSessions((s) => s.current) : undefined
    currentSessionId = sessionId === undefined || sessionId === null ? undefined : sessionId
    const cacheKey = currentSessionId === undefined ? '' : currentSessionId

    const [, force] = React.useState(0)
    React.useEffect(() => {
      const listener = () => force((n) => n + 1)
      listeners.add(listener)
      fetchCensus()
      return () => { listeners.delete(listener) }
    }, [cacheKey])

    const [subtab, setSubtabState] = React.useState(subtabMemory.get(cacheKey) || 'list')
    const setSubtab = (id) => { subtabMemory.set(cacheKey, id); setSubtabState(id) }
    React.useEffect(() => { setSubtabState(subtabMemory.get(cacheKey) || 'list') }, [cacheKey])

    const strip = React.createElement('div', { className: 'gp-subtabs' },
      SUBTABS.map((t) => React.createElement('button', {
        key: t.id, type: 'button',
        className: 'gp-subtab' + (subtab === t.id ? ' gp-subtab-active' : ''),
        onClick: () => { setSubtab(t.id) },
      }, t.label)))

    const errorBanner = clickError !== undefined
      ? React.createElement('p', { className: 'gp-error', onClick: () => { clickError = undefined; notifyListeners() } }, clickError + ' (click to dismiss)')
      : null

    if (census === undefined) {
      return React.createElement('div', { className: 'gp-page' }, strip, errorBanner,
        React.createElement('p', { className: 'gp-empty' }, 'Loading prompt census…'))
    }

    let body = null
    if (subtab === 'list') body = React.createElement(LiveList)
    else if (subtab === 'replacements') body = React.createElement(ReplacementsList)
    else if (subtab === 'system') body = React.createElement(SystemPrompts)
    else body = React.createElement(Personas)

    return React.createElement('div', { className: 'gp-page' }, strip, errorBanner, body)
  }

  const sectionSafeName = (section) => section !== null && typeof section === 'object' && typeof section.name === 'string' ? section.name : ''

  const LiveList = () => {
    const suppressedSet = new Set(Array.isArray(census.suppressed) ? census.suppressed : [])
    const replacedSet = new Set(Array.isArray(census.replacements) ? census.replacements : [])
    const rows = Array.isArray(census.sections) ? census.sections : []
    const suppressedCount = rows.filter((s) => suppressedSet.has(s.name)).length
    const replacedCount = rows.filter((s) => replacedSet.has(s.name) && !suppressedSet.has(sectionSafeName(s))).length
    const scopeNote = census.scope === 'global'
      ? ' No session attached: global sections only.' : ''
    return React.createElement('div', { className: 'gp-section' },
      React.createElement('p', { className: 'gp-note' },
        rows.length + ' sections render'
        + (suppressedCount > 0 ? ' · ' + suppressedCount + ' suppressed on next request' : '')
        + (replacedCount > 0 ? ' · ' + replacedCount + ' replaced' : '')
        + '.' + scopeNote),
      React.createElement('div', { className: 'gp-rows' },
        rows.map((section) => {
          const suppressed = suppressedSet.has(section.name)
          const replaced = replacedSet.has(section.name)
          const isPendingRevert = pendingRevertName === section.name
          if (isPendingRevert) {
            return React.createElement('div', {
              key: section.name,
              className: 'gp-row gp-row-confirm' + (suppressed ? ' gp-row-off' : ''),
            },
              React.createElement('span', { className: 'gp-name' }, section.name),
              React.createElement('span', { className: 'gp-confirm' },
                'Delete your replacement and restore the original?',
                React.createElement('button', {
                  type: 'button', className: 'gp-btn gp-btn-danger gp-btn-mini',
                  onClick: () => { pendingRevertName = undefined; revertReplacement(section.name) },
                }, 'Yes, revert'),
                React.createElement('button', {
                  type: 'button', className: 'gp-btn gp-btn-secondary gp-btn-mini',
                  onClick: () => { pendingRevertName = undefined; notifyListeners() },
                }, 'Keep')))
          }
          return React.createElement('div', {
            key: section.name,
            className: 'gp-row' + (suppressed ? ' gp-row-off' : ''),
          },
            React.createElement('input', {
              type: 'checkbox', className: 'gp-check',
              checked: suppressed,
              title: suppressed ? 'Suppressed: uncheck to restore' : 'Rendering: check to suppress',
              onChange: (e) => { suppressSection(section.name, e.target.checked) },
            }),
            React.createElement('span', { className: 'gp-index' }, String(section.index + 1)),
            React.createElement('span', { className: 'gp-name' }, section.name),
            replaced === true ? React.createElement('span', { className: 'gp-badge gp-badge-replaced' }, 'replaced') : null,
            section.rendersEmpty === true ? React.createElement('span', { className: 'gp-badge' }, 'empty') : null,
            React.createElement('span', { className: 'gp-preview', title: section.textPreview }, section.textPreview),
            React.createElement('button', {
              type: 'button', className: 'gp-icon', title: 'Open full text in the scratch pad',
              'aria-label': 'View ' + section.name,
              onClick: () => { viewInPad(section.name, section.fullText) },
            }, '⤢'),
            React.createElement('button', {
              type: 'button', className: 'gp-icon', title: 'Replace this section\u2019s text (edit in the scratch pad)',
              'aria-label': 'Replace ' + section.name,
              onClick: () => {
                const replacementTexts = census.replacementTexts !== null && typeof census.replacementTexts === 'object' ? census.replacementTexts : {}
                const effectiveText = replaced === true && typeof replacementTexts[section.name] === 'string'
                  ? replacementTexts[section.name]
                  : section.fullText
                editInPad('Replace: ' + section.name, effectiveText, (text) => { replaceSection(section.name, text) })
              },
            }, '✎'),
            replaced === true ? React.createElement('button', {
              type: 'button', className: 'gp-icon', title: 'View old vs new diff',
              'aria-label': 'Diff ' + section.name,
              onClick: () => {
                const texts = census.replacementTexts !== null && typeof census.replacementTexts === 'object' ? census.replacementTexts : {}
                try {
                  scratchpadService.open({ mode: 'diff', title: section.name, before: section.fullText, after: texts[section.name] })
                } catch (e) { fail(e) }
              },
            }, '⇄') : null,
            replaced === true ? React.createElement('button', {
              type: 'button', className: 'gp-icon', title: 'Revert to the original text (asks first)',
              'aria-label': 'Revert ' + section.name,
              onClick: () => { pendingRevertName = section.name; notifyListeners() },
            }, '↺') : null)
        })))
  }

  // Revert confirmation state (module scope — Case 23): the name awaiting
  // confirmation, or undefined. Deleting user-crafted text must be explicit.
  let pendingRevertName = undefined

  const ReplacementsList = () => {
    const replacedSet = new Set(Array.isArray(census.replacements) ? census.replacements : [])
    const rows = Array.isArray(census.sections) ? census.sections : []
    const replacedRows = rows.filter((s) => replacedSet.has(s.name))
    const replacementTexts = census.replacementTexts !== null && typeof census.replacementTexts === 'object' ? census.replacementTexts : {}
    return React.createElement('div', { className: 'gp-section' },
      React.createElement('p', { className: 'gp-note' }, 'Replaced sections keep their position and name; the text is yours. Replacements are keyed by section name across scopes.'),
      replacedRows.length === 0
        ? React.createElement('p', { className: 'gp-empty' }, 'No replacements. Use \u270E on the Live list to replace a section\u2019s text.')
        : React.createElement('div', { className: 'gp-rows' }, replacedRows.map((section) => {
            const isPendingRevert = pendingRevertName === section.name
            return React.createElement('div', { key: section.name, className: 'gp-row' + (isPendingRevert ? ' gp-row-confirm' : '') },
              React.createElement('span', { className: 'gp-name' }, section.name),
              isPendingRevert
                ? React.createElement('span', { className: 'gp-confirm' },
                    'Delete your replacement and restore the original?',
                    React.createElement('button', {
                      type: 'button', className: 'gp-btn gp-btn-danger gp-btn-mini',
                      onClick: () => { pendingRevertName = undefined; revertReplacement(section.name) },
                    }, 'Yes, revert'),
                    React.createElement('button', {
                      type: 'button', className: 'gp-btn gp-btn-secondary gp-btn-mini',
                      onClick: () => { pendingRevertName = undefined; notifyListeners() },
                    }, 'Keep'))
                : React.createElement('span', { className: 'gp-preview', title: typeof replacementTexts[section.name] === 'string' ? replacementTexts[section.name].slice(0, 400) : '' },
                    typeof replacementTexts[section.name] === 'string' ? replacementTexts[section.name].replace(/\s+/g, ' ').slice(0, 120) : ''),
              !isPendingRevert
                ? React.createElement('button', {
                    type: 'button', className: 'gp-icon', title: 'View old vs new diff',
                    'aria-label': 'Diff ' + section.name,
                    onClick: () => {
                      try {
                        scratchpadService.open({ mode: 'diff', title: section.name, before: section.fullText, after: replacementTexts[section.name] })
                      } catch (e) { fail(e) }
                    },
                  }, '\u21C4')
                : null,
              !isPendingRevert
                ? React.createElement('button', {
                    type: 'button', className: 'gp-icon', title: 'Edit the replacement text',
                    'aria-label': 'Edit replacement ' + section.name,
                    onClick: () => {
                      editInPad('Replacement: ' + section.name, typeof replacementTexts[section.name] === 'string' ? replacementTexts[section.name] : '', (text) => { replaceSection(section.name, text) })
                    },
                  }, '\u270E')
                : null,
              !isPendingRevert
                ? React.createElement('button', {
                    type: 'button', className: 'gp-icon', title: 'Revert to the original text (asks first)',
                    'aria-label': 'Revert ' + section.name,
                    onClick: () => { pendingRevertName = section.name; notifyListeners() },
                  }, '\u21BA')
                : null)
          })))
  }

  // ---- shared library row pieces (System prompts + Personas) ----

  // Rename state (module scope — Case 23): the library entry whose name is
  // being edited, or undefined. Library entries are recognized by NAME, so
  // every entry must be named meaningfully at creation.
  let pendingRename = undefined            // { kind: 'systemPrompt'|'persona', id, value }

  const beginRename = (kind, entry) => {
    pendingRename = { kind: kind, id: entry.id, value: entry.name }
    notifyListeners()
  }
  const cancelRename = () => { pendingRename = undefined; notifyListeners() }
  const commitRename = () => {
    if (pendingRename === undefined) return
    const name = String(pendingRename.value === undefined ? '' : pendingRename.value).trim().slice(0, 60)
    if (name === '') { clickError = 'Name must not be empty.'; notifyListeners(); return }
    const renameOf = pendingRename
    pendingRename = undefined
    libraryOp({ kind: renameOf.kind, op: 'update', id: renameOf.id, name: name })
  }
  const renderLibraryName = (kind, entry) => {
    if (pendingRename !== undefined && pendingRename.kind === kind && pendingRename.id === entry.id) {
      return React.createElement('span', { className: 'gp-rename' },
        React.createElement('input', {
          type: 'text', className: 'gp-input gp-rename-input', value: pendingRename.value,
          'aria-label': 'Rename ' + entry.name,
          onChange: (e) => { pendingRename.value = e.target.value; notifyListeners() },
          onKeyDown: (e) => {
            if (e.key === 'Enter') commitRename()
            else if (e.key === 'Escape') cancelRename()
          },
        }),
        React.createElement('button', {
          type: 'button', className: 'gp-icon', title: 'Save the new name', 'aria-label': 'Save name',
          onClick: () => { commitRename() },
        }, '\u2713'),
        React.createElement('button', {
          type: 'button', className: 'gp-icon', title: 'Cancel renaming', 'aria-label': 'Cancel rename',
          onClick: () => { cancelRename() },
        }, '\u2715'))
    }
    return React.createElement('span', {
      className: 'gp-name gp-name-editable', title: 'Rename (click the name)',
      onClick: () => { beginRename(kind, entry) },
    }, entry.name)
  }

  const previewOfText = (text) => typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 120) : ''

  // Create drafts (module scope — Case 23). Controlled inputs: every keystroke
  // updates the draft and notifies, or React reverts the field (Case 28).
  let newSystemPromptDraft = ''
  let newPersonaDraft = ''
  const setNewSystemPromptDraft = (value) => { newSystemPromptDraft = value; notifyListeners() }
  const setNewPersonaDraft = (value) => { newPersonaDraft = value; notifyListeners() }

  const renderLibraryCreate = (kind, noun, draft, setDraft) => {
    const createNow = () => {
      const name = draft.trim().slice(0, 60)
      if (name === '') { clickError = 'Enter a name for the new ' + noun + ' first.'; notifyListeners(); return }
      editInPad('New ' + noun + ': ' + name, '', (text) => {
        setDraft('')
        libraryOp({ kind: kind, op: 'create', name: name, text: text })
      })
    }
    return React.createElement('div', { className: 'gp-create' },
      React.createElement('input', {
        type: 'text', className: 'gp-input', placeholder: 'Name for the new ' + noun,
        value: draft, 'aria-label': 'New ' + noun + ' name',
        onChange: (e) => { setDraft(e.target.value) },
        onKeyDown: (e) => { if (e.key === 'Enter') createNow() },
      }),
      React.createElement('button', {
        type: 'button', className: 'gp-btn gp-btn-secondary',
        onClick: createNow,
      }, '+ Create ' + noun))
  }

  const SystemPrompts = () => {
    const library = Array.isArray(census.systemPrompts) ? census.systemPrompts : []
    const active = census.activeSystemPrompt
    const mode = census.systemMode === 'complete' ? 'complete' : 'additive'
    const deploymentPersona = (Array.isArray(census.sections) ? census.sections : [])
      .find((section) => section.name === 'deployment:persona')
    return React.createElement('div', { className: 'gp-section' },
      React.createElement('p', { className: 'gp-note' },
        mode === 'complete'
          ? 'COMPLETE mode: your active system prompt becomes the ENTIRE prompt (all other sections suppressed after assembly). Conflicts with a preset complete persona fail loudly by design.'
          : 'ADDITIVE mode: your system prompt renders as its own section near the top, everything else unchanged.'),
      React.createElement('div', { className: 'gp-modebar' },
        React.createElement('button', {
          type: 'button', className: 'gp-btn' + (mode === 'additive' ? ' gp-btn-primary' : 'gp-btn-secondary'),
          onClick: () => { activeOp({ kind: 'systemMode', mode: 'additive' }) },
        }, 'Additive'),
        React.createElement('button', {
          type: 'button', className: 'gp-btn' + (mode === 'complete' ? ' gp-btn-primary' : 'gp-btn-secondary'),
          onClick: () => { activeOp({ kind: 'systemMode', mode: 'complete' }) },
        }, 'Complete')),
      React.createElement('div', { className: 'gp-rows' },
        React.createElement('div', {
          key: 'default',
          className: 'gp-row' + (active === null || active === undefined ? ' gp-row-active' : ''),
        },
          React.createElement('input', {
            type: 'radio', className: 'gp-check', name: 'gp-active-system',
            checked: active === null || active === undefined,
            title: 'Use the deployment\u2019s own persona (no custom system prompt)',
            onChange: () => { activeOp({ kind: 'system', id: null }) },
          }),
          React.createElement('span', { className: 'gp-name' }, 'Default'),
          active === null || active === undefined ? React.createElement('span', { className: 'gp-badge gp-badge-active' }, 'active') : null,
          React.createElement('span', { className: 'gp-badge' }, 'deployment:persona'),
          React.createElement('span', {
            className: 'gp-preview',
            title: deploymentPersona !== undefined && typeof deploymentPersona.fullText === 'string' ? deploymentPersona.fullText : '',
          }, deploymentPersona !== undefined && previewOfText(deploymentPersona.textPreview) !== ''
            ? previewOfText(deploymentPersona.textPreview)
            : '(deployment persona renders empty)'),
          deploymentPersona !== undefined ? React.createElement('button', {
            type: 'button', className: 'gp-icon',
            title: 'View the deployment\u2019s default prompt text',
            'aria-label': 'View default system prompt',
            onClick: () => { viewInPad('Default system prompt (deployment:persona)', deploymentPersona.fullText) },
          }, '\u29E2') : null),
        library.map((entry) => React.createElement('div', {
          key: entry.id,
          className: 'gp-row' + (active === entry.id ? ' gp-row-active' : ''),
        },
          React.createElement('input', {
            type: 'radio', className: 'gp-check', name: 'gp-active-system',
            checked: active === entry.id,
            title: 'Activate this system prompt',
            onChange: () => { activeOp({ kind: 'system', id: entry.id }) },
          }),
          renderLibraryName('systemPrompt', entry),
          active === entry.id ? React.createElement('span', { className: 'gp-badge gp-badge-active' }, 'active') : null,
          React.createElement('span', {
            className: 'gp-preview', title: typeof entry.text === 'string' ? entry.text.slice(0, 400) : '',
          }, previewOfText(entry.text)),
          React.createElement('button', { type: 'button', className: 'gp-icon', title: 'Edit text', onClick: () => {
            editInPad('System prompt: ' + entry.name, typeof entry.text === 'string' ? entry.text : '', (text) => { libraryOp({ kind: 'systemPrompt', op: 'update', id: entry.id, text }) })
          } }, '✎'),
          React.createElement('button', { type: 'button', className: 'gp-icon', title: 'Delete', onClick: () => { libraryOp({ kind: 'systemPrompt', op: 'delete', id: entry.id }) } }, '✕')))),
      React.createElement('div', { className: 'gp-actions' },
        renderLibraryCreate('systemPrompt', 'system prompt', newSystemPromptDraft, setNewSystemPromptDraft)))
  }

  const Personas = () => {
    const library = Array.isArray(census.personas) ? census.personas : []
    const active = census.defaultPersona
    const noDefault = active === null || active === undefined
    return React.createElement('div', { className: 'gp-section' },
      React.createElement('p', { className: 'gp-note' },
        'Personas render as their own section after the deployment persona. The DEFAULT applies everywhere; per-session selection is the "Active persona" setting in the Session tab.'),
      React.createElement('div', { className: 'gp-rows' },
        React.createElement('div', {
          key: 'none',
          className: 'gp-row' + (noDefault ? ' gp-row-active' : ''),
        },
          React.createElement('input', {
            type: 'radio', className: 'gp-check', name: 'gp-default-persona',
            checked: noDefault,
            title: 'No default persona: inheriting sessions render no persona text',
            onChange: () => { activeOp({ kind: 'defaultPersona', id: 'none' }) },
          }),
          React.createElement('span', { className: 'gp-name' }, 'None'),
          noDefault ? React.createElement('span', { className: 'gp-badge gp-badge-active' }, 'default') : null,
          React.createElement('span', { className: 'gp-preview' }, 'No default persona: sessions set to Inherit render no persona text.')),
        library.map((entry) => React.createElement('div', {
          key: entry.id,
          className: 'gp-row' + (active === entry.id ? ' gp-row-active' : ''),
        },
          React.createElement('input', {
            type: 'radio', className: 'gp-check', name: 'gp-default-persona',
            checked: active === entry.id,
            title: 'Set as default persona',
            onChange: () => { activeOp({ kind: 'defaultPersona', id: entry.id }) },
          }),
          renderLibraryName('persona', entry),
          active === entry.id ? React.createElement('span', { className: 'gp-badge gp-badge-active' }, 'default') : null,
          React.createElement('span', {
            className: 'gp-preview', title: typeof entry.text === 'string' ? entry.text.slice(0, 400) : '',
          }, previewOfText(entry.text)),
          React.createElement('button', { type: 'button', className: 'gp-icon', title: 'Edit text', onClick: () => {
            editInPad('Persona: ' + entry.name, typeof entry.text === 'string' ? entry.text : '', (text) => { libraryOp({ kind: 'persona', op: 'update', id: entry.id, text }) })
          } }, '✎'),
          React.createElement('button', { type: 'button', className: 'gp-icon', title: 'Delete', onClick: () => { libraryOp({ kind: 'persona', op: 'delete', id: entry.id }) } }, '✕')))),
      React.createElement('div', { className: 'gp-actions' },
        renderLibraryCreate('persona', 'persona', newPersonaDraft, setNewPersonaDraft)))
  }

  module.exports = {
    name: 'granular-prompt-client',
    inject: ['granularSettings', 'scratchpad', 'slots'],
    apply(ctx) {
      scratchpadService = ctx.scratchpad
      const granular = ctx.granularSettings
      settingsService = granular

      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-granular-prompt'
      tag.textContent = [
        '.gp-page{display:flex;flex-direction:column;gap:18px}',
        '.gp-subtabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-label-tertiary);padding-bottom:0}',
        '.gp-subtab{font:inherit;font-size:12.5px;padding:6px 12px;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;border:none;border-bottom:2px solid transparent;opacity:.6;margin-bottom:-1px}',
        '.gp-subtab:hover{opacity:1}',
        '.gp-subtab-active{opacity:1;border-bottom-color:#3b82f6;font-weight:600}',
        '.gp-section{display:flex;flex-direction:column;gap:10px}',
        '.gp-note{margin:0;font-size:12px;opacity:.65}',
        '.gp-rows{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-label-tertiary);border-radius:12px;overflow:hidden}',
        '.gp-row{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--dsw-alias-bg-layer-1);font-size:12px}',
        '.gp-row + .gp-row{border-top:1px solid var(--dsw-alias-label-tertiary)}',
        '.gp-row-off .gp-name,.gp-row-off .gp-preview{opacity:.4;text-decoration:line-through}',
        '.gp-row-active{background:var(--dsw-alias-bg-layer-2)}',
        '.gp-check{flex:none;accent-color:#3b82f6;cursor:pointer}',
        '.gp-index{flex:none;min-width:24px;text-align:right;opacity:.45;font-family:ui-monospace,monospace}',
        '.gp-name{flex:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-weight:600}',
        '.gp-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7}',
        '.gp-badge{flex:none;font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-label-tertiary);opacity:.6}',
        '.gp-badge-replaced{border-color:#f59e0b;color:#f59e0b;opacity:1}',
        '.gp-badge-active{border-color:#3b82f6;color:#3b82f6;opacity:1}',
        '.gp-icon{flex:none;font:inherit;font-size:12px;width:24px;height:24px;line-height:1;cursor:pointer;border-radius:7px;border:1px solid var(--dsw-alias-label-tertiary);background:transparent;color:inherit;opacity:.55}',
        '.gp-composer{position:relative;flex:none}',
        /* Mirror ModelSelect.trigger: bordered-less 28px chip, secondary
           label tone, hover fill, focus ring. No white border. */
        '.gp-composer-btn{display:flex;align-items:center;gap:4px;font-size:13px;line-height:20px;font-weight:500;height:28px;padding:0 4px 0 8px;max-width:min(360px,45cqw);cursor:pointer;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-radius:24px;outline:none}',
        '.gp-composer-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.gp-composer-btn:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}',
        '.gp-composer-busy{opacity:.55;pointer-events:none}',
        '.gp-composer-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.gp-composer-chevron{flex:none;display:inline-flex;color:var(--dsw-alias-label-caption);transition:transform 120ms ease}',
        '.gp-composer-chevron-open{transform:rotate(180deg)}',
        '.gp-icon:hover{opacity:1;background:var(--dsw-alias-bg-layer-2)}',
        '.gp-actions{display:flex;gap:8px}',
        '.gp-input{font:inherit;font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);color:inherit;min-width:0}',
        '.gp-create{display:flex;gap:8px;flex:1;min-width:0}',
        '.gp-create .gp-input{flex:1}',
        '.gp-rename{flex:none;display:flex;align-items:center;gap:6px}',
        '.gp-rename-input{width:190px}',
        '.gp-name-editable{cursor:pointer;border-bottom:1px dotted transparent}',
        '.gp-name-editable:hover{border-bottom-color:currentColor}',
        '.gp-btn{font:inherit;font-size:12.5px;font-weight:600;padding:6px 14px;border-radius:9px;cursor:pointer;border:1px solid transparent}',
        '.gp-btn-primary{background:#3b82f6;color:#fff;border-color:#3b82f6}',
        '.gp-btn-secondary{background:transparent;color:inherit;border-color:var(--dsw-alias-label-tertiary)}',
        '.gp-modebar{display:flex;gap:8px}',
        '.gp-error{margin:0;padding:9px 12px;font-size:12px;color:#ef4444;border:1px solid #ef4444;border-radius:10px;cursor:pointer}',
        '.gp-row-confirm{background:rgba(239,68,68,.07)}',
        '.gp-confirm{flex:1;min-width:0;display:flex;align-items:center;gap:8px;font-size:12px;color:#ef4444;font-weight:600}',
        '.gp-btn-danger{background:#ef4444;color:#fff;border-color:#ef4444}',
        '.gp-btn-mini{font-size:11px;padding:4px 10px;border-radius:7px}',
        '.gp-empty{margin:0;padding:18px;font-size:12.5px;opacity:.55;border:1px dashed var(--dsw-alias-label-tertiary);border-radius:12px;text-align:center}',
      ].join('')
      document.head.appendChild(tag)

      // liveness: doorbell (optional relay) + focus
      let unsubscribeDoorbell = undefined
      const attachRelay = () => {
        const relay = ctx.get('eventRelay')
        if (relay === undefined || unsubscribeDoorbell !== undefined) return
        unsubscribeDoorbell = relay.subscribe('granular-prompt/change', () => { fetchCensus() })
      }
      attachRelay()
      const onWindowFocus = () => { attachRelay(); fetchCensus() }
      window.addEventListener('focus', onWindowFocus)

      const offTab = granular.registerTab({ id: 'prompt', label: 'Prompt', order: 40 }, PromptTab)

      // Composer persona picker: same "Active persona" session setting the
      // Session tab exposes, one click from wherever the user types.
      const offComposer = ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
        { name: 'conversation.input.left', id: 'persona-picker', order: 30, label: 'Persona' },
        PersonaSeat))

      return () => {
        if (unsubscribeDoorbell !== undefined) { try { unsubscribeDoorbell() } catch (e) {} }
        try { offTab() } catch (e) {}
        try { offComposer() } catch (e) {}
        try { tag.remove() } catch (e) {}
        window.removeEventListener('focus', onWindowFocus)
      }
    },
  }
  return module.exports
} })
