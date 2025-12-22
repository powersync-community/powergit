import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseEnvLine(line: string): [string, string] | null {
  const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
  if (!assignment) return null
  const [, key, rawValue] = assignment
  return [key, stripWrappingQuotes(rawValue)]
}

export function parseStackEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const entry = parseEnvLine(trimmed)
    if (!entry) continue
    const [key, value] = entry
    result[key] = value
  }
  return result
}

export interface LocateStackEnvOptions {
  startDir?: string
}

export function locateStackEnvPath(path: string, { startDir = process.cwd() }: LocateStackEnvOptions = {}): string | null {
  if (isAbsolute(path)) {
    return existsSync(path) ? path : null
  }

  let current = startDir
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const candidate = resolve(current, path)
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return null
}

export interface LoadStackEnvOptions extends LocateStackEnvOptions {
  silent?: boolean
}

export interface LoadedStackEnv {
  path: string
  values: Record<string, string>
}

export function loadStackEnv(path: string, options?: LoadStackEnvOptions): LoadedStackEnv | null {
  const resolvedPath = locateStackEnvPath(path, options)
  if (!resolvedPath) {
    return null
  }
  const content = readFileSync(resolvedPath, 'utf8')
  const values = parseStackEnvContent(content)
  return { path: resolvedPath, values }
}

