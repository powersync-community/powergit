import { test as base, expect, type ConsoleMessage } from '@playwright/test'

function formatConsoleMessage(message: string, type: string, location?: string) {
  const prefix = `[console.${type}]`
  return location ? `${prefix} ${message} (@ ${location})` : `${prefix} ${message}`
}

function formatLocation(url?: string, lineNumber?: number, columnNumber?: number) {
  if (!url) return undefined
  const parts = [url]
  if (typeof lineNumber === 'number') {
    const line = lineNumber + 1
    if (typeof columnNumber === 'number') {
      const column = columnNumber + 1
      parts.push(`${line}:${column}`)
    } else {
      parts.push(`${line}`)
    }
  }
  return parts.join(':')
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const consoleLines: string[] = []
    const pageErrors: string[] = []

    const handleConsole = (msg: ConsoleMessage) => {
      const loc = msg.location()
      const formattedLocation = formatLocation(loc?.url, loc?.lineNumber, loc?.columnNumber)
      const text = msg.text()
      const type = msg.type()
      const formatted = formatConsoleMessage(text, type, formattedLocation)
      if (type === 'error' || type === 'warning') {
        consoleLines.push(formatted)
      }
      // Always surface the message in the worker output for quick diagnosis
      console.log(formatted)
    }

    const handlePageError = (error: Error) => {
      const formatted = `[pageerror] ${error.message}`
      pageErrors.push(formatted)
      console.log(formatted)
      if (error.stack) {
        console.log(error.stack)
      }
    }

    page.on('console', handleConsole)
    page.on('pageerror', handlePageError)

    try {
      await use(page)
    } finally {
      page.off('console', handleConsole)
      page.off('pageerror', handlePageError)

      if (consoleLines.length > 0) {
        await testInfo.attach('console-errors', {
          body: consoleLines.join('\n'),
          contentType: 'text/plain',
        })
      }

      if (pageErrors.length > 0) {
        await testInfo.attach('page-errors', {
          body: pageErrors.join('\n'),
          contentType: 'text/plain',
        })
      }
    }
  },
})

export { expect }
