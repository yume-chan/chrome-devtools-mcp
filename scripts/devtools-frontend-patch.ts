/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {existsSync, statSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {execFileSync} from 'node:child_process';

const projectRoot = process.cwd();
const devtoolsDir = resolve(projectRoot, 'third_party', 'devtools-frontend');
const patchFile = resolve(projectRoot, 'third_party', 'devtools-frontend.patch');

function runGit(args: string[], cwd = devtoolsDir): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'stderr' in error) {
      const stderr = String(error.stderr).trim();
      if (stderr) {
        throw new Error(stderr);
      }
    }
    throw error;
  }
}

function validateSubmodule(): void {
  if (!existsSync(devtoolsDir) || !statSync(devtoolsDir).isDirectory()) {
    throw new Error(`DevTools submodule not found: ${devtoolsDir}`);
  }

  try {
    const insideWorkTree = runGit([
      'rev-parse',
      '--is-inside-work-tree',
    ]).trim();
    if (insideWorkTree !== 'true') {
      throw new Error('not a Git worktree');
    }
  } catch (error) {
    throw new Error(`Invalid DevTools submodule: ${devtoolsDir}: ${error}`);
  }
}

function addUntrackedFiles(): string[] {
  const output = runGit(['ls-files', '--others', '--exclude-standard', '-z']);
  const paths = output.split('\0').filter(path => path.length > 0);

  if (paths.length > 0) {
    runGit(['add', '--intent-to-add', '--', ...paths]);
  }
  return paths;
}

export function generatePatch(): string {
  validateSubmodule();

  const untrackedPaths = addUntrackedFiles();

  try {
    const patch = runGit([
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      'HEAD',
      '--',
    ]);

    if (!patch.trim()) {
      throw new Error('DevTools submodule has no tracked or untracked changes');
    }

    writeFileSync(patchFile, patch, 'utf8');
  } finally {
    if (untrackedPaths.length > 0) {
      runGit(['reset', '--quiet', '--', ...untrackedPaths]);
    }
  }

  console.log(`Generated patch: ${patchFile}`);
  return patchFile;
}

export function applyPatch(): void {
  validateSubmodule();

  if (!existsSync(patchFile) || !statSync(patchFile).isFile()) {
    throw new Error(`Patch file not found: ${patchFile}`);
  }

  runGit(['apply', '--check', patchFile]);
  runGit(['apply', patchFile]);
  console.log(`Applied patch: ${patchFile}`);
}

function printUsage(): void {
  console.log(`Usage:
  node scripts/devtools-frontend-patch.ts generate
  node scripts/devtools-frontend-patch.ts apply

Options:
  --generate, -g
  --apply, -a
  --help, -h

Examples:
  node scripts/devtools-frontend-patch.ts generate
  node scripts/devtools-frontend-patch.ts apply`);
}

async function main(): Promise<void> {
  const {values, positionals} = parseArgs({
    options: {
      generate: {
        type: 'boolean',
        short: 'g',
      },
      apply: {
        type: 'boolean',
        short: 'a',
      },
      help: {
        type: 'boolean',
        short: 'h',
      },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    return;
  }

  if (values.generate) {
    if (values.apply) {
      throw new Error('Use either --generate or --apply, not both');
    }
    generatePatch();
    return;
  }

  if (values.apply) {
    applyPatch();
    return;
  }

  const command = positionals[0];
  if (command === 'generate') {
    generatePatch();
  } else if (command === 'apply') {
    applyPatch();
  } else {
    printUsage();
    if (command) {
      throw new Error(`Unknown command: ${command}`);
    }
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  }
}
