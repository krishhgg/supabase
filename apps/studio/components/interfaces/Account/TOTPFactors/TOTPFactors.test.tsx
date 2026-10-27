import type { AuthMFARecoveryCodesStatusResponseData, Factor, User } from '@supabase/supabase-js'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { mockAnimationsApi } from 'jsdom-testing-mocks'
import { http, HttpResponse } from 'msw'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TOTPFactors } from './index'
import type { AccountRecoveryFinding } from '@/lib/account-recovery/evaluate-account-recovery'
import { auth } from '@/lib/gotrue'
import { customRender } from '@/tests/lib/custom-render'
import { mswServer } from '@/tests/lib/msw'

mockAnimationsApi()

vi.hoisted(() => {
  vi.stubEnv('NEXT_PUBLIC_GOTRUE_URL', 'http://localhost:8000/auth/v1')
})
vi.mock('common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('common')>()),
  useFlag: () => true,
  useUser: () => ({ id: 'user-a' }),
}))
vi.mock('./AddNewFactorModal', () => ({
  AddNewFactorModal: ({ visible, onClose }: { visible: boolean; onClose: () => void }) =>
    visible ? (
      <div role="dialog" aria-label="Add authenticator">
        <button tabIndex={0} onClick={onClose}>
          Cancel setup
        </button>
      </div>
    ) : null,
}))
vi.mock('./DeleteFactorModal', () => ({ DeleteFactorModal: () => null }))

type AuthUserResponse = Omit<User, 'factors'> & {
  factors: (Omit<Factor, 'status'> & { status: 'verified' | 'unverified' })[]
}

const factor: Factor = {
  id: 'factor-a',
  friendly_name: 'Phone',
  factor_type: 'totp',
  status: 'verified',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
}
const renderSection = (finding?: AccountRecoveryFinding, searchParams = '') =>
  customRender(
    <TOTPFactors
      findings={finding ? [finding] : []}
      primaryAction={finding?.action ?? 'enable-mfa'}
    />,
    { nuqs: { searchParams } }
  )

