import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const toolPanel = 'grid gap-3 rounded-lg border border-border bg-background p-4'
const toolField = 'w-full rounded border border-border bg-background px-2 py-1 text-sm'
const panelButton = 'rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

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

export default {
  id: 'everything-nothing',
  name: 'Everything Nothing',
  defaultEnabled: false,
  register(ctx) {
    ctx.registerSettingsPage({
      id: 'tools',
      title: 'Everything Nothing',
      icon: 'sparkle',
      render: () => jsxs('section', { className: toolPanel, children: [
        jsx('h2', { className: 'font-semibold', children: 'Everything Nothing' }),
        jsx('p', { children: 'Create reusable drafts in Template Studio and prepare UI guidance with Design Brief.' }),
        jsx('p', { children: 'Choose a Fluff Eater level in Agent settings for the Hermes profile you want to change.' })
      ] }),
      children: [
        { id: 'templates', title: 'Template Studio', render: () => jsx(TemplateStudio, { ctx }) },
        { id: 'design-brief', title: 'Design Brief', render: () => jsx(DesignBrief, { ctx }) }
      ]
    })
  }
}
