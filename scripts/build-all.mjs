#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')

/**
 * Run a command and exit on failure.
 * @param {string} label
 * @param {string} command
 * @param {string[]} args
 * @param {string} cwd
 */
function runStep(label, command, args, cwd = repoRoot) {
  console.info(`\n▶ ${label}`)
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    console.error(`\n✖ ${label} failed (exit code ${result.status ?? 1}).`)
    process.exit(result.status ?? 1)
  }
}

function hasCargo() {
  const probe = spawnSync('cargo', ['--version'], {
    stdio: 'ignore',
  })
  return probe.status === 0
}

const buildSteps = [
  {
    label: 'Build shared core package',
    command: 'pnpm',
    args: ['--filter', '@powersync-community/powergit-core', 'build'],
  },
  {
    label: 'Build daemon service',
    command: 'pnpm',
    args: ['--filter', '@powersync-community/powergit-daemon', 'build'],
  },
  {
    label: 'Build CLI (powergit)',
    command: 'pnpm',
    args: ['--filter', '@powersync-community/powergit', 'build'],
  },
  {
    label: 'Build remote helper',
    command: 'pnpm',
    args: ['--filter', '@powersync-community/powergit-remote-helper', 'build'],
  },
  {
    label: 'Build explorer web app',
    command: 'pnpm',
    args: ['--filter', '@app/explorer', 'build'],
  },
]

for (const step of buildSteps) {
  runStep(step.label, step.command, step.args, step.cwd)
}

if (hasCargo()) {
  const rustDir = resolve(repoRoot, 'third_party', 'powersync-sqlite-core')
  runStep('Build PowerSync core (Rust)', 'cargo', ['build', '--release'], rustDir)
} else {
  console.warn('\n⚠ cargo not found on PATH – skipping Rust PowerSync core build.')
}

console.info('\n✔ Build completed')
