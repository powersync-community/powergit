import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoStreamTargets, type PowerSyncImportJob } from '@shared/core';

type StepId = 'clone' | 'prepare' | 'push' | 'subscribe' | 'cleanup';

const STEP_DEFINITIONS: Array<{ id: StepId; label: string }> = [
  { id: 'clone', label: 'Clone GitHub repository' },
  { id: 'prepare', label: 'Configure PowerSync remote' },
  { id: 'push', label: 'Push repository data to PowerSync' },
  { id: 'subscribe', label: 'Subscribe PowerSync streams' },
  { id: 'cleanup', label: 'Clean temporary workspace' },
];

const REMOTE_NAME = 'powersync';

export interface StreamSubscriptionTarget {
  id: string;
  parameters?: Record<string, unknown> | null;
}

export interface GithubImportRequest {
  repoUrl: string;
  orgId?: string | null;
  repoId?: string | null;
  branch?: string | null;
}

interface NormalizedGithubImportRequest {
  repoUrl: string;
  owner: string;
  repo: string;
  orgId: string;
  repoId: string;
  branch: string | null;
}

export class ImportValidationError extends Error {}

export interface GithubImportManagerOptions {
  daemonBaseUrl: string;
  subscribeStreams: (targets: StreamSubscriptionTarget[]) => Promise<void> | void;
}

export class GithubImportManager {
  private readonly jobs = new Map<string, PowerSyncImportJob>();

  constructor(private readonly options: GithubImportManagerOptions) {}

  enqueue(request: GithubImportRequest): PowerSyncImportJob {
    const normalized = normalizeGithubRequest(request);
    const now = new Date().toISOString();
    const job: PowerSyncImportJob = {
      id: randomUUID(),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      repoUrl: normalized.repoUrl,
      orgId: normalized.orgId,
      repoId: normalized.repoId,
      branch: normalized.branch,
      steps: STEP_DEFINITIONS.map((step) => ({
        id: step.id,
        label: step.label,
        status: 'pending',
      })),
      logs: [],
      error: null,
      result: null,
    };
    this.jobs.set(job.id, job);
    this.addLog(job, 'info', `Queued import for ${normalized.owner}/${normalized.repo}`);
    void this.processJob(job, normalized);
    return cloneJob(job);
  }

  listJobs(): PowerSyncImportJob[] {
    return Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => cloneJob(job));
  }

  getJob(id: string): PowerSyncImportJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return cloneJob(job);
  }

  private async processJob(job: PowerSyncImportJob, request: NormalizedGithubImportRequest): Promise<void> {
    let workspaceDir: string | null = null;
    let repoDir: string | null = null;
    let defaultBranch: string | null = null;

    try {
      this.setStatus(job, 'running');
      workspaceDir = await mkdtemp(join(tmpdir(), 'powersync-import-'));
      repoDir = join(workspaceDir, 'repo');

      await this.runStep(job, 'clone', async () => {
        await runGit(['clone', request.repoUrl, repoDir!], { cwd: workspaceDir! });
        return `Cloned ${request.owner}/${request.repo}`;
      });

      await this.runStep(job, 'prepare', async () => {
        defaultBranch = await detectCurrentBranch(repoDir!);
        const remoteUrl = buildPowerSyncRemoteUrl(this.options.daemonBaseUrl, request.orgId, request.repoId);
        await ensureRemoteConfigured(repoDir!, remoteUrl);
        return `Remote configured (${REMOTE_NAME}) — default branch ${defaultBranch ?? 'unknown'}`;
      });

      await this.runStep(job, 'push', async () => {
        await pushAllReferences(repoDir!);
        return 'Pushed all branches and tags to PowerSync';
      });

      await this.runStep(job, 'subscribe', async () => {
        const targets = buildRepoStreamTargets(request.orgId, request.repoId).map((target) => ({
          id: target.id,
          parameters: target.parameters,
        }));
        await Promise.resolve(this.options.subscribeStreams(targets));
        return `Subscribed ${targets.length} streams`;
      });

      job.result = {
        orgId: request.orgId,
        repoId: request.repoId,
        branch: request.branch,
        defaultBranch,
      };
      this.addLog(job, 'info', 'Import completed successfully');
      this.setStatus(job, 'success');
    } catch (error) {
      const message = toErrorMessage(error);
      job.error = message;
      this.addLog(job, 'error', message);
      this.setStatus(job, 'error');
    } finally {
      await this.runCleanup(job, workspaceDir);
    }
  }

  private async runCleanup(job: PowerSyncImportJob, workspaceDir: string | null): Promise<void> {
    this.setStepStatus(job, 'cleanup', 'active');
    if (!workspaceDir) {
      this.setStepStatus(job, 'cleanup', 'done', 'No workspace allocated');
      return;
    }
    try {
      await rm(workspaceDir, { recursive: true, force: true });
      this.setStepStatus(job, 'cleanup', 'done', 'Workspace cleaned');
    } catch (error) {
      const message = toErrorMessage(error);
      this.addLog(job, 'warn', `Cleanup failed: ${message}`);
      this.setStepStatus(job, 'cleanup', 'done', 'Workspace retained for troubleshooting');
    }
  }

  private async runStep(
    job: PowerSyncImportJob,
    stepId: StepId,
    task: () => Promise<string | void>,
  ): Promise<void> {
    this.setStepStatus(job, stepId, 'active');
    try {
      const detail = await task();
      this.setStepStatus(job, stepId, 'done', typeof detail === 'string' ? detail : undefined);
    } catch (error) {
      const message = toErrorMessage(error);
      this.setStepStatus(job, stepId, 'error', message);
      this.addLog(job, 'error', `${STEP_DEFINITIONS.find((s) => s.id === stepId)?.label ?? stepId} failed: ${message}`);
      throw error;
    }
  }

  private addLog(job: PowerSyncImportJob, level: 'info' | 'warn' | 'error', message: string): void {
    job.logs.push({
      id: randomUUID(),
      level,
      message,
      timestamp: new Date().toISOString(),
    });
    this.touch(job);
  }

  private setStatus(job: PowerSyncImportJob, status: PowerSyncImportJob['status']): void {
    job.status = status;
    this.touch(job);
  }

  private setStepStatus(
    job: PowerSyncImportJob,
    stepId: StepId,
    status: PowerSyncImportJob['steps'][number]['status'],
    detail?: string,
  ): void {
    const step = job.steps.find((entry) => entry.id === stepId);
    if (!step) return;
    step.status = status;
    if (detail !== undefined) {
      step.detail = detail;
    }
    this.touch(job);
  }

  private touch(job: PowerSyncImportJob): void {
    job.updatedAt = new Date().toISOString();
  }
}

