/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

let issueDescriptions: Record<string, string> = {};

/**
 * Reads all issue descriptions from the filesystem into memory.
 */
export async function loadIssueDescriptions(): Promise<void> {
  if (Object.keys(issueDescriptions).length > 0) {
    return;
  }

  // @ts-expect-error
  const index = await import('../third_party/issue-descriptions/index.js').then(
    mod => mod.default as Record<string, string>,
  );

  const descriptions: Record<string, string> = {};

  for (const file in index) {
    descriptions[file] = index[file];
  }

  issueDescriptions = descriptions;
}

/**
 * Gets an issue description from the in-memory cache.
 * @param fileName The file name of the issue description.
 * @returns The description of the issue, or null if it doesn't exist.
 */
export function getIssueDescription(fileName: string): string | null {
  return issueDescriptions[fileName] ?? null;
}

export const ISSUE_UTILS: {
  loadIssueDescriptions: () => Promise<void>;
  getIssueDescription: (fileName: string) => string | null;
} = {
  loadIssueDescriptions,
  getIssueDescription,
};
