#!/usr/bin/env node

import { cp, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const workspaceRoot = process.env.PNPM_WORKSPACE_DIR
  ? resolve(process.env.PNPM_WORKSPACE_DIR)
  : resolve(__dirname, '..', '..', '..');

const explorerDist = resolve(workspaceRoot, 'packages/apps/explorer/dist');
const daemonDistUi = resolve(workspaceRoot, 'packages/daemon/dist/daemon/ui');

async function ensureDirExists(path) {
  try {
    const info = await stat(path);
    return info.isDirectory() || info.isFile();
  } catch {
    return false;
  }
}

async function main() {
  if (!(await ensureDirExists(resolve(explorerDist, 'index.html')))) {
    throw new Error(`Explorer dist missing. Expected ${resolve(explorerDist, 'index.html')}`);
  }

  await rm(daemonDistUi, { recursive: true, force: true });
  await cp(explorerDist, daemonDistUi, { recursive: true });

  console.info(`[daemon] bundled Explorer UI → ${daemonDistUi}`);
}

main().catch((error) => {
  console.error('[daemon] failed to bundle Explorer UI', error?.message ?? error);
  process.exit(1);
});

