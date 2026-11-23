/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createFsFromVolume, Volume, type IFs} from 'memfs';
import {
  getMemoryTempFilePath,
  normalizeMemoryFileUrl,
  normalizeMemoryPath,
} from './memfs-common.js';

export const memoryVolume: Volume = new Volume();
export const memoryFileSystem: IFs = createFsFromVolume(memoryVolume);

export {getMemoryTempFilePath, normalizeMemoryFileUrl, normalizeMemoryPath};

export async function readMemoryFile(filePath: string): Promise<Uint8Array> {
  const contents = await memoryFileSystem.promises.readFile(
    normalizeMemoryPath(filePath),
  );
  return typeof contents === 'string'
    ? new TextEncoder().encode(contents)
    : new Uint8Array(contents);
}

export async function writeMemoryFile(
  filePath: string,
  data: Uint8Array,
): Promise<string> {
  const normalizedPath = normalizeMemoryPath(filePath);
  const separator = normalizedPath.lastIndexOf('/');
  const parentPath = separator === 0 ? '/' : normalizedPath.slice(0, separator);
  await memoryFileSystem.promises.mkdir(parentPath, {recursive: true});
  await memoryFileSystem.promises.writeFile(normalizedPath, data);
  return normalizedPath;
}
