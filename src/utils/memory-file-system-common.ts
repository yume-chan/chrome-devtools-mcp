/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface MemoryFileSystem {
  readFile(filePath: string): Promise<Uint8Array>;
  mkdir(directoryPath: string, options?: {recursive?: boolean}): Promise<void>;
  writeFile(filePath: string, data: string | Uint8Array): Promise<void>;
  rm(
    filePath: string,
    options?: {force?: boolean; recursive?: boolean},
  ): Promise<void>;
}

export interface Environment {
  readonly fileSystem: MemoryFileSystem;
  readonly volume: Map<string, Uint8Array>;
  normalizePath(filePath: string): string;
  normalizeFileUrl(fileUrl: string): string;
  getTempFilePath(filename: string): string;
}

export function normalizeMemoryPath(filePath: string): string {
  if (filePath.trim() === '') {
    throw new Error('File path must not be empty.');
  }

  const segments: string[] = [];
  for (const segment of filePath.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(`File path escapes the memory filesystem: ${filePath}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }

  return `/${segments.join('/')}`;
}

export function normalizeMemoryFileUrl(fileUrl: string): string {
  const url = new URL(fileUrl);
  if (url.protocol !== 'file:' || (url.host && url.host !== 'localhost')) {
    throw new Error(`Unsupported file URL: ${fileUrl}`);
  }
  return normalizeMemoryPath(decodeURIComponent(url.pathname));
}

export function getMemoryTempFilePath(filename: string): string {
  const normalizedFilename = filename.replaceAll('\\', '/');
  if (
    normalizedFilename.includes('/') ||
    normalizedFilename === '' ||
    normalizedFilename === '.' ||
    normalizedFilename === '..'
  ) {
    throw new Error(
      `Invalid temp file name "${filename}": it must not contain a directory.`,
    );
  }
  const directory = `/tmp/chrome-devtools-mcp-${globalThis.crypto.randomUUID()}`;
  return `${directory}/${normalizedFilename}`;
}
