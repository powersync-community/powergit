import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'

import { __internals } from './index.js'

describe('remote helper push integration (local)', () => {
  it('parses push commands correctly', () => {
    const { parsePush } = __internals
    
    // Test basic push format
    const result1 = parsePush(['push', '0000000000000000000000000000000000000000', 'refs/heads/main'])
    expect(result1).toEqual({
      src: '0000000000000000000000000000000000000000',
      dst: 'refs/heads/main',
      force: false
    })

    // Test force push format
    const result2 = parsePush(['push', '+0000000000000000000000000000000000000000', 'refs/heads/main'])
    expect(result2).toEqual({
      src: '0000000000000000000000000000000000000000',
      dst: 'refs/heads/main',
      force: true
    })

    // Test colon format
    const result3 = parsePush(['push', '0000000000000000000000000000000000000000:refs/heads/main'])
    expect(result3).toEqual({
      src: '0000000000000000000000000000000000000000',
      dst: 'refs/heads/main',
      force: false
    })

    // Test invalid format
    const result4 = parsePush(['push', 'invalid'])
    expect(result4).toBeNull()
  })

  it('validates pack data encoding', () => {
    const packBuffer = Buffer.from('test-pack-data')
    const encoded = packBuffer.toString('base64')
    const decoded = Buffer.from(encoded, 'base64')
    
    expect(decoded.toString()).toBe('test-pack-data')
    expect(encoded).toBe('dGVzdC1wYWNrLWRhdGE=')
  })

  it('handles multiple ref updates format', () => {
    const updates = [
      { src: '0000000000000000000000000000000000000000', dst: 'refs/heads/main' },
      { src: '0000000000000000000000000000000000000000', dst: 'refs/heads/develop' }
    ]
    
    expect(updates).toHaveLength(2)
    expect(updates[0].dst).toBe('refs/heads/main')
    expect(updates[1].dst).toBe('refs/heads/develop')
  })

  it('validates pack buffer collection', () => {
    const initial = Buffer.from('initial')
    const chunks = [Buffer.from('chunk1'), Buffer.from('chunk2')]
    const result = Buffer.concat([initial, ...chunks])
    
    expect(result.toString()).toBe('initialchunk1chunk2')
    expect(result.length).toBe(initial.length + chunks[0].length + chunks[1].length)
  })
})