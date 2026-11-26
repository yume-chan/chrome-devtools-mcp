/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Environment,
  getMemoryTempFilePath,
  type MemoryFileSystem,
  normalizeMemoryFileUrl,
  normalizeMemoryPath,
} from './memory-file-system-common.js';

const files = new Map<string, Uint8Array>();
const directories = new Set(['/']);

export const memoryVolume: Map<string, Uint8Array> = files;

export type {Environment, MemoryFileSystem};

export const memoryFileSystem: MemoryFileSystem = {
  readFile: readMemoryFileSystem,
  mkdir: makeMemoryDirectory,
  writeFile: writeMemoryFileSystem,
  rm: removeMemoryEntry,
};

export const memoryEnvironment: Environment = {
  fileSystem: memoryFileSystem,
  volume: memoryVolume,
  normalizePath: normalizeMemoryPath,
  normalizeFileUrl: normalizeMemoryFileUrl,
  getTempFilePath: getMemoryTempFilePath,
};

export {getMemoryTempFilePath, normalizeMemoryFileUrl, normalizeMemoryPath};

export async function readMemoryFile(filePath: string): Promise<Uint8Array> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const contents = await memoryFileSystem.readFile(normalizedPath);
  return new Uint8Array(contents);
}

export async function writeMemoryFile(
  filePath: string,
  data: Uint8Array,
): Promise<string> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  const parentPath = separator === 0 ? '/' : normalizedPath.slice(0, separator);
  await memoryFileSystem.mkdir(parentPath, {recursive: true});
  await memoryFileSystem.writeFile(normalizedPath, data);
  return normalizedPath;
}

async function readMemoryFileSystem(filePath: string): Promise<Uint8Array> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const contents = files.get(normalizedPath);
  if (!contents) {
    throw memoryFileSystemError(
      directories.has(normalizedPath) ? 'TypeMismatchError' : 'NotFoundError',
      `No file exists at ${normalizedPath}.`,
    );
  }
  return new Uint8Array(contents);
}

async function makeMemoryDirectory(
  directoryPath: string,
  options?: {recursive?: boolean},
): Promise<void> {
  const normalizedPath = normalizeMemoryPath(directoryPath);
  if (normalizedPath === '/') {
    return;
  }
  const segments = normalizedPath.split('/').filter(Boolean);
  let currentPath = '';
  for (const [index, segment] of segments.entries()) {
    currentPath += `/${segment}`;
    if (files.has(currentPath)) {
      throw memoryFileSystemError(
        'TypeMismatchError',
        `A file already exists at ${currentPath}.`,
      );
    }
    if (directories.has(currentPath)) {
      continue;
    }
    if (index !== segments.length - 1 && !options?.recursive) {
      throw memoryFileSystemError(
        'NotFoundError',
        `Parent directory does not exist for ${normalizedPath}.`,
      );
    }
    directories.add(currentPath);
  }
}

async function writeMemoryFileSystem(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  const parentPath = separator === 0 ? '/' : normalizedPath.slice(0, separator);
  if (!directories.has(parentPath)) {
    throw memoryFileSystemError(
      'NotFoundError',
      `Parent directory does not exist for ${normalizedPath}.`,
    );
  }
  if (directories.has(normalizedPath)) {
    throw memoryFileSystemError(
      'TypeMismatchError',
      `A directory already exists at ${normalizedPath}.`,
    );
  }
  files.set(
    normalizedPath,
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data),
  );
}

async function removeMemoryEntry(
  filePath: string,
  options?: {force?: boolean; recursive?: boolean},
): Promise<void> {
  const normalizedPath = normalizeMemoryPath(filePath);
  if (files.delete(normalizedPath)) {
    return;
  }
  if (!directories.has(normalizedPath)) {
    if (options?.force) {
      return;
    }
    throw memoryFileSystemError(
      'NotFoundError',
      `No file or directory exists at ${normalizedPath}.`,
    );
  }
  const nestedFiles = [...files.keys()].filter(path =>
    path.startsWith(`${normalizedPath}/`),
  );
  const nestedDirectories = [...directories].filter(
    path => path !== normalizedPath && path.startsWith(`${normalizedPath}/`),
  );
  if (
    (nestedFiles.length > 0 || nestedDirectories.length > 0) &&
    !options?.recursive
  ) {
    throw memoryFileSystemError(
      'InvalidModificationError',
      `Directory is not empty: ${normalizedPath}.`,
    );
  }
  for (const path of nestedFiles) {
    files.delete(path);
  }
  for (const path of nestedDirectories) {
    directories.delete(path);
  }
  directories.delete(normalizedPath);
}

function memoryFileSystemError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
