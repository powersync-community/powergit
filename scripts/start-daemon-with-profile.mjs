#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  resolveDaemonBaseUrl,
  isDaemonResponsive,
  ensureDaemonSupabaseAuth,
} from './dev-shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

async function loadProfile() {
  const module = await import('../packages/cli/src/profile-env.js');
  return module.loadProfileEnvironment;
}

function parseArgs(rawArgs) {
  const options = {
    profile: null,
    passThrough: [],
    stackEnv: true,
  };

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === '--') {
      options.passThrough.push(...rawArgs.slice(i + 1));
      break;
    }
    switch (arg) {
      case '--profile':
      case '-p': {
        if (i + 1 >= rawArgs.length) {
          throw new Error('--profile expects a profile name');
        }
        options.profile = rawArgs[i + 1];
        i += 1;
        break;
      }
      case '--no-stack-env':
        options.stackEnv = false;
        break;
      default:
        options.passThrough.push(arg);
        break;
    }
  }

  return options;
}

function launchDaemon(env, passThrough) {
  const args = ['--filter', '@svc/daemon', 'start', ...passThrough];
  const child = spawn('pnpm', args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  });

  child.on('close', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });

  child.on('error', (error) => {
    console.error('[dev:daemon] failed to start daemon:', error);
    process.exit(1);
  });

  return child;
}

async function refreshDaemonAfterLaunch(env) {
  const baseUrl = resolveDaemonBaseUrl(env);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isDaemonResponsive(baseUrl)) {
      break;
    }
    await delay(500);
  }

  const authResult = await ensureDaemonSupabaseAuth({
    env,
    logger: console,
    metadata: { initiatedBy: 'start-daemon-with-profile' },
  });
  if (authResult.status?.status === 'ready') {
    console.info('[dev:daemon] daemon authenticated via Supabase.');
  } else {
    console.warn('[dev:daemon] daemon authentication skipped or failed — run "pnpm cli login" if required.');
  }
}

async function main() {
  const { profile, passThrough, stackEnv } = parseArgs(process.argv.slice(2));
  const loadProfileEnvironment = await loadProfile();
  let envResult;

  try {
    envResult = loadProfileEnvironment({
      profile,
      updateState: true,
      startDir: repoRoot,
      includeStackEnv: stackEnv,
    });
  } catch (error) {
    console.error('[dev:daemon] failed to load profile environment:', error?.message ?? error);
    process.exit(1);
  }

  const activeProfile = envResult?.profile?.name;
  if (activeProfile) {
    console.info(`[dev:daemon] launching daemon with profile "${activeProfile}"`);
  }

  const combinedEnv = { ...process.env, ...envResult?.combinedEnv };
  if (!combinedEnv.SUPABASE_WRITER_FAILURE_THRESHOLD && !combinedEnv.POWERSYNC_SUPABASE_WRITER_FAILURE_THRESHOLD) {
    combinedEnv.SUPABASE_WRITER_FAILURE_THRESHOLD = '20';
  }
  const child = launchDaemon(combinedEnv, passThrough);
  void refreshDaemonAfterLaunch(combinedEnv);
}

main().catch((error) => {
  console.error('[dev:daemon] unexpected error:', error);
  process.exit(1);
});
