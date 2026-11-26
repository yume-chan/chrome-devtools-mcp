/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpOptionsFor } from './category-options.js';

export interface BrowserArguments {
  browserUrl?: string;
  wsEndpoint?: string;
}

export type BrowserOptions = McpOptionsFor<BrowserArguments>;

export const browserOptions: BrowserOptions = {
  browserUrl: {
    type: 'string',
    description:
      'Connect to a running, debuggable Chrome instance (e.g. `http://127.0.0.1:9222`). For more details see: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance.',
    alias: 'u',
    coerce: (url: string | undefined): string | undefined => {
      if (!url) {
        return;
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error(`Provided browserUrl ${url} is not valid URL.`);
      }
      // `new URL('localhost:9222')` parses with the scheme `localhost:`, but
      // the browser URL is fetched over HTTP to discover the WebSocket
      // endpoint, so only http: and https: can work.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
          `Provided browserUrl ${url} must use http:// or https:// protocol.`,
        );
      }
      return url;
    },
  },
  wsEndpoint: {
    type: 'string',
    description:
      'WebSocket endpoint to connect to a running Chrome instance (e.g., ws://127.0.0.1:9222/devtools/browser/<id>). Alternative to --browserUrl.',
    alias: 'w',
    coerce: (url: string | undefined): string | undefined => {
      if (!url) {
        return;
      }
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
          throw new Error(
            `Provided wsEndpoint ${url} must use ws:// or wss:// protocol.`,
          );
        }
        return url;
      } catch (error) {
        if ((error as Error).message.includes('ws://')) {
          throw error;
        }
        throw new Error(`Provided wsEndpoint ${url} is not valid URL.`);
      }
    },
  },
};

export function getBrowserOptions(): BrowserOptions {
  return browserOptions;
}
