import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AuthScreen } from './AuthScreen'

const TEST_EMAIL = 'user@example.com'
const TEST_PASSWORD = 'hunter2!'

describe('AuthScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('submits sign-in, sign-up, and reset requests', async () => {
    const onSignIn = vi.fn().mockResolvedValue(undefined)
    const onSignUp = vi.fn().mockResolvedValue(undefined)
    const onResetPassword = vi.fn().mockResolvedValue(undefined)

    render(
      <AuthScreen
        onSignIn={onSignIn}
        onSignUp={onSignUp}
        onResetPassword={onResetPassword}
        allowGuest={false}
      />,
    )

    fireEvent.change(screen.getByPlaceholderText('Email'), { target: { value: TEST_EMAIL } })
    fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: TEST_PASSWORD } })

    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))

    await waitFor(() => {
      expect(onSignIn).toHaveBeenCalledWith(TEST_EMAIL, TEST_PASSWORD)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }))

    await waitFor(() => {
      expect(onSignUp).toHaveBeenCalledWith(TEST_EMAIL, TEST_PASSWORD)
    })

    fireEvent.click(screen.getByRole('button', { name: 'Forgot password?' }))

    await waitFor(() => {
      expect(onResetPassword).toHaveBeenCalledWith(TEST_EMAIL)
    })
  })

  it('renders guest sign-in button when enabled', async () => {
    const onSignIn = vi.fn().mockResolvedValue(undefined)
    const onSignUp = vi.fn().mockResolvedValue(undefined)
    const onResetPassword = vi.fn().mockResolvedValue(undefined)
    const onGuestSignIn = vi.fn().mockResolvedValue(undefined)

    render(
      <AuthScreen
        onSignIn={onSignIn}
        onSignUp={onSignUp}
        onResetPassword={onResetPassword}
        onGuestSignIn={onGuestSignIn}
        allowGuest
      />,
    )

    fireEvent.click(screen.getByTestId('guest-continue-button'))

    await waitFor(() => {
      expect(onGuestSignIn).toHaveBeenCalledTimes(1)
    })
  })
})
