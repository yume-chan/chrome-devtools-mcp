/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ReadonlyServerConfig} from './config/ServerConfig.js';
import {Mutex, puppeteer, type Browser} from './third_party/index.js';
import {
  logger,
  puppeteerLogger,
  redactConnectOptionsForLogging,
} from './utils/logger.js';
import {isAllowedUrl} from './utils/url.js';

/**
 * Identity token for an in-flight connect/launch attempt. Instances carry no
 * data and are never inspected structurally — only ever compared by
 * reference (`!==`) — see BrowserManager#abandonPendingAttempt().
 */
class BrowserAttempt {}

export class BrowserManager {
  #browser?: Browser;
  #browserMode?: 'launched' | 'connected';
  #initPromise?: Promise<Browser>;
  #mutex = new Mutex();
  #closingCount = 0;
  #config: ReadonlyServerConfig;

  #browserAttempt: BrowserAttempt = new BrowserAttempt();

  constructor(config: ReadonlyServerConfig) {
    this.#config = config;
  }

  static makeTargetFilter(enableExtensions = false) {
    return function targetFilter(target: {url(): string}): boolean {
      const url = target.url();
      if (!url) {
        return true;
      }
      return isAllowedUrl(url, {categoryExtensions: enableExtensions});
    };
  }

  /**
   * Chrome refuses to start as root unless the sandbox is explicitly disabled and
   * only says so on its stderr. Because we launch with `pipe: true`, Puppeteer
   * never surfaces that stderr and the failure reaches the client as an opaque
   * `Protocol error (Target.setDiscoverTargets): Target closed`. Detect the
   * situation and explain the way out instead. See https://crbug.com/638180.
   *
   * Returns `undefined` when the failure cannot be explained by running as root,
   * including on platforms without uids and when the sandbox was already disabled
   * through `--chrome-arg` (in which case root is not what stopped Chrome).
   */
  static rootSandboxLaunchError(
    error: Error,
    args: readonly string[],
    uid: number | undefined = process.getuid?.(),
  ): Error | undefined {
    if (uid !== 0) {
      return undefined;
    }
    if (
      args.some(
        arg => arg === '--no-sandbox' || arg.startsWith('--no-sandbox='),
      )
    ) {
      return undefined;
    }
    return new Error(
      `Chrome failed to start: ${error.message}\n\n` +
        'chrome-devtools-mcp is running as root and Chrome does not start as root ' +
        '(https://crbug.com/638180). Run chrome-devtools-mcp as a non-root user; in a ' +
        'container, create an unprivileged user in the image and switch to it with ' +
        "USER. For the setup that Chrome's sandbox needs, see " +
        'https://pptr.dev/troubleshooting#setting-up-chrome-linux-sandbox.',
      {
        cause: error,
      },
    );
  }

