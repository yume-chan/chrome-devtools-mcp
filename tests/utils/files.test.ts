/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';
import sinon from 'sinon';

import {getTempFilePath, resolveCanonicalPath} from '../../src/utils/files.js';
import {
  getMemoryTempFilePath,
  memoryFileSystem,
  normalizeMemoryFileUrl,
  normalizeMemoryPath,
  readMemoryFile,
  writeMemoryFile,
} from '../../src/utils/memory-file-system.js';
import {
  memoryFileSystem as browserMemoryFileSystem,
  opfsFileSystem,
  readMemoryFile as readBrowserMemoryFile,
  writeMemoryFile as writeBrowserMemoryFile,
} from '../../src/utils/memory-file-system-browser.js';
import {createDisposableTempFile, createTempDir} from '../utils.js';

async function createSymlinkOrSkip(
  t: it.TestContext,
  target: string,
  symlinkPath: string,
  type?: 'dir' | 'file' | 'junction',
): Promise<boolean> {
  try {
    await fs.symlink(target, symlinkPath, type);
    return true;
  } catch (error) {
    if (
      os.platform() === 'win32' &&
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EPERM' || error.code === 'EACCES')
    ) {
      t.skip('creating symlinks requires additional privileges on Windows');
      return false;
    }
    throw error;
  }
}

describe('resolveCanonicalPath', () => {
  it('should resolve an existing standard file path', async () => {
    using tmpDir = createTempDir('resolve-canonical-test-');
    const canonicalTmpDir = await fs.realpath(tmpDir.path);
    const filePath = path.join(tmpDir.path, 'test.txt');
    await fs.writeFile(filePath, 'hello');

    const resolved = await resolveCanonicalPath(filePath);
    assert.strictEqual(resolved, path.join(canonicalTmpDir, 'test.txt'));
  });

  it('should resolve a non-existent file whose parent directory exists', async () => {
    using tmpDir = createTempDir('resolve-canonical-test-');
    const canonicalTmpDir = await fs.realpath(tmpDir.path);
    const filePath = path.join(tmpDir.path, 'non-existent.txt');

    const resolved = await resolveCanonicalPath(filePath);
    assert.strictEqual(
      resolved,
      path.join(canonicalTmpDir, 'non-existent.txt'),
    );
  });

  it('should resolve a non-existent deeply nested file whose parent directories do not exist', async () => {
    using tmpDir = createTempDir('resolve-canonical-test-');
    const canonicalTmpDir = await fs.realpath(tmpDir.path);
    const filePath = path.join(
      tmpDir.path,
      'nested1',
      'nested2',
      'non-existent.txt',
    );

    const resolved = await resolveCanonicalPath(filePath);
    assert.strictEqual(
      resolved,
      path.join(canonicalTmpDir, 'nested1', 'nested2', 'non-existent.txt'),
    );
  });

  it('should resolve existing files with symlinks in path', async t => {
    using tmpDir = createTempDir('resolve-canonical-test-');
    const targetDir = path.join(tmpDir.path, 'target');
    await fs.mkdir(targetDir);
    const targetFile = path.join(targetDir, 'file.txt');
    await fs.writeFile(targetFile, 'hello');

    const symlinkDir = path.join(tmpDir.path, 'symlink_dir');
    const created = await createSymlinkOrSkip(t, targetDir, symlinkDir, 'dir');
    if (!created) {
      return;
    }

    const filePathWithSymlink = path.join(symlinkDir, 'file.txt');

    const resolved = await resolveCanonicalPath(filePathWithSymlink);
    const canonicalTargetDir = await fs.realpath(targetDir);
    assert.strictEqual(resolved, path.join(canonicalTargetDir, 'file.txt'));
  });

  it('should resolve non-existent files with symlinks in path', async t => {
    using tmpDir = createTempDir('resolve-canonical-test-');
    const targetDir = path.join(tmpDir.path, 'target');
    await fs.mkdir(targetDir);

    const symlinkDir = path.join(tmpDir.path, 'symlink_dir');
    const created = await createSymlinkOrSkip(t, targetDir, symlinkDir, 'dir');
    if (!created) {
      return;
    }

    const filePathWithSymlink = path.join(symlinkDir, 'non-existent.txt');

    const resolved = await resolveCanonicalPath(filePathWithSymlink);
    const canonicalTargetDir = await fs.realpath(targetDir);
    assert.strictEqual(
      resolved,
      path.join(canonicalTargetDir, 'non-existent.txt'),
    );
  });

  it('should resolve dangling symlink at the end of path', async t => {
    using tmpDir = createTempDir('resolve-canonical-test-');
    const canonicalTmpDir = await fs.realpath(tmpDir.path);
    const nonExistentTarget = path.join(tmpDir.path, 'non-existent-target.txt');
    const danglingSymlink = path.join(tmpDir.path, 'dangling-symlink.txt');
    const created = await createSymlinkOrSkip(
      t,
      nonExistentTarget,
      danglingSymlink,
    );
    if (!created) {
      return;
    }

    const resolved = await resolveCanonicalPath(danglingSymlink);
    assert.strictEqual(
      resolved,
      path.join(canonicalTmpDir, 'dangling-symlink.txt'),
    );
  });

  it('should resolve path with a dangling symlink directory in the middle', async t => {
    using tmpDir = createTempDir('resolve-canonical-test-');
    const canonicalTmpDir = await fs.realpath(tmpDir.path);
    const nonExistentTargetDir = path.join(tmpDir.path, 'non-existent-dir');
    const danglingSymlinkDir = path.join(tmpDir.path, 'dangling-dir');
    const created = await createSymlinkOrSkip(
      t,
      nonExistentTargetDir,
      danglingSymlinkDir,
      'dir',
    );
    if (!created) {
      return;
    }

    const filePath = path.join(danglingSymlinkDir, 'file.txt');
    const resolved = await resolveCanonicalPath(filePath);
    assert.strictEqual(
      resolved,
      path.join(canonicalTmpDir, 'dangling-dir', 'file.txt'),
    );
  });
});

