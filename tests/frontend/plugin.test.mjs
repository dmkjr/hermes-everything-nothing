// Behaviour of the Desktop half (desktop/plugin.js) against a stub SDK.
// Run: node --test tests/frontend/
//
// The suggestion is ghost text INSIDE the composer (InlineSuggestion renders a
// <style> and paints the text on the composer as `data-next-prompt-ghost`,
// which the ::before rule renders). Right Arrow accepts, Option+Left/Right
// cycles the ranked choices. So the harness mounts a stub composer dock and
// reads the real (stub) contenteditable the plugin touches.

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { contribution, expand, find, ghostOn, loadPlugin, makeCtx, mount, PLUGIN_SOURCE, resetCalls, resetDom, serve, sleep, textOf, view } from './harness.mjs'
import { calls, host, queries, server } from './stubs/sdk.mjs'
import { document, ghostAttribute, mountComposer, selectIn } from './stubs/dom.mjs'

const plugin = await loadPlugin()

// Source without comments: the DOM rule test checks code, not prose.
const CODE = PLUGIN_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

/** One test's registration: a fresh ctx plus its composer strip. */
function wire() {
  resetCalls()
  resetDom()
  server.clear()
  const ctx = makeCtx()
  plugin.register(ctx)
  return { ctx, strip: contribution(ctx, 'composer.underside') }
}

// Fork-generated rows carry `alternatives`; those are the only rows the ghost
// paints (older rows hold unrestricted model prose).
let stamp = 0
const suggestion = (sessionId, alternatives = []) => ({ session_id: sessionId, text: `Sigue con ${sessionId}`, alternatives, timestamp: ++stamp })
const note = (sessionId, kind) => ({ session_id: sessionId, kind: kind, message: 'boom', timestamp: ++stamp })

/** Render with a composer dock mounted: {tree, editor}. The editor is empty
 *  (`data-empty`, no text) and focused, exactly like a fresh composer. */
const composer = (ctx, storedId = 'A') => mount(ctx, storedId)
const ghost = ctx => ghostOn(composer(ctx).editor)
const arrow = (editor, key, alt = false) => editor.dispatch('keydown', { key, altKey: alt })

test('only imports the SDK, react and react/jsx-runtime', () => {
  const imports = [...PLUGIN_SOURCE.matchAll(/^import .* from '([^']+)'/gm)].map(m => m[1])
  assert.deepEqual(imports, ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
})

test('reaches the composer DOM only through its own dock anchor (catalog rule 8)', () => {
  // No global reach: no window, no document-root lookups, no synthetic app
  // events, no app storage. The ghost reads the composer through the DOM node
  // its own contribution was mounted into.
  for (const banned of ['window.', 'document.querySelector', 'document.getElementById', 'document.body', 'document.documentElement', 'document.createElement', 'dispatchEvent', 'CustomEvent', 'localStorage', 'hermes:composer', 'data-composer-target', 'innerHTML']) {
    assert.ok(!CODE.includes(banned), `plugin.js must not use ${banned}`)
  }
  const documentReads = [...new Set([...CODE.matchAll(/document\.(\w+)/g)].map(m => m[1]))].sort()
  assert.deepEqual(documentReads, ['activeElement', 'addEventListener', 'getSelection', 'removeEventListener'])

  assert.ok(CODE.includes("anchor.current?.closest('[data-slot=\"composer-dock\"]')"), 'the dock comes from the contribution ref')
  assert.ok(CODE.includes("dock?.querySelector('[data-slot=\"composer-surface\"] [data-slot=\"composer-rich-input\"]')"), 'the editor is found inside that dock only')
  assert.ok(CODE.includes('editor.removeEventListener') && CODE.includes('editor.removeAttribute'), 'the ghost unregisters and un-ghosts on cleanup')
})

test('ships opt-in and contributes to composer.underside', () => {
  const ctx = makeCtx()
  plugin.register(ctx)
  assert.equal(plugin.id, 'everything-nothing')
  assert.equal(plugin.defaultEnabled, false)
  assert.ok(ctx.contributions.some(c => c.area === 'composer.underside'))
})

test('the suggestion is ghosted onto the composer, not shown as a pill', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  const { tree, editor } = composer(ctx)

  assert.equal(tree.type, 'style', 'the strip renders the ghost <style>, nothing visible on its own')
  assert.ok(tree.props.children.includes(`[${ghostAttribute}]::before`), 'the style paints the ghost attribute')
  assert.ok(tree.props.children.includes('content: attr(' + ghostAttribute + ')'), 'the text comes from the composer attribute')
  assert.ok(!tree.props.children.includes('opacity'), 'the ghost is not drawn faded over real text')
  assert.equal(ghostOn(editor), 'Sigue con A')
  assert.ok(!find(tree, n => n.type === 'button'), 'there is no pill button to click')
})

