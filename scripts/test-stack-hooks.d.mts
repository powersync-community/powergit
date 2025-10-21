export interface StartStackOptions {
  skipSeeds?: boolean
  skipDemoSeed?: boolean
  skipSyncRules?: boolean
}

export interface StackEnv extends Record<string, string> {}

export function startStack(options?: StartStackOptions): Promise<StackEnv>
export function stopStack(): Promise<void>
export function getStackEnv(): StackEnv | null
export function isStackRunning(): boolean
