/**
 * Everything Nothing — desktop half.
 *
 * Template Studio and Design Brief live in the settings page. After a turn
 * finishes, the composer strip polls this plugin's Python backend (through
 * `ctx.rest`, which routes to the right backend and carries auth) for an
 * AI-generated follow-up and shows it as ghost text inside the empty
 * composer. Right Arrow accepts the suggestion through the SDK's
 * `host.composer`; Option+Left/Right cycles ranked choices. When the
 * suggestion could not be generated, a muted note says why instead.
 */

import { atom, cn, Codicon, haptic, host, KEYBINDS_AREA, PALETTE_AREA, Tip, usePluginI18n, useQuery, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'everything-nothing'

/** Set in register(); components read it (ctx.rest is plugin-scoped). */
let pluginCtx = null

/** `${storedSessionId}:${kind}:${timestamp}` the user dismissed or used. */
const $handled = atom(null)
const $choice = atom(null)
/** storedSessionId → last epoch ms that chat was seen working. Data fetched
 *  before then predates the turn and waits for a fresh fetch. The backend is
 *  the authority on "still pending" (it drops the suggestion the moment the
 *  user sends their own message), so this only guards the local cache. */
const busySeenAt = new Map()
/** Epoch ms when the focused chat last went idle — drives poll cadence. */
let idleSinceMs = 0
let reportedError = false

const FAST_POLL_MS = 2000
const SLOW_POLL_MS = 20000
const FAST_WINDOW_MS = 45000
const FAILURE_KINDS = new Set(['auth', 'rate_limit', 'timeout', 'other'])
// Unused by the app, its editors and the OS menus; a primary-modifier chord
// also fires while typing in the composer. Rebindable in Settings → Keybinds;
// the palette row shows the live binding.
const USE_COMBO = 'mod+shift+y'

/** What the strip shows right now, for the keybind and palette commands:
 *  `{ storedId, suggestion, handledKey }` or null. Written during render. */
let visible = null

// ── composer insertion ───────────────────────────────────────────────────
// SDK only. `host.composer.insertText` (Desktop plugin SDK hook 1, #116305)
// places the text in the focused composer without sending it and focuses the
// caret; it resolves false when no composer can take it. Hosts without the
// hook fall back to the clipboard when invoked from the command palette.
async function insertIntoComposer(text) {
  const composer = host.composer
  if (!composer || typeof composer.insertText !== 'function') return false
  try {
    return (await composer.insertText(null, text, { mode: 'block' })) === true
  } catch {
    return false
  }
}

// ── backend ──────────────────────────────────────────────────────────────

/** `{ suggestion, error }` for one session (see dashboard/plugin_api.py). */
async function fetchState(storedId) {
  const data = await pluginCtx.rest(`/suggestion?session_id=${encodeURIComponent(storedId)}`)
  return { suggestion: (data && data.suggestion) || null, error: (data && data.error) || null }
}

function dismissOnServer(storedId) {
  if (!storedId || !pluginCtx) return
  pluginCtx.rest(`/dismiss?session_id=${encodeURIComponent(storedId)}`, { method: 'POST' }).catch(() => {})
}

// ── actions (ghost accept, keybind, palette) ─────────────────────────────

function finish(entry) {
  $handled.set(entry.handledKey)
  if (visible && visible.handledKey === entry.handledKey) visible = null
  dismissOnServer(entry.storedId)
}

async function useSuggestion(entry) {
  const text = entry.suggestion.text
  finish(entry)
  if (await insertIntoComposer(text)) return
  if (!pluginCtx) return
  try {
    await pluginCtx.os.writeClipboard(text)
    host.notify({ kind: 'info', message: pluginCtx.i18n.t('copied') })
  } catch (error) {
    host.notifyError(error, pluginCtx.i18n.t('copyFailed'))
  }
}

/** The suggestion on screen for the focused chat, if any. Read at call time,
 *  so a stale render never acts on another chat. */
function current() {
  const focused = host.state.focusedStoredSessionId.get()
  if (!visible || !focused || visible.storedId !== focused || host.state.busy.get()) return null
  return visible
}

function useVisibleSuggestion() {
  const entry = current()
  if (!entry) {
    if (pluginCtx) host.notify({ kind: 'info', message: pluginCtx.i18n.t('nothingToUse') })
    return
  }
  haptic('tap')
  void useSuggestion(entry)
}

function dismissVisibleSuggestion() {
  const entry = current()
  if (entry) finish(entry)
}

// ── suggestion UI ────────────────────────────────────────────────────────

const rowClass = 'flex min-w-0 items-center justify-start'
const closeClass = 'ml-1 shrink-0 rounded-full p-0.5 opacity-50 hover:opacity-100'

const ghostAttribute = 'data-next-prompt-ghost'
const ghostStyle = `
[data-slot="composer-rich-input"][contenteditable="true"][data-empty][data-next-prompt-ghost]::before {
  content: attr(data-next-prompt-ghost);
}
`

function InlineSuggestion({ suggestion, handledKey, index, count }) {
  const anchor = useRef(null)

  useEffect(() => {
    // Scope to this contribution's composer, including when other chats or
    // message editors are mounted in the same window.
    const dock = anchor.current?.closest('[data-slot="composer-dock"]')
    const editor = dock?.querySelector('[data-slot="composer-surface"] [data-slot="composer-rich-input"]')
    if (!editor) return

    const preview = count > 1 ? `${suggestion.text}   ·   ${index + 1}/${count} · ⌥←/→` : suggestion.text
    editor.setAttribute(ghostAttribute, preview)

    function accept(event) {
      if (
        event.defaultPrevented || event.repeat ||
        event.isComposing || event.keyCode === 229 ||
        event.ctrlKey || event.metaKey || event.shiftKey ||
        event.target !== editor || document.activeElement !== editor ||
        !editor.isContentEditable || !editor.hasAttribute('data-empty') ||
        editor.textContent || editor.getAttribute(ghostAttribute) !== preview
      ) return

      const entry = current()
      if (entry?.handledKey !== handledKey || entry.suggestion.text !== suggestion.text) return

      const cycle = event.altKey && count > 1 && ['ArrowLeft', 'ArrowRight'].includes(event.key)
      const accept = !event.altKey && event.key === 'ArrowRight' && typeof host.composer?.insertText === 'function'
      if (!cycle && !accept) return

      event.preventDefault()
      event.stopPropagation()
      haptic('tap')
      if (cycle) {
        const delta = event.key === 'ArrowRight' ? 1 : -1
        $choice.set({ handledKey, index: (index + delta + count) % count })
        return
      }
      // Commit the dismissal only when the SDK accepted the insertion.
      void insertIntoComposer(suggestion.text).then(inserted => {
        if (inserted && current()?.handledKey === handledKey) finish(entry)
      })
    }

    function resetChoice() {
      if ($choice.get()?.handledKey === handledKey) $choice.set(null)
    }

    function resetOnSelection() {
      const selection = document.getSelection?.()
      if (selection && !selection.isCollapsed && editor.contains(selection.anchorNode)) resetChoice()
    }

    editor.addEventListener('keydown', accept)
    editor.addEventListener('input', resetChoice)
    document.addEventListener?.('selectionchange', resetOnSelection)
    return () => {
      editor.removeEventListener('keydown', accept)
      editor.removeEventListener('input', resetChoice)
      document.removeEventListener?.('selectionchange', resetOnSelection)
      editor.removeAttribute(ghostAttribute)
    }
  }, [suggestion.text, handledKey, index, count])

  return jsx('style', { ref: anchor, children: ghostStyle })
}

/** Muted, dismissible note in the pill's place when generation failed. */
function FailureNote({ storedId, failure, handledKey }) {
  const t = usePluginI18n(ID)
  const kind = FAILURE_KINDS.has(failure.kind) ? failure.kind : 'other'

  const onDismiss = () => finish({ storedId, handledKey })

  return jsx('div', {
    className: rowClass,
    children: jsx(Tip, {
      label: t(`failure.${kind}Hint`),
      children: jsxs('div', {
        role: 'status',
        className: cn(
          'flex min-w-0 max-w-full items-center gap-1.5 rounded-full px-3 py-1',
          'text-[0.8125rem] text-(--ui-text-tertiary)'
        ),
        children: [
          jsx(Codicon, { name: 'warning', className: 'shrink-0 text-[0.75rem] opacity-70' }),
          jsx('span', { className: 'truncate', children: t(`failure.${kind}`) }),
          jsx('button', {
            type: 'button',
            'aria-label': t('dismiss'),
            className: closeClass,
            onClick: onDismiss,
            children: jsx(Codicon, { name: 'close', className: 'text-[0.625rem]' })
          })
        ]
      })
    })
  })
}

function SuggestionStrip() {
  const storedId = useValue(host.state.focusedStoredSessionId)
  const busy = useValue(host.state.busy)
  const handled = useValue($handled)
  const choice = useValue($choice)
  visible = null

  // Per session, never global: another chat working (or switching screens)
  // must not hide this chat's suggestion.
  if (storedId && busy) busySeenAt.set(storedId, Date.now())

  useEffect(() => {
    if (!busy) idleSinceMs = Date.now()
  }, [busy])

  const query = useQuery({
    queryKey: ['everything-nothing', 'suggestion', storedId],
    queryFn: () => fetchState(storedId),
    enabled: Boolean(pluginCtx && storedId && !busy),
    refetchInterval: () => (Date.now() - idleSinceMs < FAST_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS),
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    retry: false
  })

  useEffect(() => {
    if (query.error && !reportedError) {
      reportedError = true
      host.notifyError(query.error, 'Everything Nothing could not reach its backend')
    }
  }, [query.error])

  if (busy || !storedId || !query.data) return null
  if (query.dataUpdatedAt <= (busySeenAt.get(storedId) || 0)) return null

  const { suggestion, error: failure } = query.data
  const mine = item => item && (!item.session_id || item.session_id === storedId)

  // Older rows contain unrestricted model prose. Only show fork-generated rows.
  if (mine(suggestion) && suggestion.text && Array.isArray(suggestion.alternatives)) {
    const handledKey = `${storedId}:suggestion:${suggestion.timestamp}`
    if (handled === handledKey) return null
    const options = [suggestion.text, ...suggestion.alternatives]
    const index = choice?.handledKey === handledKey && choice.index < options.length ? choice.index : 0
    const selected = { ...suggestion, text: options[index] }
    visible = { storedId, suggestion: selected, handledKey }
    return jsx(InlineSuggestion, { suggestion: selected, handledKey, index, count: options.length })
  }

  if (mine(failure)) {
    const handledKey = `${storedId}:failure:${failure.timestamp}`
    if (handled === handledKey) return null
    return jsx(FailureNote, { storedId, failure, handledKey })
  }

  return null
}

// ── settings: suggestions ────────────────────────────────────────────────

const settingsFields = [
  ['enabled', 'Inline suggestions', 'Preview a reply in the empty composer. Press Right Arrow to accept it.'],
  ['offer_follow_up_options', 'Offer extra follow-up choices', 'Show up to three follow-up questions when Hermes hasn’t offered a choice. Cycle with Option + Left or Right.'],
  ['local_fallback', 'Use offline fallback', 'Offer available choices when the suggestion model can’t respond.'],
  ['max_context_messages', 'Context messages', 'How many recent messages the suggestion model can use.', 2, 10],
  ['cooldown_seconds', 'Cooldown in seconds', 'Minimum time between suggestions in the same chat.', 0, 120]
]
const concisionLevels = ['Off', 'Light', 'Terse', 'Fluff Eater']
const panelButton = 'rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

function SuggestionsSettings({ ctx }) {
  const profile = useValue(host.state.profile)
  return jsx(NextPromptSettings, { ctx, key: profile })
}

function NextPromptSettings({ ctx }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState('')
  const [force, setForce] = useState(false)
  const [result, setResult] = useState(null)

  useEffect(() => {
    let active = true
    ctx.rest('/settings').then(value => {
      if (active) setData(value)
    }).catch(() => {
      if (active) setError('Could not load Everything Nothing settings from the active Hermes profile.')
    })
    return () => { active = false }
  }, [ctx])

  async function save(key, value) {
    setBusy(key)
    setError('')
    try {
      setData(await ctx.rest('/settings', { method: 'PUT', body: { profile: data.profile, key, value } }))
    } catch {
      setError('Could not save that setting. Check the active profile and try again.')
    } finally {
      setBusy(null)
    }
  }

  async function test() {
    setBusy('test')
    setResult(null)
    setError('')
    try {
      setResult(await ctx.rest('/test-suggestion', {
        method: 'POST', body: { profile: data.profile, force_fallback: force }, timeoutMs: 12000
      }))
    } catch {
      setError('The suggestion test could not reach the plugin. Check the active profile and try again.')
    } finally {
      setBusy(null)
    }
  }

  return jsxs('div', {
    className: 'mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5',
    children: [
      jsxs('header', {
        className: 'rounded-xl border border-slate-700 bg-[#101621] px-6 py-6 text-slate-100',
        style: { backgroundImage: 'radial-gradient(ellipse at top right, #263454, transparent 65%)' },
        children: [
          jsx('p', { className: 'mb-2 font-mono text-xs tracking-widest text-slate-300', children: 'HERMES DESKTOP PLUGIN' }),
          jsxs('h1', { className: 'text-2xl font-semibold tracking-tight', children: [
            jsx('span', { className: 'text-[#ffcc63]', children: 'E' }), 'verything ',
            jsx('span', { className: 'text-[#ffcc63]', children: 'N' }), 'othing'
          ] }),
          jsx('p', { className: 'mt-2 text-sm text-slate-300', children: data ? `Applies to active profile: ${data.profile}` : 'Everything Nothing settings' })
        ]
      }),
      error && jsx('p', { role: 'alert', className: 'text-sm text-destructive', children: error }),
      !data && !error && jsx('p', { role: 'status', children: 'Loading settings…' }),
      data && jsxs('section', {
        className: 'rounded-lg border border-border px-4',
        children: [
          jsx('h2', { className: 'py-3 text-base font-semibold', children: 'Composer suggestions' }),
          ...settingsFields.map(([key, label, description, min, max]) => {
            const value = data.settings[key]
            const field = min === undefined
              ? jsx('input', { type: 'checkbox', checked: value, disabled: Boolean(busy), onChange: event => void save(key, event.target.checked) })
              : jsx('input', {
                  key: `${key}:${value}`, type: 'number', min, max, step: 1, defaultValue: value,
                  className: 'w-20 rounded border border-border bg-background px-2 py-1',
                  disabled: Boolean(busy),
                  onBlur: event => {
                    const next = event.target.valueAsNumber
                    if (!event.target.validity.valid || !Number.isInteger(next)) {
                      event.target.value = value
                    } else if (next !== value) void save(key, next)
                  },
                  onKeyDown: event => { if (event.key === 'Enter') event.target.blur() }
                })
            return jsxs('label', {
              className: 'flex items-center justify-between gap-4 border-t border-border py-3',
              children: [
                jsxs('span', { children: [
                  jsx('span', { className: 'block text-sm font-medium', children: label }),
                  jsx('span', { className: 'block text-xs text-muted-foreground', children: description })
                ] }),
                field
              ]
            }, key)
          })
        ]
      }),
      data && jsxs('section', {
        className: 'flex items-center justify-between gap-4 rounded-lg border border-border px-4 py-3',
        children: [
          jsxs('span', { children: [
            jsx('span', { className: 'block text-sm font-medium', children: 'Reply style (Fluff Eater)' }),
            jsx('span', { className: 'block text-xs text-muted-foreground', children: 'How concise Hermes replies in this profile: Off, Light, Terse, or Fluff Eater.' })
          ] }),
          jsx('select', {
            className: 'rounded border border-border bg-background px-2 py-1 text-sm',
            'aria-label': 'Reply style',
            value: concisionLevels.includes(data.settings.response_concision) ? data.settings.response_concision : 'Off',
            disabled: Boolean(busy),
            onChange: event => void save('response_concision', event.target.value),
            children: concisionLevels.map(level => jsx('option', { value: level, children: level }, level))
          })
        ]
      }),
      data && jsxs('section', {
        className: 'flex flex-col gap-3 rounded-lg border border-border p-4',
        children: [
          jsx('h2', { className: 'text-base font-semibold', children: 'Test Suggestion' }),
          jsx('p', { className: 'text-sm text-muted-foreground', children:
            `Configured model: ${data.model || 'Follow main model'}${data.provider === 'auto' ? '' : ` · ${data.provider}`}. Change it in Settings → Auxiliary models → Next Prompt.`
          }),
          jsxs('label', { className: 'flex items-center gap-2 text-sm', children: [
            jsx('input', { type: 'checkbox', checked: force, disabled: Boolean(busy), onChange: event => setForce(event.target.checked) }),
            'Force offline fallback for this test'
          ] }),
          jsx('p', { className: 'text-xs text-muted-foreground', children: 'Uses a sample tea-or-coffee question. Your chat and draft stay untouched.' }),
          jsx('button', { type: 'button', className: `self-start ${panelButton}`, disabled: Boolean(busy), onClick: test, children: busy === 'test' ? 'Testing…' : 'Test Suggestion' }),
          result && jsxs('div', { role: 'status', className: 'rounded-md border border-border p-3 text-sm', children: [
            jsx('p', { className: 'font-medium', children: `${result.source === 'fallback' ? 'Offline fallback' : result.source === 'model' ? 'Model' : 'No suggestion'} · ${result.latency_ms} ms` }),
            jsx('p', { className: 'text-muted-foreground', children: result.model ? `${result.model} · ${result.provider || 'Hermes'}` : 'No model returned a result' }),
            result.failure && jsx('p', { children: `Model result: ${result.failure}` }),
            jsx('ol', { className: 'mt-2 list-decimal pl-5', children: result.options.map(option => jsx('li', { children: option }, option)) })
          ] })
        ]
      })
    ]
  })
}

// ── settings: template studio + design brief ─────────────────────────────

const toolPanel = 'grid gap-3 rounded-lg border border-border bg-background p-4'
const toolField = 'w-full rounded border border-border bg-background px-2 py-1 text-sm'

const templateKey = 'templates.v1'
const starterTemplates = [
  { id: 'email', name: 'Email', body: 'Subject: {{subject}}\n\nHi {{recipient}},\n\n{{message}}\n\nThanks,\n{{sender}}' },
  { id: 'invoice', name: 'Invoice note', body: 'Invoice {{invoice_number}}\nPrepared for: {{customer}}\nDue: {{due_date}}\nAmount: {{amount}}\n\n{{notes}}' },
  { id: 'label', name: 'Label', body: '{{name}}\n{{address}}\n{{reference}}' }
]
const templateVariable = /\{\{\s*([a-zA-Z][\w-]{0,39})\s*\}\}/g
const storedTemplates = ctx => ctx.storage?.get(templateKey, []) ?? []

function TemplateStudio({ ctx }) {
  const [saved, setSaved] = useState(() => storedTemplates(ctx))
  const [template, setTemplate] = useState(starterTemplates[0])
  const [values, setValues] = useState({})
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState(false)
  const variables = [...new Set(Array.from(template.body.matchAll(templateVariable), match => match[1]))]
  const fieldValue = key => Object.hasOwn(values, key) ? values[key] : ''
  const preview = template.body.replace(templateVariable, (raw, key) => fieldValue(key).trim() ? fieldValue(key) : raw)
  const complete = variables.every(key => fieldValue(key).trim())
  const custom = saved.some(item => item.id === template.id)

  function write(items) {
    ctx.storage?.set(templateKey, items)
    setSaved(items)
  }

  return jsxs('div', { className: toolPanel, children: [
    jsx('p', { className: 'text-sm text-muted-foreground', children: 'Choose a starter, fill in its blanks, then copy the finished text and paste it into a chat or anywhere else.' }),
    jsxs('label', { children: ['Template', jsx('select', { className: toolField, 'aria-label': 'Template', value: template.id,
      onChange: event => {
        const next = [...starterTemplates, ...saved].find(item => item.id === event.target.value)
        setTemplate(next ?? { id: '', name: '', body: '' })
        setValues({})
        setStatus('')
      },
      children: [jsx('option', { value: '', children: 'New template' }), ...[...starterTemplates, ...saved].map(item => jsx('option', { value: item.id, children: item.name }, item.id))]
    })] }),
    variables.length > 0 && jsx('h3', { className: 'text-sm font-semibold', children: 'Fill in the blanks' }),
    ...variables.map(key => jsxs('label', { className: 'grid gap-1 text-sm', children: [key.replace(/[_-]/g, ' ').replace(/^./, first => first.toUpperCase()), jsx('input', { className: toolField, value: fieldValue(key), maxLength: 2000,
      onChange: event => setValues({ ...values, [key]: event.target.value }) })] }, key)),
    jsx('h3', { className: 'text-sm font-semibold', children: 'Live preview' }),
    jsx('pre', { className: 'whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm', children: preview || 'Your template will appear here.' }),
    jsx('button', { type: 'button', className: panelButton + ' justify-self-start', disabled: pending || !preview.trim() || !complete || !ctx.os?.writeClipboard, onClick: async () => {
      setPending(true)
      try {
        setStatus(await ctx.os.writeClipboard(preview) ? 'Copied. Paste the text where you want to use it.' : 'Could not copy the template.')
      } catch {
        setStatus('Could not copy the template.')
      } finally {
        setPending(false)
      }
    }, children: 'Copy filled text' }),
    jsxs('details', { key: template.id, open: template.id === '' ? true : undefined, className: 'rounded border border-border p-3 text-sm', children: [
      jsx('summary', { className: 'cursor-pointer font-medium', children: 'Customize or save a template' }),
      jsxs('div', { className: 'mt-3 grid gap-2', children: [
        jsx('p', { className: 'text-muted-foreground', children: 'Put double braces around a field, such as {{recipient}}. Saved templates keep the blanks so you can fill them again next time.' }),
        jsx('input', { className: toolField, 'aria-label': 'Template name', placeholder: 'Template name', value: template.name, maxLength: 80, onChange: event => setTemplate({ ...template, name: event.target.value }) }),
        jsx('textarea', { className: toolField, 'aria-label': 'Template text', value: template.body, rows: 5, maxLength: 12000, placeholder: 'Use {{name}} for a fill-in field.',
          onChange: event => setTemplate({ ...template, body: event.target.value }) }),
        jsxs('div', { className: 'flex flex-wrap gap-2', children: [
          jsx('button', { type: 'button', className: panelButton, disabled: !template.name.trim() || !template.body.trim() || (!custom && saved.length >= 50), onClick: () => {
            const item = { ...template, name: template.name.trim(), id: custom ? template.id : crypto.randomUUID() }
            write(custom ? saved.map(old => old.id === item.id ? item : old) : [...saved, item])
            setTemplate(item)
            setStatus('Template saved on this device.')
          }, children: custom ? 'Save changes' : 'Save as template' }),
          custom && jsx('button', { type: 'button', className: panelButton, onClick: () => {
            write(saved.filter(item => item.id !== template.id))
            setTemplate({ ...template, id: '' })
            setStatus('Saved template removed. You can still edit or save this draft.')
          }, children: 'Remove saved template' })
        ] })
      ] })
    ] }),
    jsx('p', { role: 'status', className: 'text-sm text-muted-foreground', children: status })
  ] })
}

const designPrompts = [
  ['Visual direction', 'Start with the product’s job, audience, and emotional tone. Choose a visual direction and name the typography, spacing rhythm, surface treatments, and accent rules that express it. Reuse the existing design system where one exists.'],
  ['Hierarchy and flow', 'Walk the primary task from entry to completion. Show what the user should notice and do first. Group related controls, keep supporting actions quieter, and write labels that describe the result.'],
  ['Responsive and accessible', 'Verify the real interface at phone, tablet, and desktop widths. Check keyboard order, visible focus, accessible names, contrast, reduced motion, long labels, and text zoom.'],
  ['States and verification', 'Build loading, empty, error, success, and disabled states with realistic data. Exercise the main flow and an error recovery path in a browser. Capture what was verified and what remains untested.'],
  ['Menus and controls', 'Check how every menu opens, positions, scrolls, closes, and returns focus. Cover Escape, click outside, keyboard navigation, and narrow viewports. Keep labels and icon meanings consistent.'],
  ['Design system', 'Audit existing components and tokens before adding new ones. Reuse patterns for type, spacing, surfaces, borders, and interaction states. Verify the selected theme and document any intentional departure.']
]

const designPresets = [
  ['New interface', 'Design the primary flow and state the visual direction.', [0, 1, 2, 3]],
  ['Polish an existing UI', 'Preserve the product’s visual language while improving the requested interface.', [1, 2, 4, 5]],
  ['Review menus and accessibility', 'Find and fix interaction issues in the requested menus and controls.', [2, 3, 4, 5]]
]

function DesignBrief({ ctx }) {
  const [preset, setPreset] = useState(0)
  const [task, setTask] = useState('')
  const [audience, setAudience] = useState('')
  const [selected, setSelected] = useState(designPresets[0][2])
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const brief = [
    task.trim() && `Task: ${task.trim()}`,
    audience.trim() && `Audience or constraints: ${audience.trim()}`,
    designPresets[preset][1],
    ...designPrompts.flatMap(([label, guidance], index) => selected.includes(index) ? [`- ${label}: ${guidance}`] : [])
  ].filter(Boolean).join('\n')

  async function copyBrief(asSkill = false) {
    setBusy(true)
    try {
      const skill = [
        '---',
        'name: frontend-design-review',
        'description: Design and verify frontend interfaces with concrete visual and interaction checks.',
        '---',
        '',
        '# Frontend Design Review',
        '',
        'Use this checklist when designing, polishing, or reviewing a frontend.',
        '',
        ...designPrompts.filter((_, index) => selected.includes(index)).map(([label, guidance]) => `- **${label}.** ${guidance}`)
      ].join('\n')
      const copied = await ctx.os?.writeClipboard(asSkill ? skill : brief)
      setStatus(copied ? (asSkill ? 'Skill copied. Save it as SKILL.md or ask Hermes to install it.' : 'Design brief copied. Paste it into your chat.') : 'Could not copy the design guidance.')
    } catch {
      setStatus('Could not copy the design brief.')
    } finally {
      setBusy(false)
    }
  }

  return jsxs('section', { className: toolPanel + ' min-w-0', children: [
    jsx('h2', { className: 'font-semibold', children: 'Design brief' }),
    jsx('p', { className: 'text-sm text-muted-foreground', children: 'Copy the brief for a specific project, or copy a reusable SKILL.md containing the selected checks.' }),
    jsxs('label', { className: 'grid gap-1 text-sm', children: [
      'Starting point',
      jsx('select', { className: toolField, value: preset, onChange: event => {
        const next = Number(event.target.value)
        setPreset(next)
        setSelected(designPresets[next][2])
      }, children: designPresets.map(([label], index) => jsx('option', { value: index, children: label }, label)) })
    ] }),
    jsx('textarea', { className: toolField, rows: 2, maxLength: 2000, 'aria-label': 'What are you designing?', placeholder: 'What are you designing?', value: task, onChange: event => setTask(event.target.value) }),
    jsx('input', { className: toolField, maxLength: 500, 'aria-label': 'Audience or constraints', placeholder: 'Audience or constraints', value: audience, onChange: event => setAudience(event.target.value) }),
    jsxs('fieldset', { className: 'grid gap-2', children: [
      jsx('legend', { className: 'mb-2 text-sm font-medium', children: 'Include guidance for' }),
      ...designPrompts.map(([label], index) => jsxs('label', { className: 'flex items-center gap-2 text-sm', children: [
        jsx('input', { type: 'checkbox', checked: selected.includes(index), onChange: event => {
          const checked = event.target.checked
          setSelected(current => checked ? [...current, index] : current.filter(item => item !== index))
        } }),
        label
      ] }, label))
    ] }),
    jsx('pre', { className: 'max-h-52 overflow-auto whitespace-pre-wrap break-words rounded border border-border p-3 text-sm', 'aria-label': 'Design brief preview', children: brief }),
    jsxs('div', { className: 'flex flex-wrap gap-2', children: [
      jsx('button', { type: 'button', className: panelButton, disabled: busy || !ctx.os?.writeClipboard, onClick: () => void copyBrief(), children: 'Copy brief' }),
      jsx('button', { type: 'button', className: panelButton, disabled: busy || !selected.length || !ctx.os?.writeClipboard, onClick: () => void copyBrief(true), children: 'Copy SKILL.md' })
    ] }),
    jsx('p', { role: 'status', className: 'text-sm text-muted-foreground', children: status })
  ] })
}

// ── plugin export ────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Everything Nothing',
  defaultEnabled: false, // opt-in in Settings → Plugins

  register(ctx) {
    pluginCtx = ctx
    ctx.registerSettingsPage?.({
      id: 'tools',
      title: 'Everything Nothing',
      icon: 'sparkle',
      render: () => jsxs('section', { className: toolPanel, children: [
        jsx('h2', { className: 'font-semibold', children: 'Everything Nothing' }),
        jsx('p', { children: 'Create reusable drafts in Template Studio, prepare UI guidance with Design Brief, and tune inline composer suggestions.' }),
        jsx('p', { children: 'Reply style (Fluff Eater) and suggestion settings live under Suggestions.' })
      ] }),
      children: [
        { id: 'templates', title: 'Template Studio', render: () => jsx(TemplateStudio, { ctx }) },
        { id: 'design-brief', title: 'Design Brief', render: () => jsx(DesignBrief, { ctx }) },
        { id: 'suggestions', title: 'Suggestions', render: () => jsx(SuggestionsSettings, { ctx }) }
      ]
    })

    ctx.i18n.register({
      en: {
        tip: 'Click to use this follow-up',
        dismiss: 'Dismiss suggestion',
        useLabel: 'Everything Nothing: use suggestion',
        dismissLabel: 'Everything Nothing: dismiss suggestion',
        nothingToUse: 'No follow-up suggestion in this chat right now',
        copied: 'Suggestion copied — paste it into the composer',
        copyFailed: 'Could not copy the suggestion',
        failure: {
          auth: 'Everything Nothing: the model rejected its credentials',
          authHint:
            'Check the provider login (hermes auth list), or fully quit and reopen Hermes Desktop. You can also point auxiliary.next_prompt at another provider in config.yaml.',
          rate_limit: 'Everything Nothing: the provider is rate-limiting requests',
          rate_limitHint: 'It tries again after your next message.',
          timeout: 'Everything Nothing: the model took too long',
          timeoutHint: 'It tries again after your next message.',
          other: 'Everything Nothing could not generate a suggestion',
          otherHint: 'Details are in the Hermes logs (hermes logs --level WARNING).'
        }
      },
      es: {
        tip: 'Clic para usar este seguimiento',
        dismiss: 'Descartar sugerencia',
        useLabel: 'Everything Nothing: usar sugerencia',
        dismissLabel: 'Everything Nothing: descartar sugerencia',
        nothingToUse: 'No hay sugerencia de seguimiento en este chat ahora',
        copied: 'Sugerencia copiada — pégala en el compositor',
        copyFailed: 'No se pudo copiar la sugerencia',
        failure: {
          auth: 'Everything Nothing: el modelo rechazó sus credenciales',
          authHint:
            'Revisa el login del proveedor (hermes auth list) o cierra Hermes Desktop por completo, también desde la bandeja, y vuelve a abrirlo. También puedes apuntar auxiliary.next_prompt a otro proveedor en config.yaml.',
          rate_limit: 'Everything Nothing: el proveedor está limitando las peticiones',
          rate_limitHint: 'Lo intentará de nuevo tras tu próximo mensaje.',
          timeout: 'Everything Nothing: el modelo tardó demasiado',
          timeoutHint: 'Lo intentará de nuevo tras tu próximo mensaje.',
          other: 'Everything Nothing no pudo generar una sugerencia',
          otherHint: 'Los detalles están en los logs de Hermes (hermes logs --level WARNING).'
        }
      }
    })

    ctx.register({
      id: 'suggestion-strip',
      area: 'composer.underside',
      order: 100,
      render: () => jsx(SuggestionStrip, {})
    })

    const t = key => ctx.i18n.t(key)
    ctx.registerMany([
      {
        id: 'use-keybind',
        area: 'keybinds',
        data: {
          id: 'everything-nothing.use',
          label: t('useLabel'),
          category: 'composer',
          defaults: [USE_COMBO],
          run: useVisibleSuggestion
        }
      },
      {
        id: 'use-command',
        area: 'palette',
        data: {
          id: 'everything-nothing.use',
          label: t('useLabel'),
          action: 'everything-nothing.use',
          keywords: ['everything nothing', 'next prompt', 'suggestion', 'follow-up', 'sugerencia'],
          detail: () => current()?.suggestion.text || t('nothingToUse'),
          run: useVisibleSuggestion
        }
      },
      {
        id: 'dismiss-command',
        area: 'palette',
        data: {
          id: 'everything-nothing.dismiss',
          label: t('dismissLabel'),
          keywords: ['everything nothing', 'next prompt', 'suggestion', 'dismiss', 'descartar'],
          run: dismissVisibleSuggestion
        }
      }
    ])

    ctx.onDispose(() => {
      pluginCtx = null
      visible = null
      reportedError = false
    })
  }
}
