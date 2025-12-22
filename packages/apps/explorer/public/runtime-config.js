(function () {
  if (typeof window === 'undefined') return
  // Backwards compatible no-op; the daemon may override this path and serve real values.
  window.__POWERGIT_RUNTIME_CONFIG__ = window.__POWERGIT_RUNTIME_CONFIG__ || null
})()
