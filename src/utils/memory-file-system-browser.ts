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

const memoryFiles = new Map<string, Uint8Array>();
const memoryDirectories = new Set(['/']);

export const memoryVolume: Map<string, Uint8Array> = memoryFiles;
export const opfsVolume: Map<string, Uint8Array> = new Map();

export const memoryFileSystem: MemoryFileSystem = {
  readFile: readMemoryFile,
  mkdir: mkdirMemoryDirectory,
  writeFile: writeMemoryFile,
  rm: removeMemoryEntry,
};

export const opfsFileSystem: MemoryFileSystem = {
  readFile: readOpfsFile,
  mkdir: mkdirOpfsDirectory,
  writeFile: writeOpfsFile,
  rm: removeOpfsEntry,
};

export const opfsEnvironment: Environment = {
  fileSystem: opfsFileSystem,
  volume: opfsVolume,
  normalizePath: normalizeMemoryPath,
  normalizeFileUrl: normalizeMemoryFileUrl,
  getTempFilePath: getMemoryTempFilePath,
};

export const memoryEnvironment: Environment =
  typeof navigator !== 'undefined' &&
  navigator.storage !== undefined &&
  typeof navigator.storage.getDirectory === 'function'
    ? opfsEnvironment
    : {
        fileSystem: memoryFileSystem,
        volume: memoryVolume,
        normalizePath: normalizeMemoryPath,
        normalizeFileUrl: normalizeMemoryFileUrl,
        getTempFilePath: getMemoryTempFilePath,
      };

export {getMemoryTempFilePath, normalizeMemoryFileUrl, normalizeMemoryPath};

export async function readMemoryFile(filePath: string): Promise<Uint8Array> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const contents = memoryFiles.get(normalizedPath);
  if (!contents) {
    throw memoryFileSystemError(
      memoryDirectories.has(normalizedPath)
        ? 'TypeMismatchError'
        : 'NotFoundError',
      `No file exists at ${normalizedPath}.`,
    );
  }
  return new Uint8Array(contents);
}

async function mkdirMemoryDirectory(
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
    if (memoryFiles.has(currentPath)) {
      throw memoryFileSystemError(
        'TypeMismatchError',
        `A file already exists at ${currentPath}.`,
      );
    }
    if (memoryDirectories.has(currentPath)) {
      continue;
    }
    if (index !== segments.length - 1 && !options?.recursive) {
      throw memoryFileSystemError(
        'NotFoundError',
        `Parent directory does not exist for ${normalizedPath}.`,
      );
    }
    memoryDirectories.add(currentPath);
  }
}

export async function writeMemoryFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  const parentPath = separator === 0 ? '/' : normalizedPath.slice(0, separator);
  if (!memoryDirectories.has(parentPath)) {
    throw memoryFileSystemError(
      'NotFoundError',
      `Parent directory does not exist for ${normalizedPath}.`,
    );
  }
  if (memoryDirectories.has(normalizedPath)) {
    throw memoryFileSystemError(
      'TypeMismatchError',
      `A directory already exists at ${normalizedPath}.`,
    );
  }
  memoryFiles.set(
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
  if (memoryFiles.delete(normalizedPath)) {
    return;
  }
  if (!memoryDirectories.has(normalizedPath)) {
    if (options?.force) {
      return;
    }
    throw memoryFileSystemError(
      'NotFoundError',
      `No file or directory exists at ${normalizedPath}.`,
    );
  }
  const nestedFiles = [...memoryFiles.keys()].filter(path =>
    path.startsWith(`${normalizedPath}/`),
  );
  const nestedDirectories = [...memoryDirectories].filter(
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
    memoryFiles.delete(path);
  }
  for (const path of nestedDirectories) {
    memoryDirectories.delete(path);
  }
  memoryDirectories.delete(normalizedPath);
}

async function getOpfsRoot(): Promise<FileSystemDirectoryHandle> {
  if (
    typeof navigator === 'undefined' ||
    navigator.storage === undefined ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    throw new Error('Origin private file system is not available.');
  }
  return await navigator.storage.getDirectory();
}

async function getOpfsDirectory(
  root: FileSystemDirectoryHandle,
  directoryPath: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle> {
  let directory = root;
  for (const segment of normalizeMemoryPath(directoryPath)
    .split('/')
    .filter(Boolean)) {
    directory = await directory.getDirectoryHandle(segment, {create});
  }
  return directory;
}

export async function readOpfsFile(filePath: string): Promise<Uint8Array> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  const directoryPath =
    separator === 0 ? '/' : normalizedPath.slice(0, separator);
  const filename =
    separator === 0
      ? normalizedPath.slice(1)
      : normalizedPath.slice(separator + 1);
  const directory = await getOpfsDirectory(
    await getOpfsRoot(),
    directoryPath,
    false,
  );
  const file = await (await directory.getFileHandle(filename)).getFile();
  const data = new Uint8Array(await file.arrayBuffer());
  opfsVolume.set(normalizedPath, data);
  return data;
}

async function mkdirOpfsDirectory(
  directoryPath: string,
  options?: {recursive?: boolean},
): Promise<void> {
  const root = await getOpfsRoot();
  const normalizedPath = normalizeMemoryPath(directoryPath);
  if (normalizedPath === '/') {
    return;
  }
  const segments = normalizedPath.split('/').filter(Boolean);
  let directory = root;
  const recursive = options?.recursive ?? true;
  for (const [index, segment] of segments.entries()) {
    const create = recursive || index === segments.length - 1;
    directory = await directory.getDirectoryHandle(segment, {create});
  }
}

export async function writeOpfsFile(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  const directoryPath =
    separator === 0 ? '/' : normalizedPath.slice(0, separator);
  const filename =
    separator === 0
      ? normalizedPath.slice(1)
      : normalizedPath.slice(separator + 1);
  const directory = await getOpfsDirectory(
    await getOpfsRoot(),
    directoryPath,
    true,
  );
  const file = await directory.getFileHandle(filename, {create: true});
  const writable = await file.createWritable();
  const bytes =
    typeof data === 'string'
      ? new TextEncoder().encode(data)
      : new Uint8Array(data);
  await writable.write(bytes);
  await writable.close();
  opfsVolume.set(normalizedPath, bytes);
}

async function removeOpfsEntry(
  filePath: string,
  options?: {force?: boolean; recursive?: boolean},
): Promise<void> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  const directoryPath =
    separator === 0 ? '/' : normalizedPath.slice(0, separator);
  const name =
    separator === 0
      ? normalizedPath.slice(1)
      : normalizedPath.slice(separator + 1);
  try {
    const directory = await getOpfsDirectory(
      await getOpfsRoot(),
      directoryPath,
      false,
    );
    await directory.removeEntry(name, {recursive: options?.recursive ?? false});
    opfsVolume.delete(normalizedPath);
  } catch (error) {
    if (
      options?.force &&
      error instanceof DOMException &&
      error.name === 'NotFoundError'
    ) {
      return;
    }
    throw error;
  }
}

function memoryFileSystemError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
