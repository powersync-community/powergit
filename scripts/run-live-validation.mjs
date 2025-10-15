#!/usr/bin/env node
import { spawn } from 'node:child_process';

const REQUIRED_ENV_VARS = [
  'PSGIT_TEST_REMOTE_URL',
  'PSGIT_TEST_SUPABASE_URL',
  'PSGIT_TEST_SUPABASE_EMAIL',
  'PSGIT_TEST_SUPABASE_PASSWORD',
];

function main() {
  const missing = REQUIRED_ENV_VARS.filter((name) => !process.env[name] || process.env[name]?.length === 0);

  if (missing.length > 0) {
    console.error('[live-validate] Missing environment variables:');
    for (const name of missing) {
      console.error(`  - ${name}`);
    }
    console.error(
      '\nSet the variables above (or source an env file) before running the live validation.\n' +
        'See docs/supabase.md for details on required values.',
    );
    process.exit(1);
  }

  const child = spawn(
    'pnpm',
    ['--filter', '@pkg/cli', 'test', '--', '--run', 'src/cli.e2e.test.ts', '--reporter=default'],
    {
      stdio: 'inherit',
      env: process.env,
    },
  );

  child.on('close', (code) => {
    process.exit(code ?? 0);
  });

  child.on('error', (error) => {
    console.error('[live-validate] Failed to launch CLI tests:', error);
    process.exit(1);
  });
}

main();
