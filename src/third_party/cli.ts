/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @file Third-party modules for the `chrome-devtools` CLI client.
 *
 * The CLI starts a new process for every command. It must load only the
 * modules it needs, so it does not import `./index.js`. That bundle contains
 * Puppeteer, the MCP SDK and the DevTools frontend and takes about 0.5 s to
 * load. Node-only CLI and config modules import from this file directly.
 *
 * Keep browser-shared APIs in separate modules and re-export only those from
 * `./index.js`.
 */

export type {Options as YargsOptions, InferredOptionTypes} from 'yargs';
export {default as yargs} from 'yargs';
export {hideBin} from 'yargs/helpers';
export {default as semver} from 'semver';
export {PipeTransport} from 'puppeteer-core/internal/node/PipeTransport.js';
export {URLPattern} from './urlpattern.js';
