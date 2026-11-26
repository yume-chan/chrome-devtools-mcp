/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'core-js/modules/es.promise.with-resolvers.js';
import 'core-js/modules/es.set.union.v2.js';
import 'core-js/proposals/iterator-helpers.js';

import type {Flags, OutputMode, Result, RunnerResult} from 'lighthouse';

// eslint-disable-next-line no-restricted-imports
import * as DevToolsRoot from '../../third_party/devtools-frontend/front_end/core/root/root.js';

import * as zod from './zod.js';

export type {Flags, Result, RunnerResult, OutputMode};

export type {YargsOptions, InferredOptionTypes} from './cli.js';
export {URLPattern} from './urlpattern.js';
// eslint-disable-next-line no-restricted-imports
export {parse as parseJavaScript} from '../../third_party/devtools-frontend/front_end/third_party/acorn/acorn.js';
export {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type RegisteredTool,
} from '@modelcontextprotocol/server';
export type {Transport} from '@modelcontextprotocol/server';
export {
  type CallToolResult,
  type ImageContent,
  type TextContent,
  type Tool,
  type Root,
} from '@modelcontextprotocol/server';
export {
  SetLevelRequestSchema,
  ListRootsRequestSchema,
  RootsListChangedNotificationSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/core';
export {zod};
export type ShapeOutput<T extends zod.ZodRawShape> = zod.output<
  zod.ZodObject<T>
>;

export {default as ajv} from 'ajv';
export {
  Accessibility,
  ConsoleMessage,
  Dialog,
  ElementHandle,
  Frame,
  Locator,
  PredefinedNetworkConditions,
  CDPSession,
  CDPSessionEvent,
  Connection,
  Target,
  TargetType,
  TimeoutError,
  Tracing,
  WebWorker,
  WebMCP,
  WebMCPTool,
} from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';
export {default as puppeteer} from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';
export type * from 'puppeteer-core/lib/puppeteer/puppeteer-core-browser.js';
export {CdpBrowser} from 'puppeteer-core/internal/cdp/Browser.js';
export {CdpFrame} from 'puppeteer-core/internal/cdp/Frame.js';
export {CdpHTTPRequest} from 'puppeteer-core/internal/cdp/HTTPRequest.js';
export {CdpJSHandle} from 'puppeteer-core/internal/cdp/JSHandle.js';
export {CdpPage} from 'puppeteer-core/internal/cdp/Page.js';
export {CdpExtension} from 'puppeteer-core/internal/cdp/Extension.js';
export {CdpMouse} from 'puppeteer-core/internal/cdp/Input.js';
export type {CdpWebWorker} from 'puppeteer-core/internal/cdp/WebWorker.js';
export type {Realm} from 'puppeteer-core/internal/api/Realm.js';
export {FrameEvent} from 'puppeteer-core/internal/api/Frame.js';
export type {JSONSchema7, JSONSchema7Definition} from 'json-schema';
export {Mutex} from 'puppeteer-core/internal/util/Mutex.js';
export {Deferred} from 'puppeteer-core/internal/util/Deferred.js';
export {
  DisposableStack,
  AsyncDisposableStack,
  SuppressedError,
} from 'puppeteer-core/internal/util/disposable.js';
export async function getToonEncode(): Promise<(val: unknown) => string> {
  const {encode} = await import('@toon-format/toon');
  return encode;
}
export async function getGcfEncode(): Promise<(val: unknown) => string> {
  const {encodeGeneric} = await import('@blackwell-systems/gcf');
  return encodeGeneric;
}

DevToolsRoot.Runtime.experiments.register({
  name: DevToolsRoot.ExperimentNames.ExperimentName.INSTRUMENTATION_BREAKPOINTS,
  title: 'Instrumentation breakpoints',
  aboutFlag: 'devtools-instrumentation-breakpoints',
  isEnabled: false,
  requiresChromeRestart: false,
});

export * as DevTools from '../../third_party/devtools-frontend/mcp/mcp.js';
