import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonStub } from './daemon-stub.js'
import { __internals } from '../index.js'

const stubs: Array<Awaited<ReturnType<typeof createDaemonStub>>> = []
const { ensureDaemonReady, __setDaemonBaseUrlForTests } = __internals

afterEach(async () => {
  while (stubs.length > 0) {
    const stub = stubs.pop()
    if (!stub) continue
    await stub.close().catch(() => undefined)
  }
})

describe('ensureDaemonReady authentication handling', () => {
  it('resolves when daemon auth status is ready', async () => {
    const stub = await createDaemonStub()
    stubs.push(stub)
    stub.setAuthStatus({ status: 'ready' })
    __setDaemonBaseUrlForTests(stub.baseUrl)

    await expect(ensureDaemonReady()).resolves.toBeUndefined()
  })

  it('throws when daemon requires authentication', async () => {
    const stub = await createDaemonStub()
    stubs.push(stub)
    stub.setAuthStatus({ status: 'auth_required', context: { challengeId: 'abc123' } })
    __setDaemonBaseUrlForTests(stub.baseUrl)

    await expect(ensureDaemonReady()).rejects.toThrow(/PowerSync daemon is not authenticated/)
  })

  it('waits for pending authentication to complete', async () => {
    const stub = await createDaemonStub()
    stubs.push(stub)
    stub.setAuthStatus({ status: 'pending', context: { challengeId: 'pending123' } })
    __setDaemonBaseUrlForTests(stub.baseUrl)

    const readyPromise = ensureDaemonReady()
    setTimeout(() => {
      stub.setAuthStatus({ status: 'ready' })
    }, 150)

    await expect(readyPromise).resolves.toBeUndefined()
  })
})

describe('daemon stub harness', () => {
  it('records stream subscription payloads', async () => {
    const stub = await createDaemonStub()
    stubs.push(stub)

    const response = await fetch(`${stub.baseUrl}/streams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        streams: [
          { id: 'orgs/{org_id}/repos/{repo_id}/refs', parameters: { org_id: 'acme', repo_id: 'infra' } },
        ],
      }),
    })
    expect(response.status).toBe(200)

    const recorded = stub.recordStreamSubscriptions()
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toHaveLength(1)
    expect(recorded[0][0]).toMatchObject({
      id: 'orgs/{org_id}/repos/{repo_id}/refs',
      parameters: { org_id: 'acme', repo_id: 'infra' },
    })
  })

  it('serves configured refs and records fetch requests', async () => {
    const stub = await createDaemonStub()
    stubs.push(stub)

    stub.setListRefs('acme', 'infra', {
      refs: [{ id: 'ref-1', name: 'refs/heads/main', target_sha: 'abc123' }],
      head: { target: 'refs/heads/main' },
    })

    stub.setFetchPack('acme', 'infra', {
      body: { pack: Buffer.from('hello').toString('base64'), packEncoding: 'base64' },
    })

    const refsResponse = await fetch(`${stub.baseUrl}/orgs/acme/repos/infra/refs`)
    expect(refsResponse.status).toBe(200)
    const refsData = await refsResponse.json()
    expect(Array.isArray(refsData.refs)).toBe(true)
    expect(refsData.refs[0].id).toBe('ref-1')

    const fetchResponse = await fetch(`${stub.baseUrl}/orgs/acme/repos/infra/git/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wants: ['abc123'] }),
    })
    expect(fetchResponse.status).toBe(200)
    const fetchData = await fetchResponse.json()
    expect(fetchData.pack).toBeDefined()

    const requests = stub.recordedFetchRequests()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      orgId: 'acme',
      repoId: 'infra',
    })
  })
})
