import { Buffer as PolyfillBuffer } from 'buffer'

type BufferConstructor = typeof PolyfillBuffer

const globalWithBuffer = globalThis as typeof globalThis & { Buffer?: BufferConstructor }

if (typeof globalWithBuffer.Buffer === 'undefined') {
  globalWithBuffer.Buffer = PolyfillBuffer
}

export const Buffer = globalWithBuffer.Buffer
