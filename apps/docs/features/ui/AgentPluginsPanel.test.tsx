// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { useSearchParamsShallow } from 'common'
import { describe, expect, it, vi } from 'vitest'

import { AgentPluginsPanel } from './AgentPluginsPanel'
import { AGENT_CLIENT_PARAM } from './AgentPluginsPanel.data'

vi.mock('common', () => ({ useSearchParamsShallow: vi.fn() }))

const renderPanel = (search: string) => {
  vi.mocked(useSearchParamsShallow).mockReturnValue(
    new URLSearchParams(search) as unknown as ReturnType<typeof useSearchParamsShallow>
  )
  return render(<AgentPluginsPanel />)
}

describe('AgentPluginsPanel', () => {
  it('opens the instructions for the agent in the url', () => {
    renderPanel(`${AGENT_CLIENT_PARAM}=cursor`)

    expect(screen.getByRole('button', { name: /cursor/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /claude code/i })).toBeNull()
  })

  it('falls back to the first agent for an unknown agent in the url', () => {
    renderPanel(`${AGENT_CLIENT_PARAM}=not-an-agent`)

    expect(screen.getByRole('button', { name: /claude code/i })).toBeTruthy()
  })
})
