/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const [srcDir, destDir, stampFile] = process.argv.slice(2);
if (!srcDir || !destDir || !stampFile) {
  throw new Error(
    'Usage: node copy-issue-descriptions.ts <srcDir> <destDir> <stampFile>',
  );
}

mkdirSync(destDir, {recursive: true});

const contents: Record<string, string> = {};
for (const fileName of readdirSync(srcDir)) {
  const content = readFileSync(path.resolve(srcDir, fileName), 'utf-8');
  contents[fileName] = content;
}

writeFileSync(
  path.resolve(destDir, 'index.js'),
  `export default ${JSON.stringify(contents, undefined, 2)};`,
);
writeFileSync(stampFile, '');
