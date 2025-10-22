export interface StartStackOptions {
  skipSeeds?: boolean
  skipDemoSeed?: boolean
  skipSyncRules?: boolean
}

export interface StackEnv extends Record<string, string> {}

export function startStack(options?: StartStackOptions): Promise<StackEnv>
export interface StopStackOptions {
  force?: boolean
}

export function stopStack(options?: StopStackOptions): Promise<void>
export function getStackEnv(): StackEnv | null
export function isStackRunning(): boolean
