/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'puppeteer-core/lib/third_party/urlpattern-polyfill/urlpattern-polyfill.js';

/**
 * Node 20 and 22 do not provide URLPattern globally. Importing Puppeteer's
 * polyfill also supports browsers without a native implementation.
 */
export const URLPattern: typeof globalThis.URLPattern = globalThis.URLPattern;
