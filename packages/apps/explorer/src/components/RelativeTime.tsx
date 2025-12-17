import * as React from 'react'

export type RelativeTimeProps = {
  iso: string | null | undefined
  className?: string
  prefix?: React.ReactNode
  titlePrefix?: string
  updateIntervalMs?: number
}

function formatRelative(nowMs: number, dateMs: number): string {
  const diffSeconds = Math.round((dateMs - nowMs) / 1000)
  const absSeconds = Math.abs(diffSeconds)
  const isFuture = diffSeconds > 0

  const wrap = (value: number, unit: string) => (isFuture ? `in ${value}${unit}` : `${value}${unit} ago`)

  if (!isFuture && absSeconds < 10) return 'just now'
  if (absSeconds < 60) return wrap(absSeconds, 's')

  const diffMinutes = Math.round(diffSeconds / 60)
  const absMinutes = Math.abs(diffMinutes)
  if (absMinutes < 60) return wrap(absMinutes, 'm')

  const diffHours = Math.round(diffMinutes / 60)
  const absHours = Math.abs(diffHours)
  if (absHours < 24) return wrap(absHours, 'h')

  const diffDays = Math.round(diffHours / 24)
  const absDays = Math.abs(diffDays)
  if (absDays < 7) return wrap(absDays, 'd')

  const diffWeeks = Math.round(diffDays / 7)
  const absWeeks = Math.abs(diffWeeks)
  return wrap(absWeeks, 'w')
}

export function RelativeTime({
  iso,
  className,
  prefix,
  titlePrefix,
  updateIntervalMs = 10_000,
}: RelativeTimeProps) {
  const [nowMs, setNowMs] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (!iso) return undefined
    const id = window.setInterval(() => setNowMs(Date.now()), updateIntervalMs)
    return () => window.clearInterval(id)
  }, [iso, updateIntervalMs])

  if (!iso) return null
  const dateMs = Date.parse(iso)
  if (Number.isNaN(dateMs)) return null

  const absolute = (() => {
    try {
      return new Date(dateMs).toLocaleString()
    } catch {
      return iso
    }
  })()

  const title = titlePrefix ? `${titlePrefix} ${absolute}` : absolute

  return (
    <time dateTime={iso} title={title} className={className}>
      {prefix}
      {formatRelative(nowMs, dateMs)}
    </time>
  )
}