async function runGit(args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`git ${args.join(' ')} failed (${code})${stderr ? `: ${stderr.trim()}` : ''}`);
        (error as Error & { stdout?: string; stderr?: string }).stdout = stdout;
        (error as Error & { stdout?: string; stderr?: string }).stderr = stderr;
        reject(error);
      }
    });
  });
}

async function ensureRemoteConfigured(repoDir: string, remoteUrl: string): Promise<void> {
  await runGit(['remote', 'remove', REMOTE_NAME], { cwd: repoDir }).catch(() => undefined);
  await runGit(['remote', 'add', REMOTE_NAME, remoteUrl], { cwd: repoDir });
}

async function pushAllReferences(repoDir: string): Promise<void> {
  await runGit(['push', '--prune', REMOTE_NAME, '--all'], { cwd: repoDir });
  await runGit(['push', REMOTE_NAME, '--tags'], { cwd: repoDir });
}

async function detectCurrentBranch(repoDir: string): Promise<string | null> {
  const result = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir }).catch(() => ({ stdout: '', stderr: '' }));
  const branch = result.stdout.trim();
  if (branch && branch !== 'HEAD') {
    return branch;
  }
  return null;
}

function buildPowerSyncRemoteUrl(baseUrl: string, orgId: string, repoId: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const encodedOrg = encodeURIComponent(orgId);
  const encodedRepo = encodeURIComponent(repoId);
  return `powersync::${normalizedBase}/orgs/${encodedOrg}/repos/${encodedRepo}`;
}

function normalizeGithubRequest(request: GithubImportRequest): NormalizedGithubImportRequest {
  const parsed = parseGithubUrl(request.repoUrl);
  if (!parsed) {
    throw new ImportValidationError('Invalid GitHub repository URL. Expected format https://github.com/<owner>/<repo>');
  }
  const orgId = sanitizeSlug(request.orgId ?? parsed.owner);
  const repoId = sanitizeSlug(request.repoId ?? parsed.repo);
  const branch = sanitizeBranch(request.branch);
  return {
    repoUrl: parsed.url,
    owner: parsed.owner,
    repo: parsed.repo,
    orgId,
    repoId,
    branch,
  };
}

function sanitizeSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (normalized.length === 0) {
    throw new ImportValidationError('Repository slug cannot be empty after sanitization');
  }
  return normalized;
}

function sanitizeBranch(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseGithubUrl(raw: string): { owner: string; repo: string; url: string } | null {
  const candidate = raw.trim();
  if (!candidate) return null;
  let normalized = candidate;

  if (!/^[a-z]+:\/\//i.test(normalized)) {
    if (normalized.startsWith('github.com/')) {
      normalized = `https://${normalized}`;
    } else if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/i.test(normalized)) {
      normalized = `https://github.com/${normalized}`;
    } else {
      normalized = `https://${normalized}`;
    }
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return null;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const owner = parts[0] ?? '';
  let repo = parts[1] ?? '';
  if (!owner || !repo) {
    return null;
  }
  if (repo.toLowerCase().endsWith('.git')) {
    repo = repo.slice(0, -4);
  }

  return {
    owner,
    repo,
    url: `https://github.com/${owner}/${repo}.git`,
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Unknown error';
}

function cloneJob(job: PowerSyncImportJob): PowerSyncImportJob {
  return JSON.parse(JSON.stringify(job)) as PowerSyncImportJob;
}
