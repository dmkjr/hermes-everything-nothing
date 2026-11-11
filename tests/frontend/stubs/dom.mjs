// A deliberately small DOM stand-in, enough for the ghost-text effect in
// desktop/plugin.js to run for real: attributes, listeners, closest(),
// querySelector(), document.activeElement and selectionchange. The plugin
// reaches the composer through its own contribution anchor, so the harness
// has to mount a composer dock for it to find.

export const ghostAttribute = 'data-next-prompt-ghost'

class Element {
  constructor(tag, attrs = {}) {
    this.tag = tag
    this.attrs = { ...attrs }
    this.children = []
    this.parent = null
    this.listeners = new Map()
    this.textContent = ''
    this.isContentEditable = false
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }
  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name)
  }
  removeAttribute(name) {
    delete this.attrs[name]
  }

  append(child) {
    child.parent = this
    this.children.push(child)
    return child
  }

  contains(node) {
    if (node === this) return true
    return this.children.some(child => child.contains(node))
  }

  closest(selector) {
    const attrs = selectorAttrs(selector)
    for (let node = this; node; node = node.parent) {
      if (matches(node, attrs)) return node
    }
    return null
  }

  querySelector(selector) {
    const chain = selector.split(/\s+/).map(selectorAttrs)
    let nodes = [this]
    for (const attrs of chain) {
      const next = []
      for (const node of nodes) collect(node, attrs, next)
      if (!next.length) return null
      nodes = next
    }
    return nodes[0] || null
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(handler)
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) || []
    this.listeners.set(type, list.filter(h => h !== handler))
  }

  /** Fire an event at this element; handlers run in registration order. */
  dispatch(type, event = {}) {
    const fired = {
      type,
      target: this,
      repeat: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault() { fired.defaultPrevented = true },
      stopPropagation() { fired.propagated = false },
      ...event
    }
    fired.preventDefault = () => { fired.defaultPrevented = true }
    fired.stopPropagation = () => { fired.propagated = false }
    for (const handler of (this.listeners.get(type) || []).slice()) handler(fired)
  }
}

// Parse `[a="b"] [c="d"]` without regex escaping surprises.
function selectorAttrs(selector) {
  const out = {}
  let i = 0
  while (i < selector.length) {
    if (selector[i] !== '[') { i += 1; continue }
    const close = selector.indexOf(']', i)
    const inner = selector.slice(i + 1, close)
    const eq = inner.indexOf('=')
    out[inner.slice(0, eq).trim()] = inner.slice(eq + 1).trim().replace(/^"|"$/g, '')
    i = close + 1
  }
  return out
}

function matches(node, attrs) {
  return Object.entries(attrs).every(([key, value]) => node.getAttribute(key) === value)
}

function collect(node, attrs, out) {
  for (const child of node.children) {
    if (matches(child, attrs)) out.push(child)
    collect(child, attrs, out)
  }
}

/** Mount one chat's composer dock: dock > surface > rich input (empty). */
export function mountComposer(storedId) {
  const dock = new Element('div', { 'data-slot': 'composer-dock', 'data-stored-session': storedId })
  const surface = dock.append(new Element('div', { 'data-slot': 'composer-surface' }))
  const editor = surface.append(new Element('div', { 'data-slot': 'composer-rich-input', contenteditable: 'true', 'data-empty': '' }))
  editor.isContentEditable = true
  return { dock, editor }
}

/** Minimal `document` the plugin's keydown guard reads. */
export const document = {
  activeElement: null,
  _listeners: new Map(),
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(handler)
  },
  removeEventListener(type, handler) {
    this._listeners.set(type, (this._listeners.get(type) || []).filter(h => h !== handler))
  },
  dispatch(type, event = {}) {
    for (const handler of (this._listeners.get(type) || []).slice()) handler(event)
  },
  selection: null,
  getSelection() {
    return this.selection
  }
}

export function selectIn(editor, collapsed) {
  document.selection = { isCollapsed: collapsed, anchorNode: editor }
}
