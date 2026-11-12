// Effects run when the element is mounted, not during render: the harness
// collects them and flushes them once the DOM around the contribution exists.
export const pendingEffects = []
export const useEffect = fn => {
  pendingEffects.push(fn)
}
export const flushEffects = () => pendingEffects.splice(0).forEach(fn => fn())
export const useRef = initial => ({ current: initial ?? null })
export const useState = initial => [initial, () => {}]
export default {}