  /**
   * Puppeteer reports a headed launch without a display as "Missing X server"
   * and suggests its own `headless` option, which users of this server cannot
   * set directly. Point them to the `--headless` flag instead.
   *
   * Returns `undefined` for headless launches and for unrelated failures.
   */
  static missingDisplayLaunchError(
    error: Error,
    headless: boolean,
  ): Error | undefined {
    if (headless || !error.message.includes('Missing X server')) {
      return undefined;
    }
    return new Error(
      `Chrome failed to start: ${error.message}\n\n` +
        'No X server is available to show a headed Chrome window. Start ' +
        'chrome-devtools-mcp with --headless, set DISPLAY to a running X ' +
        'server, or run chrome-devtools-mcp under xvfb-run.',
      {
        cause: error,
      },
    );
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.#initPromise) {
      return await this.#initPromise;
    }
    const initPromise = this.#ensureBrowserLocked();
    this.#initPromise = initPromise;
    try {
      return await initPromise;
    } finally {
      if (this.#initPromise === initPromise) {
        this.#initPromise = undefined;
      }
    }
  }

  async #ensureBrowserLocked(): Promise<Browser> {
    if (this.#closingCount > 0) {
      throw new Error('Browser was closed while initializing.');
    }
    // Captured before acquiring #mutex, not after: a caller queued here can
    // have its own timeout fire (abandonPendingAttempt()) while it's still
    // waiting for the lock. Capturing only after acquiring it would let such
    // a call silently adopt the freshly-rotated token as its own baseline
    // once the lock frees up, defeating the abandonment check entirely.
    const attempt = this.#browserAttempt;
    using guard = await this.#mutex.acquire();
    if (this.#closingCount > 0) {
      throw new Error('Browser was closed while initializing.');
    }
    if (this.#browserAttempt !== attempt) {
      // Abandoned while queued for the lock — #browser was never touched by
      // this call, so bail immediately without #closeBrowser(), which could
      // otherwise tear down a different, still-current attempt's browser.
      throw new Error('Connection attempt was abandoned before it completed.');
    }
    if (!this.#browser?.connected) {
      await this.#initBrowser();
    }
    if (
      this.#closingCount > 0 ||
      this.#browserAttempt !== attempt ||
      !this.#browser
    ) {
      const reason =
        this.#closingCount > 0
          ? 'Browser was closed while initializing.'
          : 'Connection attempt was abandoned before it completed.';
      await this.#closeBrowser();
      throw new Error(reason);
    }
    return this.#browser;
  }

  /**
   * Signals that whoever was waiting on the in-flight ensureBrowser() call
   * has given up (e.g. a tool-call timeout). There's no way to cancel a
   * pending connect()/launch(), so this doesn't stop it — it rotates the
   * token to a fresh value and clears #initPromise, so a late-resolving
   * attempt gets discarded by #ensureBrowserLocked() instead of silently
   * installed for a caller who already walked away.
   *
   * Also forgets the cached #browser, if any. This only ever fires from a
   * getContext()-level timeout, which covers both ensureBrowser() and the
   * McpContext initialization built on it — if ensureBrowser() already
   * resolved and it's that later step hanging (e.g. a dead CDP transport),
   * the token rotation alone does nothing, since #browser is already
   * cached. Safe to forget unconditionally here: a tool call that already
   * received a Browser keeps using it, so forgetting the cached value only
   * makes the next ensureBrowser() reconnect.
   */
  abandonPendingAttempt(): void {
    this.#browserAttempt = new BrowserAttempt();
    this.#initPromise = undefined;
    this.#forgetCurrentBrowser();
  }

  async #initBrowser(): Promise<Browser> {
    return await this.#connect();
  }

  async #connect(): Promise<Browser> {
    const {
      browserUrl: browserURL,
      wsEndpoint,
      transport,
      idGenerator,
      blockedUrlPattern: blocklist,
      allowedUrlPattern: allowlist,
      categoryExtensions: enableExtensions,
    } = this.#config.resolved;

    const connectOptions: Parameters<typeof puppeteer.connect>[0] = {
      targetFilter: BrowserManager.makeTargetFilter(enableExtensions),
      defaultViewport: null,
      handleDevToolsAsPage: true,
      blocklist,
      allowlist,
      logger: puppeteerLogger,
    };

    if (wsEndpoint) {
      connectOptions.browserWSEndpoint = wsEndpoint;
    } else if (browserURL) {
      connectOptions.browserURL = browserURL;
    } else if (transport) {
      connectOptions.transport = transport;
      if (idGenerator) {
        connectOptions.idGenerator = idGenerator;
      }
    } else {
      throw new Error(
        'Either browserURL, wsEndpoint or transport must be provided',
      );
    }

    logger?.(
      'Connecting Puppeteer to ',
      JSON.stringify(redactConnectOptionsForLogging(connectOptions)),
    );
    try {
      const connected = await puppeteer.connect(connectOptions);
      logger?.('Connected Puppeteer');
      this.#browserMode = 'connected';
      this.#browser = connected;
      connected.once('disconnected', () => this.#evictIfCurrent(connected));
      return connected;
    } catch (err) {
      throw new Error(
        `Could not connect to Chrome. Check if Chrome is running.`,
        {
          cause: err,
        },
      );
    }
  }

  /**
   * Drops the cached browser handle so the next ensureBrowser() call
   * establishes a fresh connection. Only called from abandonPendingAttempt()
   * when a getContext()-level timeout fires after ensureBrowser() already
   * resolved, which means the handle looks connected but its CDP
   * initialization is hanging.
   *
   * Also tears the browser down in the background: closes it if it was
   * launched (so the Chrome subprocess doesn't leak), or disconnects if it
   * was only connected to (so the transport and its listeners don't leak).
   * Puppeteer's connection disposal rejects any in-flight CDP call, so a hung
   * call settles instead of leaking forever.
   */
  #forgetCurrentBrowser(): void {
    const browser = this.#browser;
    if (!browser) {
      return;
    }
    const mode = this.#browserMode;
    this.#browser = undefined;
    this.#browserMode = undefined;
    if (mode === 'launched') {
      void this.#closeLaunchedBrowser(browser);
    } else {
      void browser.disconnect().catch(err => {
        logger?.('Failed to disconnect forgotten browser', err);
      });
    }
  }

  /**
   * Handles a `disconnected` event fired by a browser we hold: clears the
   * cached handle if it's still the current one, so the next ensureBrowser()
   * call reconnects proactively rather than only discovering the staleness
   * lazily on the next call's `!this.#browser?.connected` check. No teardown
   * here — the browser is already disconnected/closed, that's why this
   * fired. The identity guard makes a `disconnected` that fires late on an
   * already-superseded browser a safe no-op.
   */
  #evictIfCurrent(candidate: Browser): void {
    if (this.#browser !== candidate) {
      return;
    }
    this.#browser = undefined;
    this.#browserMode = undefined;
  }

  async #closeLaunchedBrowser(browser: Browser): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        browser.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out closing browser')),
            5_000,
          );
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      logger?.('Failed to close browser', err);
      browser.process()?.kill('SIGKILL');
    } finally {
      clearTimeout(timer);
    }
  }

  async #closeBrowser(): Promise<void> {
    const browser = this.#browser;
    const mode = this.#browserMode;
    this.#browser = undefined;
    this.#browserMode = undefined;
    if (!browser || !browser.connected) {
      return;
    }
    if (mode === 'launched') {
      await this.#closeLaunchedBrowser(browser);
      return;
    }
    await browser.disconnect().catch(err => {
      logger?.('Failed to disconnect from browser', err);
    });
  }

  /**
   * Shutdown hook for the active browser. Closes a launched browser (so the
   * Chrome subprocess is reaped) or disconnects from an attached browser (so
   * the user's Chrome instance stays alive). No-op if no browser is active or
   * the connection has already been dropped.
   */
  async close(): Promise<void> {
    this.#initPromise = undefined;
    this.#closingCount++;
    using guard = await this.#mutex.acquire();
    try {
      await this.#closeBrowser();
    } finally {
      this.#closingCount--;
    }
  }

  [Symbol.dispose](): void {
    this.close().catch(err => {
      logger?.('Failed to dispose BrowserManager', err);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