describe('account security MFA and recovery sections', () => {
  const mockUser = (factors: AuthUserResponse['factors'] = [factor]) => {
    mswServer.use(
      http.get('*/auth/v1/user', () =>
        HttpResponse.json<AuthUserResponse>({
          id: 'user-a',
          aud: 'authenticated',
          role: 'authenticated',
          email: 'test@example.com',
          app_metadata: {},
          user_metadata: {},
          created_at: '2026-10-01T00:00:00Z',
          factors,
        })
      )
    )
  }

  beforeEach(async () => {
    mockUser()
    mswServer.use(
      http.get('*/auth/v1/factors/recovery-codes', () =>
        HttpResponse.json<AuthMFARecoveryCodesStatusResponseData>({
          id: 'codes-a',
          type: 'recovery_code',
          remaining: 10,
          total: 10,
        })
      )
    )
    const expiresAt = Math.floor(Date.now() / 1000) + 3600
    const token = [
      btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
      btoa(JSON.stringify({ sub: 'user-a', exp: expiresAt })),
      'test-signature',
    ].join('.')
    const { error } = await auth.setSession({ access_token: token, refresh_token: 'test-refresh' })
    expect(error).toBeNull()
  })

  afterAll(() => vi.unstubAllEnvs())

  afterEach(async () => {
    await auth.stopAutoRefresh()
    window.localStorage.clear()
  })

  it('shows MFA off when only unverified authenticators exist', async () => {
    mockUser([{ ...factor, status: 'unverified' }])
    renderSection()
    expect(await screen.findByText('Set up multi-factor authentication')).toBeInTheDocument()
    const setupButtons = [
      screen.getByRole('button', { name: 'Set up MFA' }),
      screen.getByRole('button', { name: 'Set up MFA first' }),
    ]
    expect(setupButtons).toHaveLength(2)
    expect(screen.getByText('Set up recovery codes')).toBeInTheDocument()
    await userEvent.click(setupButtons[1])
    expect(await screen.findByRole('dialog', { name: 'Add authenticator' })).toBeInTheDocument()
  })

  it('shows missing codes with a generation action', async () => {
    mswServer.use(
      http.get('*/auth/v1/factors/recovery-codes', () =>
        HttpResponse.json(
          { code: 'mfa_factor_not_found', msg: 'Recovery codes have not been generated' },
          { status: 404, headers: { 'X-Supabase-Api-Version': '2024-01-01' } }
        )
      )
    )
    renderSection({ id: 'recovery-codes-missing', severity: 'warning', action: 'generate-codes' })
    expect(await screen.findByText('No recovery codes')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Generate recovery codes' })).toHaveLength(1)
    expect(screen.getByText('Set up recovery codes')).toBeInTheDocument()
    expect(screen.queryByText('Avoid being locked out')).not.toBeInTheDocument()
  })

  it.each([1, 3])('shows a low code count of %s with a regeneration action', async (remaining) => {
    mswServer.use(
      http.get('*/auth/v1/factors/recovery-codes', () =>
        HttpResponse.json<AuthMFARecoveryCodesStatusResponseData>({
          id: 'codes-a',
          type: 'recovery_code',
          remaining,
          total: 10,
        })
      )
    )
    renderSection({
      id: 'recovery-codes-low',
      severity: 'warning',
      action: 'regenerate-codes',
      remainingCodes: remaining,
    })
    expect(
      await screen.findByText(`${remaining} of 10 recovery codes available`)
    ).toBeInTheDocument()
    expect(
      screen.getByText('Generate a new set before you need them to recover your account.')
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Regenerate' })).toHaveLength(1)
    expect(
      screen.getByText('Each code can only be used once. Keep them somewhere safe.')
    ).toBeInTheDocument()
  })

  it('shows exhausted codes and keeps removal in the options menu', async () => {
    mswServer.use(
      http.get('*/auth/v1/factors/recovery-codes', () =>
        HttpResponse.json<AuthMFARecoveryCodesStatusResponseData>({
          id: 'codes-a',
          type: 'recovery_code',
          remaining: 0,
          total: 10,
        })
      )
    )
    renderSection({
      id: 'recovery-codes-exhausted',
      severity: 'critical',
      action: 'regenerate-codes',
      remainingCodes: 0,
    })
    expect(await screen.findByText('Recovery codes used up')).toBeInTheDocument()
    expect(screen.getByText('0 of 10 recovery codes available')).toBeInTheDocument()
    expect(
      screen.getByText('Generate a new set so you have a backup way to sign in.')
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Regenerate' })).toHaveLength(1)
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Recovery code options' }))
    expect(await screen.findByRole('menuitem', { name: 'Remove codes' })).toBeInTheDocument()
  })

  it('shows available codes without inventing a backup recommendation', async () => {
    renderSection()
    expect(await screen.findByText('10 of 10 recovery codes available')).toBeInTheDocument()
    expect(screen.getByText('Phone')).toBeInTheDocument()
    expect(screen.queryByText('1 verified authenticator')).not.toBeInTheDocument()
    expect(screen.queryByText('Add a backup authenticator')).not.toBeInTheDocument()
  })

  it('shows a backup warning with one authenticator action', async () => {
    renderSection({ id: 'single-mfa-factor', severity: 'warning', action: 'add-factor' })
    expect(await screen.findByText('Add a backup authenticator')).toBeInTheDocument()
    expect(await screen.findAllByRole('button', { name: 'Add authenticator' })).toHaveLength(1)
    expect(
      await screen.findByRole('button', { name: 'Remove Phone authenticator' })
    ).toBeInTheDocument()
  })

  it('does not infer missing codes or allow removal when the status check fails', async () => {
    mswServer.use(
      http.get('*/auth/v1/factors/recovery-codes', () =>
        HttpResponse.json(
          { code: 'unexpected_failure', msg: 'Status unavailable' },
          { status: 500 }
        )
      )
    )
    renderSection()
    expect(await screen.findByText('Failed to load recovery codes')).toBeInTheDocument()
    expect(screen.queryByText('No recovery codes')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Generate recovery codes' })
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Phone authenticator' })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  })
})
