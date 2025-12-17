import * as React from 'react'
import { HashLoader } from 'react-spinners'

type InlineSpinnerProps = {
  size?: number
  color?: string
  className?: string
  'aria-label'?: string
}

export function InlineSpinner({
  size = 14,
  color = '#10b981',
  className = '',
  'aria-label': ariaLabel = 'Loading',
}: InlineSpinnerProps) {
  return (
    <span className={`inline-flex items-center justify-center ${className}`} aria-label={ariaLabel} role="status">
      <HashLoader size={size} color={color} speedMultiplier={0.9} loading aria-label={ariaLabel} />
    </span>
  )
}