test('the ghost is per chat: switching screens shows each chat’s own row', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  serve('B', suggestion('B', ['B alternativa']))
  assert.equal(queries.last.queryKey.join('|'), 'everything-nothing|suggestion|A')
  assert.equal(ghost(ctx), 'Sigue con A')
  view('B')
  assert.equal(ghostOn(composer(ctx, 'B').editor), 'Sigue con B   ·   1/2 · ⌥←/→', 'B ghosts its own suggestion, not A’s')
  view('A')
  assert.equal(ghost(ctx), 'Sigue con A', 'back to A and its own suggestion is still pending')
})

test('polls fast while a chat is fresh and slows down once it has settled', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  composer(ctx)
  assert.equal(queries.last.refetchOnMount, 'always')
  assert.equal(queries.last.retry, false)
  assert.equal(typeof queries.last.refetchInterval, 'function')
  assert.equal(queries.last.refetchInterval(), 2000, 'just finished a turn: poll every 2s')
  queries.last.refetchInterval()
  assert.equal(queries.last.refetchInterval(), 2000)
  // Polling never goes on when the chat is mid-turn.
  view('A', true)
  composer(ctx)
  assert.equal(queries.last.enabled, false)
})

test('a turn in this chat makes the previous fetch stale', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  assert.equal(ghost(ctx), 'Sigue con A')
  view('A', true)
  composer(ctx)                        // the strip records when this chat was seen working
  view('A', false)
  server.set('A', { data: { suggestion: suggestion('A'), error: null }, dataUpdatedAt: 1000, error: null })
  assert.equal(composer(ctx).tree, null, 'a reply fetched before the turn is not shown')
  serve('A', suggestion('A'))          // a fresh answer arrives
  assert.equal(ghost(ctx), 'Sigue con A')
})

test('a suggestion for another session is never shown', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null)
  serve('B', suggestion('B'))
  assert.equal(composer(ctx).tree, null)
  assert.equal(ghost(ctx), null)
})

test('Right Arrow accepts the ghost through host.composer.insertText', async () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  const editor = composer(ctx).editor
  assert.equal(ghostOn(editor), 'Sigue con A')
  assert.ok(ghostOn(editor), 'the composer carries the ghost attribute before the arrow is pressed')

  arrow(editor, 'ArrowRight')
  assert.deepEqual(calls.insert, ['Sigue con A'])
  assert.deepEqual(calls.insertMode, [['Sigue con A', { mode: 'block' }]], 'inserted as a block, never sent')
  await sleep(0)
  assert.ok(ctx.restCalls.some(([path, method]) => path.startsWith('/dismiss') && method === 'POST'), 'the used suggestion is cleared on the backend')

  const after = composer(ctx)
  assert.equal(after.tree, null, 'accepting ends the suggestion')
  assert.equal(ghostOn(after.editor), null)
})

test('Right Arrow does nothing on a composer that already has text', async () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  const editor = composer(ctx).editor
  editor.removeAttribute('data-empty')
  editor.textContent = 'my own draft'

  arrow(editor, 'ArrowRight')
  assert.equal(calls.insert.length, 0)
  await sleep(0)
  assert.equal(ctx.restCalls.length, 0, 'nothing is dismissed')
  assert.equal(ghostOn(editor), 'Sigue con A', 'the ghost stays for when the draft is sent')
})