describe('getTempFilePath', () => {
  it('keeps the file under the created temp directory', async () => {
    using tempFile = await createDisposableTempFile('shot.png');
    const dir = path.dirname(tempFile.path);
    assert.strictEqual(path.basename(tempFile.path), 'shot.png');
    assert.ok(path.basename(dir).startsWith('chrome-devtools-mcp-'));
    assert.strictEqual(path.relative(dir, tempFile.path), 'shot.png');
  });

  for (const name of ['../escape.png', 'sub/shot.png', '..', '.', '']) {
    it(`rejects "${name}" instead of writing outside the temp directory`, async () => {
      await assert.rejects(getTempFilePath(name), /Invalid temp file name/);
    });
  }
});

describe('memory file helpers', () => {
  it('generates distinct temp directories for repeated filenames', () => {
    const firstPath = getMemoryTempFilePath('shot.png');
    const secondPath = getMemoryTempFilePath('shot.png');

    assert.notStrictEqual(
      firstPath.slice(0, firstPath.lastIndexOf('/')),
      secondPath.slice(0, secondPath.lastIndexOf('/')),
    );
  });

  it('normalizes and stores virtual files', async () => {
    const filePath = `/tests/memory-${Date.now()}/nested\\file.txt`;
    const data = new TextEncoder().encode('virtual file');
    const normalizedPath = normalizeMemoryPath(filePath);

    await writeMemoryFile(filePath, data);
    try {
      assert.deepStrictEqual(await readMemoryFile(normalizedPath), data);
    } finally {
      await memoryFileSystem.rm(
        normalizedPath.slice(0, normalizedPath.lastIndexOf('/')),
        {recursive: true},
      );
    }
  });

  it('rejects paths that escape the virtual filesystem root', () => {
    assert.throws(
      () => normalizeMemoryPath('../../outside.txt'),
      /escapes the memory filesystem/,
    );
  });

  it('decodes file URLs into virtual paths', () => {
    assert.strictEqual(
      normalizeMemoryFileUrl('file:///tmp/a%20b.txt'),
      '/tmp/a b.txt',
    );
  });
});

describe('browser memory file system adapter', () => {
  it('reads and removes files in nested virtual directories', async () => {
    const filePath = `/tests/browser-opfs-${Date.now()}/nested/file.txt`;
    const directoryPath = filePath.slice(0, filePath.lastIndexOf('/'));
    const data = new TextEncoder().encode('browser OPFS file');

    await writeBrowserMemoryFile(filePath, data);
    try {
      assert.deepStrictEqual(await readBrowserMemoryFile(filePath), data);
    } finally {
      await browserMemoryFileSystem.rm(
        directoryPath.slice(0, directoryPath.lastIndexOf('/')),
        {recursive: true},
      );
    }
  });

  it('rejects non-recursive OPFS mkdir when a parent is missing', async () => {
    const getDirectoryHandle = sinon.stub();
    getDirectoryHandle.callsFake(async () => {
      throw new DOMException(
        'The parent directory does not exist.',
        'NotFoundError',
      );
    });
    const root = {getDirectoryHandle};
    const originalStorageDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'storage',
    );
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: async () => root,
      },
    });
    try {
      await assert.rejects(
        opfsFileSystem.mkdir('/missing/child', {recursive: false}),
        (error: unknown) =>
          error instanceof DOMException && error.name === 'NotFoundError',
      );
      sinon.assert.calledOnceWithExactly(getDirectoryHandle, 'missing', {
        create: false,
      });
    } finally {
      if (originalStorageDescriptor) {
        Object.defineProperty(navigator, 'storage', originalStorageDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'storage');
      }
    }
  });

  it('creates all missing directories for recursive OPFS mkdir', async () => {
    const getDirectoryHandle = sinon.stub();
    getDirectoryHandle.resolves({
      getDirectoryHandle,
    });
    const root = {getDirectoryHandle};
    const originalStorageDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'storage',
    );
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        getDirectory: async () => root,
      },
    });
    try {
      await opfsFileSystem.mkdir('/missing/child', {recursive: true});
      sinon.assert.calledTwice(getDirectoryHandle);
      sinon.assert.calledWithExactly(getDirectoryHandle.firstCall, 'missing', {
        create: true,
      });
      sinon.assert.calledWithExactly(getDirectoryHandle.secondCall, 'child', {
        create: true,
      });
    } finally {
      if (originalStorageDescriptor) {
        Object.defineProperty(navigator, 'storage', originalStorageDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'storage');
      }
    }
  });
});
