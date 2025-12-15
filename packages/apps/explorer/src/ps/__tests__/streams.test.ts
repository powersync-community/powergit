import { describe, expect, it } from 'vitest'
import { normalizeRepoList, resolveRepoTargets, resolveDefaultRepos } from '../streams'

describe('stream helpers', () => {
  it('normalizes repo ids', () => {
    expect(normalizeRepoList([' main ', 'main', 'dev'])).toEqual(['main', 'dev'])
  })

  it('falls back to default repos when none passed', () => {
    const targets = resolveRepoTargets([])
    expect(targets.length).toBeGreaterThan(0)
  })

  it('resolves comma separated default repos from env string', () => {
    expect(resolveDefaultRepos('alpha, beta ')).toEqual(['alpha', 'beta'])
  })
})