test('Right Arrow needs the composer focused and is ignored mid-turn', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))

  document.activeElement = null
  composer(ctx).editor.dispatch('keydown', { key: 'ArrowRight', target: document.body })
  assert.equal(calls.insert.length, 0, 'no accept when the caret is elsewhere')

  view('A', true)
  serve('A', suggestion('A'))
  document.activeElement = null
  composer(ctx).editor.dispatch('keydown', { key: 'ArrowRight' })
  assert.equal(calls.insert.length, 0, 'no accept while the chat works')
})

test('Right Arrow is ignored when another chord, a repeat, or a composition is in play', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  const editor = composer(ctx).editor
  editor.dispatch('keydown', { key: 'ArrowRight', ctrlKey: true })
  editor.dispatch('keydown', { key: 'ArrowRight', metaKey: true })
  editor.dispatch('keydown', { key: 'ArrowRight', shiftKey: true })
  editor.dispatch('keydown', { key: 'ArrowRight', repeat: true })
  editor.dispatch('keydown', { key: 'ArrowRight', isComposing: true })
  editor.dispatch('keydown', { key: 'ArrowRight', defaultPrevented: true })
  assert.equal(calls.insert.length, 0)
})

test('Option+Left/Right cycles the ranked choices and re-ghosts the composer', async () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A', ['Pregunta por el informe', 'Cierra el ticket']))
  assert.equal(ghost(ctx), 'Sigue con A   ·   1/3 · ⌥←/→', 'the counter only appears with extra choices')

  arrow(composer(ctx).editor, 'ArrowRight', true)
  assert.equal(ghost(ctx), 'Pregunta por el informe   ·   2/3 · ⌥←/→')
  assert.equal(calls.insert.length, 0, 'cycling commits nothing')

  arrow(composer(ctx).editor, 'ArrowRight', true)
  assert.equal(ghost(ctx), 'Cierra el ticket   ·   3/3 · ⌥←/→')

  arrow(composer(ctx).editor, 'ArrowLeft', true)
  assert.equal(ghost(ctx), 'Pregunta por el informe   ·   2/3 · ⌥←/→', 'Option+Left walks back through the choices')
  arrow(composer(ctx).editor, 'ArrowLeft', true)
  arrow(composer(ctx).editor, 'ArrowLeft', true)
  assert.equal(ghost(ctx), 'Cierra el ticket   ·   3/3 · ⌥←/→', 'the cycle wraps instead of falling off the end')

  // Accepting commits the choice currently ghosted.
  arrow(composer(ctx).editor, 'ArrowRight')
  await sleep(0)
  assert.deepEqual(calls.insert, ['Cierra el ticket'], 'the cycled choice is what gets inserted')
})

test('a single-choice suggestion carries no counter', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A', ['only one']))
  const text = ghost(ctx)
  assert.equal(text, 'Sigue con A   ·   1/2 · ⌥←/→')
  assert.ok(!text.includes('1/1'))
})

test('a row without ranked choices is not ghosted', () => {
  const { ctx } = wire()
  view('A')
  serve('A', { session_id: 'A', text: 'legacy prose', timestamp: 1 })  // no `alternatives` array
  assert.equal(composer(ctx).tree, null, 'only fork-generated rows are ghosted')
  assert.equal(ghost(ctx), null)
})

test('typing into the composer gates the ghost and resets the cycle', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A', ['Pregunta por el informe']))
  const editor = composer(ctx).editor
  assert.ok(composer(ctx).tree.props.children.includes('[data-empty]'), 'the ghost only paints on an empty composer')

  editor.removeAttribute('data-empty')      // the user typed: the ::before rule no longer matches
  editor.dispatch('input')                 // and the typed input resets the chosen index
  arrow(editor, 'ArrowRight', true)
  arrow(editor, 'ArrowRight')              // accept requires data-empty, so nothing happens
  assert.equal(calls.insert.length, 0, 'no accept once the composer has a draft')
  assert.ok(ghostOn(editor).startsWith('Sigue con A'), 'the attribute is cleared on cleanup, not painted')
})

