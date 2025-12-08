import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'

type ImportStepStatus = 'pending' | 'active' | 'done' | 'error'
type ImportStatus = 'queued' | 'running' | 'success' | 'error'
type LogLevel = 'info' | 'warn' | 'error'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  // Allow common Supabase/SB-JS headers and fall back to wildcard for safety.
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

interface GithubImportPayload {
  repoUrl?: string
  orgId?: string | null
  repoId?: string | null
  branch?: string | null
  edgeBaseUrl?: string | null
}

interface PowerSyncImportJob {
  id: string
  status: ImportStatus
  createdAt: string
  updatedAt: string
  repoUrl: string
  orgId: string
  repoId: string
  branch?: string | null
  steps: Array<{ id: string; label: string; status: ImportStepStatus; detail?: string | null }>
  logs: Array<{ id: string; level: LogLevel; message: string; timestamp: string }>
  error?: string | null
  result?: { orgId: string; repoId: string; branch?: string | null; defaultBranch?: string | null } | null
  workflowUrl?: string
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  let payload: GithubImportPayload
  try {
    payload = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const parsed = parseGithubUrl(payload.repoUrl ?? '')
  if (!parsed) {
    return json({ error: 'Provide a valid GitHub repository URL (e.g. https://github.com/org/repo).' }, 400)
  }

  const repoUrl = payload.repoUrl!.trim()
  const orgId = (payload.orgId ?? slugify(parsed.owner)).trim()
  const repoId = (payload.repoId ?? slugify(parsed.repo)).trim()
  const branch = payload.branch ?? null
  const edgeBaseUrl = payload.edgeBaseUrl ?? Deno.env.get('POWERSYNC_EDGE_BASE_URL') ?? null

  if (!orgId || !repoId) {
    return json({ error: 'Missing org/repo identifiers after normalization.' }, 400)
  }

  const token = env('GITHUB_TOKEN') ?? env('TOKEN')
  const owner = env('GITHUB_REPO_OWNER') ?? env('GITHUB_OWNER')
  const repo = env('GITHUB_REPO_NAME') ?? env('GITHUB_REPO')
  const workflowFile = env('GITHUB_WORKFLOW_FILE') ?? 'clone-and-push.yml'
  const workflowRef = env('GITHUB_WORKFLOW_REF') ?? 'main'

  if (!token || !owner || !repo) {
    return json(
      {
        error:
          'Missing GitHub configuration. Set GITHUB_TOKEN (or TOKEN), GITHUB_REPO_OWNER, and GITHUB_REPO_NAME in the function environment.',
      },
      500,
    )
  }

  const dispatchBody: Record<string, unknown> = {
    ref: workflowRef,
    inputs: {
      git_url: repoUrl,
      org: orgId,
      repo: repoId,
      ...(edgeBaseUrl ? { edge_base_url: edgeBaseUrl } : {}),
    },
  }

  const ghRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    {
      method: 'POST',
      headers: {
        'User-Agent': 'powersync-edge-dispatch',
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(dispatchBody),
    },
  )

  if (!ghRes.ok) {
    const details = (await ghRes.text().catch(() => '')).trim()
    return json(
      {
        error: `GitHub dispatch failed (${ghRes.status} ${ghRes.statusText}).`,
        details: details ? details.slice(0, 500) : undefined,
      },
      502,
    )
  }

  const now = new Date().toISOString()
  const workflowUrl = buildWorkflowUrl(owner, repo, workflowFile)
  const job: PowerSyncImportJob = {
    id: crypto.randomUUID(),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    repoUrl,
    orgId,
    repoId,
    branch,
    steps: [
      {
        id: 'dispatch',
        label: 'Dispatch GitHub Action',
        status: 'done',
        detail: `Queued ${workflowFile} on ${workflowRef}`,
      },
      {
        id: 'github-run',
        label: 'GitHub Actions run',
        status: 'pending',
        detail: workflowUrl ? `Monitor workflow at ${workflowUrl}` : 'Monitor the GitHub Actions run',
      },
      {
        id: 'powersync',
        label: 'Push to PowerSync',
        status: 'pending',
        detail: edgeBaseUrl ? `Edge base URL: ${edgeBaseUrl}` : 'Using workflow secret edge_base_url',
      },
    ],
    logs: [
      {
        id: 'dispatch',
        level: 'info',
        message: `workflow_dispatch queued for ${owner}/${repo} (${workflowFile} → ${workflowRef})`,
        timestamp: now,
      },
    ],
    error: null,
    result: {
      orgId,
      repoId,
      branch,
      defaultBranch: null,
    },
    workflowUrl,
  }

  return json({ job, workflowUrl }, 202)
})

function env(name: string): string | null {
  const value = Deno.env.get(name)
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  })
}

function parseGithubUrl(value: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(value.trim())
    if (!/github\.com$/i.test(url.host)) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/i, '') }
  } catch {
    return null
  }
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function buildWorkflowUrl(owner: string, repo: string, workflowFile: string): string | null {
  if (!owner || !repo || !workflowFile) return null
  return `https://github.com/${owner}/${repo}/actions/workflows/${workflowFile}`
}
