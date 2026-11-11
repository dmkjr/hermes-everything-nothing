/**
 * Next Prompt — desktop half.
 *
 * After a turn finishes, polls this plugin's Python backend (through
 * `ctx.rest`, which routes to the right backend and carries auth) for an
 * AI-generated follow-up and shows it as ghost text inside the empty composer.
 * Right Arrow accepts the suggestion through the SDK’s `host.composer`.
 * When the suggestion could not be generated, a muted note says why instead.
 */

import { atom, cn, Codicon, haptic, host, KEYBINDS_AREA, PALETTE_AREA, Tip, usePluginI18n, useQuery, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'next-prompt'

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

// ── actions (pill click, keybind, palette) ───────────────────────────────

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

// ── UI ───────────────────────────────────────────────────────────────────

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
    queryKey: ['next-prompt', 'suggestion', storedId],
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
      host.notifyError(query.error, 'Next Prompt could not reach its backend')
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

const settingsFields = [
  ['enabled', 'Inline suggestions', 'Preview a reply in the empty composer. Press Right Arrow to accept it.'],
  ['offer_follow_up_options', 'Offer extra follow-up choices', 'Show up to three follow-up questions when Hermes hasn’t offered a choice. Cycle with Option + Left or Right.'],
  ['local_fallback', 'Use offline fallback', 'Offer available choices when the suggestion model can’t respond.'],
  ['max_context_messages', 'Context messages', 'How many recent messages the suggestion model can use.', 2, 10],
  ['cooldown_seconds', 'Cooldown in seconds', 'Minimum time between suggestions in the same chat.', 0, 120]
]
const panelButton = 'rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

function EverythingNothingSettings({ ctx }) {
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
      if (active) setError('Could not load Next Prompt settings from the active Hermes profile.')
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
          jsx('p', { className: 'mt-2 text-sm text-slate-300', children: data ? `Applies to active profile: ${data.profile}` : 'Next Prompt settings' })
        ]
      }),
      error && jsx('p', { role: 'alert', className: 'text-sm text-destructive', children: error }),
      !data && !error && jsx('p', { role: 'status', children: 'Loading settings…' }),
      data && jsxs('section', {
        className: 'rounded-lg border border-border px-4',
        children: [
          jsx('h2', { className: 'py-3 text-base font-semibold', children: 'Next Prompt' }),
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

// ── plugin export ────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'Next Prompt',
  defaultEnabled: false, // opt-in in Settings → Plugins

  register(ctx) {
    pluginCtx = ctx
    ctx.registerSettingsPage?.({
      id: 'everything-nothing',
      title: 'Everything Nothing',
      icon: 'settings-gear',
      render: () => jsx(EverythingNothingSettings, { ctx })
    })

    ctx.i18n.register({
      en: {
        tip: 'Click to use this follow-up',
        dismiss: 'Dismiss suggestion',
        useLabel: 'Next Prompt: use suggestion',
        dismissLabel: 'Next Prompt: dismiss suggestion',
        nothingToUse: 'No follow-up suggestion in this chat right now',
        copied: 'Suggestion copied — paste it into the composer',
        copyFailed: 'Could not copy the suggestion',
        failure: {
          auth: 'Next Prompt: the model rejected its credentials',
          authHint:
            'Check the provider login (hermes auth list), or fully quit and reopen Hermes Desktop. You can also point auxiliary.next_prompt at another provider in config.yaml.',
          rate_limit: 'Next Prompt: the provider is rate-limiting requests',
          rate_limitHint: 'It tries again after your next message.',
          timeout: 'Next Prompt: the model took too long',
          timeoutHint: 'It tries again after your next message.',
          other: 'Next Prompt could not generate a suggestion',
          otherHint: 'Details are in the Hermes logs (hermes logs --level WARNING).'
        }
      },
      es: {
        tip: 'Clic para usar este seguimiento',
        dismiss: 'Descartar sugerencia',
        useLabel: 'Next Prompt: usar sugerencia',
        dismissLabel: 'Next Prompt: descartar sugerencia',
        nothingToUse: 'No hay sugerencia de seguimiento en este chat ahora',
        copied: 'Sugerencia copiada — pégala en el compositor',
        copyFailed: 'No se pudo copiar la sugerencia',
        failure: {
          auth: 'Next Prompt: el modelo rechazó sus credenciales',
          authHint:
            'Revisa el login del proveedor (hermes auth list) o cierra Hermes Desktop por completo, también desde la bandeja, y vuelve a abrirlo. También puedes apuntar auxiliary.next_prompt a otro proveedor en config.yaml.',
          rate_limit: 'Next Prompt: el proveedor está limitando las peticiones',
          rate_limitHint: 'Lo intentará de nuevo tras tu próximo mensaje.',
          timeout: 'Next Prompt: el modelo tardó demasiado',
          timeoutHint: 'Lo intentará de nuevo tras tu próximo mensaje.',
          other: 'Next Prompt no pudo generar una sugerencia',
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
        area: KEYBINDS_AREA,
        data: {
          id: 'next-prompt.use',
          label: t('useLabel'),
          category: 'composer',
          defaults: [USE_COMBO],
          run: useVisibleSuggestion
        }
      },
      {
        id: 'use-command',
        area: PALETTE_AREA,
        data: {
          id: 'next-prompt.use',
          label: t('useLabel'),
          action: 'next-prompt.use',
          keywords: ['next prompt', 'suggestion', 'follow-up', 'sugerencia'],
          detail: () => current()?.suggestion.text || t('nothingToUse'),
          run: useVisibleSuggestion
        }
      },
      {
        id: 'dismiss-command',
        area: PALETTE_AREA,
        data: {
          id: 'next-prompt.dismiss',
          label: t('dismissLabel'),
          keywords: ['next prompt', 'suggestion', 'dismiss', 'descartar'],
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
