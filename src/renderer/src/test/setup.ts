// jsdom does not implement ResizeObserver, which react-resizable-panels needs.
// Registered for every test file; it only acts when a DOM environment exists.
if (typeof window !== 'undefined' && !('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub
}