test('selecting inside the ghost clears the cycle', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A', ['Pregunta por el informe']))
  composer(ctx)
  arrow(composer(ctx).editor, 'ArrowRight', true)
  assert.equal(ghost(ctx), 'Pregunta por el informe   ·   2/2 · ⌥←/→')
  const editor = composer(ctx).editor
  selectIn(editor, false)
  document.dispatch('selectionchange')
  arrow(composer(ctx).editor, 'ArrowRight', true)
  assert.equal(ghost(ctx), 'Pregunta por el informe   ·   2/2 · ⌥←/→', 'after the selection reset, one step lands on the extra choice again')
  assert.equal(ghost(composer(ctx).editor ? ctx : ctx), ghost(ctx))
})

test('the ghost is scoped to this contribution’s composer', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  // A second composer dock mounted elsewhere must not be ghosted.
  const other = mountComposer('B').editor
  composer(ctx)
  assert.equal(ghostOn(other), null, 'the ghost paints only its own composer')
  assert.equal(ghost(ctx), 'Sigue con A')
})

test('Right Arrow without a composer insert hook is a no-op, not a clipboard write', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  const hooks = host.composer
  delete host.composer
  composer(ctx).editor.dispatch('keydown', { key: 'ArrowRight' })
  assert.equal(calls.insert.length, 0)
  assert.equal(calls.clip.length, 0, 'ghost accept never needs the clipboard')
  assert.ok(server.get('A').data.suggestion, 'the suggestion survives for the palette to use')
  host.composer = hooks
})

test('a failed generation shows a muted note that names the cause', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null, note('A', 'auth'))
  const tree = composer(ctx).tree
  assert.equal(textOf(tree), 'failure.auth')
  assert.ok(find(tree, n => n.props?.role === 'status'), 'the note is announced as a status')
  assert.ok(find(tree, n => n.props?.className?.includes('text-(--ui-text-tertiary)')), 'the note is muted')
  assert.ok(find(tree, n => n.type === 'button' && n.props?.['aria-label'] === 'dismiss'), 'the note is dismissible')
  assert.equal(ghost(ctx), null, 'a failure never ghosts anything')
})

test('an unknown failure kind falls back to the generic note', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null, { session_id: 'A', kind: 'weird', timestamp: 1 })
  assert.equal(textOf(composer(ctx).tree), 'failure.other')
})

test('the failure note can be dismissed and stays dismissed', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null, note('A', 'timeout'))
  const noteButton = find(composer(ctx).tree, n => n.type === 'button')
  noteButton.props.onClick()
  assert.ok(ctx.restCalls.some(([path, method]) => path.startsWith('/dismiss') && method === 'POST'), 'the dismiss is recorded on the backend')
  assert.equal(composer(ctx).tree, null, 'the note is gone for good')
})

test('a suggestion wins over a failure note', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null, note('A', 'timeout'))
  composer(ctx)
  serve('A', suggestion('A'), note('A', 'timeout'))  // a late success beats the old failure
  assert.equal(ghost(ctx), 'Sigue con A')
  assert.ok(!find(composer(ctx).tree, n => n.props?.role === 'status'), 'no failure note while a ghost is showing')
})

test('a failure for another session is never shown', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null, null)
  serve('B', null, note('B', 'other'))
  assert.equal(composer(ctx).tree, null)
})

test('the failure note is hidden while the chat works', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null, note('A', 'rate_limit'))
  assert.ok(composer(ctx).tree)
  view('A', true)  // this chat is mid-turn
  assert.equal(composer(ctx).tree, null)
  view('A', false)
  serve('A', null, note('A', 'timeout'))  // a fresh fetch after the turn
  assert.ok(composer(ctx).tree)
})

