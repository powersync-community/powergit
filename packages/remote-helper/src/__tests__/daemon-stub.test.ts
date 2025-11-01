import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import { createDaemonStub } from './daemon-stub.js'

const stubs: Array<Awaited<ReturnType<typeof createDaemonStub>>> = []

afterEach(async () => {
  while (stubs.length > 0) {
    const stub = stubs.pop()
    if (!stub) continue
    await stub.close().catch(() => undefined)
  }
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
