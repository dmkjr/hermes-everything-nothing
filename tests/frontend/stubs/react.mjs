// Effects run synchronously during render; cleanups are ignored.
export const useEffect = fn => {
  fn()
}
export const useRef = initial => ({ current: initial ?? null })
export const useState = initial => [initial, () => {}]
export default {}