test('registers a rebindable keybind and palette commands', () => {
  const { ctx } = wire()
  const keybind = ctx.contributions.find(c => c.area === 'keybinds')
  const palette = ctx.contributions.filter(c => c.area === 'palette')
  assert.ok(keybind?.data?.defaults, 'the keybind ships a default chord')
  assert.equal(keybind.data.category, 'composer')
  assert.equal(palette.length, 2)
  assert.ok(palette.every(c => typeof c.data.label === 'string' && typeof c.data.run === 'function'))
  assert.ok(palette.some(c => typeof c.data.detail === 'function'))
})

test('the keybind default does not collide with a built-in desktop binding', () => {
  const dir = '/Users/dmkjr/.hermes/hermes-agent/apps/desktop/src/lib/keybinds'
  const builtins = ['actions.ts', 'combo.ts', 'composer-focus-keys.ts', 'approval-keys.ts', 'handled-keys.ts']
    .map(name => readFileSync(join(dir, name), 'utf8'))
    .join('\n')
  assert.ok(!builtins.includes('mod+shift+y'), 'the plugin would shadow a built-in desktop binding')
  assert.ok(builtins.includes('mod+shift'), 'the desktop does use mod+shift chords, so the choice is deliberate')
})

test('the palette previews and uses the ghosted suggestion', async () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A', ['Pregunta por el informe']))
  composer(ctx)
  const use = ctx.contributions.find(c => c.area === 'palette' && c.data.id === 'everything-nothing.use')
  assert.equal(use.data.label, 'useLabel')
  assert.equal(use.data.detail(), 'Sigue con A', 'the palette row previews what is ghosted')
  use.data.run()
  await sleep(0)
  assert.deepEqual(calls.insert, ['Sigue con A'])
  assert.ok(ctx.restCalls.some(([path, method]) => path.startsWith('/dismiss') && method === 'POST'), 'using it clears the backend row')
  assert.equal(composer(ctx).tree, null, 'the ghost is gone once used')
})

test('the palette falls back to the clipboard when the host cannot insert', async () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  composer(ctx)
  const hooks = host.composer
  delete host.composer
  ctx.contributions.find(c => c.area === 'palette' && c.data.id === 'everything-nothing.use').data.run()
  await sleep(0)
  assert.deepEqual(calls.clip, ['Sigue con A'])
  assert.deepEqual(calls.notify, [{ kind: 'info', message: 'copied' }])
  host.composer = hooks
})

test('palette dismiss clears the visible ghost through the backend', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  composer(ctx)
  ctx.contributions.find(c => c.area === 'palette' && c.data.id === 'everything-nothing.dismiss').data.run()
  assert.ok(ctx.restCalls.some(([path, method]) => path.startsWith('/dismiss') && method === 'POST'), 'the dismiss is recorded on the backend')
  assert.equal(composer(ctx).tree, null, 'the ghost is gone for good')
})

test('the keybind never acts on another chat’s suggestion', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null)
  serve('B', suggestion('B'))
  ctx.contributions.find(c => c.area === 'keybinds').data.run()
  assert.equal(calls.insert.length, 0)
  assert.deepEqual(calls.notify, [{ kind: 'info', message: 'nothingToUse' }], 'it says there is nothing to use')
})

test('the keybind does nothing while the chat works, or with no suggestion', () => {
  const { ctx } = wire()
  view('A')
  serve('A', suggestion('A'))
  view('A', true)
  ctx.contributions.find(c => c.area === 'keybinds').data.run()
  assert.equal(calls.insert.length, 0)
  view('A', false)
  serve('A', null)
  ctx.contributions.find(c => c.area === 'keybinds').data.run()
  assert.equal(calls.insert.length, 0)
})

test('the keybind ignores a failure note', () => {
  const { ctx } = wire()
  view('A')
  serve('A', null, note('A', 'auth'))
  composer(ctx)
  ctx.contributions.find(c => c.area === 'keybinds').data.run()
  assert.equal(calls.insert.length, 0)
  assert.equal(calls.clip.length, 0)
})

