import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'
import simpleGit from 'simple-git'
import { addPowerSyncRemote } from '../index.js'

vi.mock('simple-git', () => ({
  default: vi.fn(),
}))

describe('addPowerSyncRemote', () => {
  const simpleGitMock = simpleGit as unknown as Mock

  beforeEach(() => {
    simpleGitMock.mockReset()
  })

  it('adds the remote when it is missing', async () => {
    const getRemotes = vi.fn().mockResolvedValue([])
    const addRemote = vi.fn().mockResolvedValue(undefined)
    const remote = vi.fn().mockResolvedValue(undefined)
    const gitApi = { getRemotes, addRemote, remote }

    simpleGitMock.mockReturnValue(gitApi)

    await addPowerSyncRemote('/tmp/repo', 'origin', 'powergit::url')

    expect(getRemotes).toHaveBeenCalledOnce()
    expect(addRemote).toHaveBeenCalledWith('origin', 'powergit::url')
    expect(remote).not.toHaveBeenCalled()
  })

  it('updates the remote URL when it already exists', async () => {
    const getRemotes = vi.fn().mockResolvedValue([
      { name: 'origin', refs: { fetch: 'https://example.dev', push: 'https://example.dev' } },
    ])
    const addRemote = vi.fn()
    const remote = vi.fn().mockResolvedValue(undefined)
    const gitApi = { getRemotes, addRemote, remote }

    simpleGitMock.mockReturnValue(gitApi)

    await addPowerSyncRemote('/tmp/repo', 'origin', 'powergit::new-url')

    expect(addRemote).not.toHaveBeenCalled()
    expect(remote).toHaveBeenCalledWith(['set-url', 'origin', 'powergit::new-url'])
  })
})
