/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Logger} from '../types.js';

const mcpDebugNamespace = 'mcp:log';

// eslint-disable-next-line no-console
const debugLog = console.log.bind(console, mcpDebugNamespace);

/**
 * Encodes a value for interpolation into a one-line log or error message. The
 * result is a JSON string literal that also escapes DEL, C1 controls and
 * U+2028/U+2029, which JSON.stringify leaves raw but terminals and line
 * readers act on.
 */
export function escapeForLog(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/**
 * Redact credentials from URLs used in connection and diagnostic logs.
 * The URL passed to Puppeteer is never modified.
 */
export function redactUrlForLogging(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    if (url.search) {
      url.search = '?REDACTED';
    }
    return url.toString();
  } catch {
    // Unparseable URLs might still contain credentials. Fail closed.
    return '[REDACTED]';
  }
}

/**
 * Return a redacted copy of the Puppeteer connection options for logging.
 * Keep the actual headers and connection URLs intact for Puppeteer.
 */
export function redactConnectOptionsForLogging<
  T extends {
    headers?: Record<string, string>;
    browserWSEndpoint?: string;
    browserURL?: string;
  },
>(options: T): T {
  return {
    ...options,
    ...(options.headers
      ? {
          headers: Object.fromEntries(
            Object.keys(options.headers).map(name => [name, '[REDACTED]']),
          ),
        }
      : {}),
    ...(options.browserWSEndpoint
      ? {browserWSEndpoint: redactUrlForLogging(options.browserWSEndpoint)}
      : {}),
    ...(options.browserURL
      ? {browserURL: redactUrlForLogging(options.browserURL)}
      : {}),
  };
}

/**
 * Filter sensitive CLI arguments in the daemon startup log only.
 * Spawn still receives the original arguments unchanged.
 */
export function redactDaemonArgsForLogging(args: readonly string[]): string[] {
  const headersFlag = /^--ws-?headers$/i;
  const endpointFlag = /^--(?:ws-?endpoint|browser-?url)$/i;
  return args.map((arg, index) => {
    const previous = args[index - 1] ?? '';
    if (headersFlag.test(previous)) {
      return '[REDACTED]';
    }
    if (endpointFlag.test(previous)) {
      return redactUrlForLogging(arg);
    }
    const equalsAt = arg.indexOf('=');
    if (equalsAt === -1) {
      return arg;
    }
    const flag = arg.slice(0, equalsAt);
    const value = arg.slice(equalsAt + 1);
    if (headersFlag.test(flag)) {
      return `${flag}=[REDACTED]`;
    }
    if (endpointFlag.test(flag)) {
      return `${flag}=${redactUrlForLogging(value)}`;
    }
    return arg;
  });
}

export const logger: Logger = (...args: unknown[]) => {
  debugLog(new Date().toISOString(), ...args);
};

export const puppeteerLogger = (prefix: string): Logger | undefined => {
  // eslint-disable-next-line no-console
  const dbg = console.log.bind(console, prefix);

  return (...args: unknown[]): void => {
    dbg(new Date().toISOString(), ...args);
  };
};
