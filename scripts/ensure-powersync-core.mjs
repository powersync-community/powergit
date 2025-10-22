#!/usr/bin/env node

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, copyFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';

const require = createRequire(import.meta.url);
const NEEDLE = Buffer.from('powersync_disable_drop_view', 'utf8');
const PNPM_STORE_DIR = join(process.cwd(), 'node_modules', '.pnpm');
const CORE_DIR = join(process.cwd(), 'third_party', 'powersync-sqlite-core');

const PLATFORM_BINARIES = {
  darwin: {
    arm64: {
      source: 'libpowersync_aarch64.macos.dylib',
      dest: 'libpowersync.dylib',
    },
  },
};

function findPackageDir(specifier) {
  try {
    return dirname(require.resolve(`${specifier}/package.json`));
  } catch (error) {
    const encoded = specifier.replace('/', '+');
    let fallbackDir = null;
    try {
      for (const entry of readdirSync(PNPM_STORE_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith(`${encoded}@`)) continue;
        const candidate = join(
          PNPM_STORE_DIR,
          entry.name,
          'node_modules',
          ...specifier.split('/'),
        );
        fallbackDir = candidate;
        break;
      }
    } catch {
      // ignore – we'll surface the original error below.
    }
    if (fallbackDir) {
      return fallbackDir;
    }
    throw new Error(`Unable to resolve ${specifier}. Did pnpm install finish successfully? ${error.message}`);
  }
}

function bufferContainsNeedle(buffer) {
  return buffer.indexOf(NEEDLE) !== -1;
}

function readFileIfExists(path) {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function assertWebBinaryPatched() {
  const pkgDir = findPackageDir('@powersync/web');
  const distDir = join(pkgDir, 'dist');
  let inspected = 0;
  let matched = 0;

  for (const entry of readdirSync(distDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.wasm')) continue;
    inspected += 1;
    const candidate = readFileSync(join(distDir, entry.name));
    if (bufferContainsNeedle(candidate)) {
      matched += 1;
    }
  }

  if (inspected === 0) {
    throw new Error('Could not locate any wasm artifacts under @powersync/web/dist.');
  }
  if (matched === 0) {
    throw new Error(
      'Patched @powersync/web wasm file is missing powersync_disable_drop_view(); reapply the pnpm patch pipeline.',
    );
  }
}

function assertNodeBinaryPatched() {
  const pkgDir = findPackageDir('@powersync/node');
  const libDir = join(pkgDir, 'lib');
  const candidates = [
    'libpowersync.dylib',
    'libpowersync.so',
    'libpowersync.dll',
    'libpowersync.a',
    'libpowersync_x64.dylib',
    'libpowersync_aarch64.dylib',
  ];

  let inspected = 0;
  let matched = 0;

  for (const filename of candidates) {
    try {
      const buffer = readFileSync(join(libDir, filename));
      inspected += 1;
      if (bufferContainsNeedle(buffer)) {
        matched += 1;
      }
    } catch {
      // File does not exist on this platform – skip.
    }
  }

  if (inspected === 0) {
    throw new Error('Could not locate any libpowersync binaries under @powersync/node/lib.');
  }
  if (matched === 0) {
    throw new Error(
      'Patched @powersync/node library is missing powersync_disable_drop_view(); reapply the pnpm patch pipeline.',
    );
  }
}

function ensureNodeBinaryPatched() {
  const platform = process.platform;
  const arch = process.arch;
  const platformEntry = PLATFORM_BINARIES[platform]?.[arch];
  if (!platformEntry) {
    return;
  }

  const sourcePath = join(CORE_DIR, platformEntry.source);
  if (!existsSync(sourcePath)) {
    throw new Error(
      `Expected PowerSync core binary ${platformEntry.source} missing under ${CORE_DIR}. Rebuild third_party/powersync-sqlite-core.`,
    );
  }

  const pkgDir = findPackageDir('@powersync/node');
  const libDir = join(pkgDir, 'lib');
  let resolvedLibDir;
  try {
    resolvedLibDir = realpathSync(libDir);
  } catch (error) {
    throw new Error(`Unable to resolve @powersync/node/lib directory (${error.message}).`);
  }
  const destPath = join(resolvedLibDir, platformEntry.dest);

  const sourceBuffer = readFileSync(sourcePath);
  if (!bufferContainsNeedle(sourceBuffer)) {
    throw new Error(
      `Local PowerSync core binary ${platformEntry.source} is missing powersync_disable_drop_view(); rebuild the core before installing.`,
    );
  }

  const destBuffer = readFileIfExists(destPath);
  if (!destBuffer || !destBuffer.equals(sourceBuffer)) {
    copyFileSync(sourcePath, destPath);
    console.info(`[postinstall] Copied ${platformEntry.source} into @powersync/node (${platform}/${arch}).`);
  }

  const extension = extname(platformEntry.dest);
  if (extension) {
    const aliasName = `${platformEntry.dest}${extension}`;
    const aliasPath = join(resolvedLibDir, aliasName);
    if (!existsSync(aliasPath)) {
      try {
        symlinkSync(platformEntry.dest, aliasPath);
      } catch (error) {
        console.warn(`[postinstall] Failed to create alias ${aliasName}: ${error.message}`);
      }
    }
  }
}

try {
  ensureNodeBinaryPatched();
  assertWebBinaryPatched();
  assertNodeBinaryPatched();
  console.info('[postinstall] Verified PowerSync patched binaries are present.');
} catch (error) {
  console.error(`[postinstall] ${error.message}`);
  process.exitCode = 1;
}
