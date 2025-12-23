type ErrorLikeObject = {
  message?: unknown
  details?: unknown
  hint?: unknown
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function formatErrorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message || fallback

  if (typeof error === 'object') {
    const errorObject = error as ErrorLikeObject
    const message = nonEmptyString(errorObject.message)
    const details = nonEmptyString(errorObject.details)
    const hint = nonEmptyString(errorObject.hint)

    if (message) {
      const extras = [details, hint].filter(Boolean).join(' ')
      return extras ? `${message} ${extras}` : message
    }

    try {
      return JSON.stringify(error)
    } catch {
      return fallback
    }
  }

  return fallback
}

