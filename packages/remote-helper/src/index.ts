
import { spawn } from 'node:child_process'
import { parsePowerSyncUrl, invokeSupabaseEdgeFunction } from '@shared/core'
import { PowerSyncRemoteClient, type FetchPackResult } from '@shared/core/node'

const ZERO_SHA = '0000000000000000000000000000000000000000'

interface FetchRequest { sha: string; name: string }

let parsed: ReturnType<typeof parsePowerSyncUrl> | null = null
let remote: PowerSyncRemoteClient | null = null
let tokenPromise: Promise<string | undefined> | null = null
let fetchBatch: FetchRequest[] = []

function println(s: string = '') { process.stdout.write(s + '\n') }

export async function runHelper() {
  initFromArgs()
  process.stdin.setEncoding('utf8')
  for await (const line of readLines(process.stdin)) {
    const raw = line.replace(/\r$/, '')
    if (raw.length === 0) {
      if (fetchBatch.length) await flushFetchBatch()
      continue
    }

    const parts = raw.trim().split(/\s+/)
    const cmd = parts[0]
    detectRemoteReference(parts)

    if (cmd === 'capabilities') {
      println('fetch')
      println('push')
      println('option')
      println('list')
      println('')
      continue
    }

    if (cmd === 'option') {
      println('ok')
      continue
    }

    if (cmd === 'list') {
      await handleList()
      continue
    }

    if (cmd === 'fetch') {
      if (parts.length >= 3) fetchBatch.push({ sha: parts[1], name: parts[2] })
      continue
    }

    if (cmd === 'push') {
      // TODO: integrate push pipeline once backend is ready
      println('error push-not-implemented')
      println('')
      continue
    }
  }
  if (fetchBatch.length) await flushFetchBatch()
}

async function handleList() {
  const details = ensureRemote()
  if (!details) {
    println(`${ZERO_SHA} refs/heads/main`)
    println('')
    return
  }
  const client = ensureClient()
  if (!client) {
    println(`${ZERO_SHA} refs/heads/main`)
    println('')
    return
  }
  try {
    const { refs, head } = await client.listRefs(details.org, details.repo)
    if (head?.target) println(`@${head.target} HEAD`)
    for (const ref of refs) {
      const sha = ref.target_sha && ref.target_sha.length === ZERO_SHA.length ? ref.target_sha : ZERO_SHA
      println(`${sha} ${ref.name}`)
    }
    println('')
  } catch (error) {
    console.error(`[powersync] failed to list refs: ${(error as Error).message}`)
    println(`${ZERO_SHA} refs/heads/main`)
    println('')
  }
}

async function flushFetchBatch() {
  const details = ensureRemote()
  fetchBatch = dedupeFetch(fetchBatch)
  if (!details || fetchBatch.length === 0) {
    println('')
    fetchBatch = []
    return
  }
  const client = ensureClient()
  if (!client) {
    println('')
    fetchBatch = []
    return
  }

  try {
    const wants = fetchBatch.map(item => item.sha).filter(Boolean)
    if (wants.length === 0) {
      println('')
      fetchBatch = []
      return
    }
    const pack = await client.fetchPack({ org: details.org, repo: details.repo, wants })
    await writePackToGit(pack)
    println('')
  } catch (error) {
    console.error(`[powersync] fetch failed: ${(error as Error).message}`)
    println('')
  } finally {
    fetchBatch = []
  }
}

async function writePackToGit(result: FetchPackResult) {
  const stream = result.stream
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['index-pack', '--stdin', '--fix-thin'], { stdio: ['pipe', 'inherit', 'inherit'] })
    stream.pipe(child.stdin!)
    child.stdin!.on('error', reject)
    stream.on('error', reject)
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`git index-pack exited with code ${code}`))
    })
  })
}

function dedupeFetch(items: FetchRequest[]): FetchRequest[] {
  const seen = new Set<string>()
  const result: FetchRequest[] = []
  for (const item of items) {
    if (!seen.has(item.sha)) {
      seen.add(item.sha)
      result.push(item)
    }
  }
  return result
}

function ensureClient(): PowerSyncRemoteClient | null {
  if (!parsed) return null
  if (!remote) {
    remote = new PowerSyncRemoteClient({
      endpoint: parsed.endpoint,
      getToken: async () => resolveAuthToken(),
    })
  }
  return remote
}

function ensureRemote(): { org: string; repo: string } | null {
  if (!parsed) return null
  return { org: parsed.org, repo: parsed.repo }
}

function detectRemoteReference(parts: string[]) {
  if (parsed) return
  const candidate = parts.find(part => part?.startsWith?.('powersync::'))
  if (candidate) {
    try { parsed = parsePowerSyncUrl(candidate) } catch (error) {
      console.error(`[powersync] failed to parse remote URL: ${(error as Error).message}`)
    }
  }
}

function initFromArgs() {
  if (parsed) return
  const args = process.argv.slice(2)
  const candidate = args.find(arg => arg?.startsWith?.('powersync::'))
  if (candidate) {
    try { parsed = parsePowerSyncUrl(candidate) } catch {}
  }
}

async function resolveAuthToken(): Promise<string | undefined> {
  const direct = process.env.POWERSYNC_REMOTE_TOKEN || process.env.POWERSYNC_TOKEN || process.env.POWERSYNC_AUTH_TOKEN
  if (direct) return direct
  if (!parsed) return undefined
  if (!tokenPromise) tokenPromise = requestSupabaseToken(parsed)
  return tokenPromise
}

async function requestSupabaseToken(details: { endpoint: string; org: string; repo: string }): Promise<string | undefined> {
  const supabaseUrl = process.env.POWERSYNC_SUPABASE_URL
  const serviceKey = process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return undefined
  const functionName = process.env.POWERSYNC_SUPABASE_REMOTE_FN ?? 'powersync-remote-token'
  try {
    const response = await invokeSupabaseEdgeFunction<{ token?: string }>(functionName, {
      remoteUrl: `${details.endpoint}/orgs/${details.org}/repos/${details.repo}`,
    }, { url: supabaseUrl, serviceRoleKey: serviceKey })
    return response?.token
  } catch (error) {
    console.error('[powersync] failed to fetch Supabase remote token', error)
    return undefined
  }
}

async function* readLines(stream: NodeJS.ReadableStream) {
  let buf = ''
  for await (const chunk of stream) {
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      yield line
    }
  }
  if (buf.length > 0) yield buf
}

export const __internals = {
  requestSupabaseToken,
}
