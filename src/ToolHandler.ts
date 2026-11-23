/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {categoryToFlagName} from './config/category-options.js';
import type {ParsedArguments} from './config/mcp-options.js';
import type {ReadonlyServerConfig} from './config/ServerConfig.js';
import type {McpContext} from './McpContext.js';
import type {McpPage} from './McpPage.js';
import {McpResponse, type DataFormat} from './McpResponse.js';
import {SlimMcpResponse} from './SlimMcpResponse.js';
import {
  DisposableStack,
  ProtocolError,
  ProtocolErrorCode,
  zod,
  type CallToolResult,
} from './third_party/index.js';
import {labels} from './tools/categories.js';
import {
  isAvailableInMode,
  isBrowserlessTool,
  isPageScopedTool,
  isSlimTool,
  type AnyToolDefinition,
  type BrowserlessToolDefinition,
  type DefinedPageTool,
  type DevToolsData,
  type ToolDefinition,
} from './tools/ToolDefinition.js';
import {getErrorMessage, toError} from './utils/errorHandling.js';
import {logger} from './utils/logger.js';
import {raceWithSignal} from './utils/raceWithSignal.js';
import type {TaskQueue} from './utils/TaskRunner.js';

function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return false;
      }
      for (let i = 0; i < a.length; i++) {
        if (!isDeepStrictEqual(a[i], b[i])) {
          return false;
        }
      }
      return true;
    }
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }
    for (const key of aKeys) {
      if (
        !isDeepStrictEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

/**
 * Upper bound on how long a tool call may wait to acquire the browser
 * (connect/launch and McpContext initialization). A connect attempt on a
 * half-open socket can hang without ever failing; this bound turns that into
 * a clear error and abandons the attempt so the next call starts fresh.
 *
 * This does not bound the tool's own work. A slow but valid call (a long
 * `wait_for` timeout, an `evaluate_script` awaiting a slow promise, a
 * Lighthouse audit) must finish on its own terms without the browser being
 * closed underneath it. A transport that dies mid-call is detected by the
 * WebSocket keep-alive configured in BrowserManager#connect(), which rejects
 * the in-flight CDP calls and fires `disconnected`.
 */
export const TOOL_CALL_TIMEOUT_MS = 60_000;

class ToolCallTimeoutError extends Error {}

function buildDisabledMessage(
  toolName: string,
  flag: string,
  categoryLabel?: string,
): string {
  const reason = categoryLabel
    ? `is in category ${categoryLabel} which`
    : `requires ${flag.startsWith('--experimental') ? 'experimental feature' : 'flag'} ${flag} and`;

  return `Tool ${toolName} ${reason} is currently disabled. Enable it by running chrome-devtools start ${flag}=true. For more information check the README.`;
}

function getDisabledReason(
  tool: AnyToolDefinition,
  serverArgs: ParsedArguments,
): string | undefined {
  if (!isAvailableInMode(tool, serverArgs)) {
    return isSlimTool(tool)
      ? `Tool ${tool.name} is only available with --slim.`
      : `Tool ${tool.name} is not available with --slim.`;
  }

  const category = tool.annotations.category;
  if (category) {
    const flag = categoryToFlagName(category);
    if (!serverArgs[flag]) {
      return buildDisabledMessage(tool.name, `--${flag}`, labels[category]);
    }
  }

  for (const condition of tool.annotations.conditions || []) {
    if (!serverArgs[condition]) {
      return buildDisabledMessage(tool.name, `--${condition}`);
    }
  }

  return undefined;
}

function toInputJsonSchema(schema: zod.ZodType): unknown {
  return zod.toJSONSchema(schema, {io: 'input', unrepresentable: 'any'});
}

function formatValidationError(toolName: string, error: zod.ZodError): string {
  const details = error.issues
    .map(
      issue =>
        `${issue.path.length > 0 ? `${issue.path.join('.')}: ` : ''}${issue.message}`,
    )
    .join(', ');
  return `Input validation error: Invalid arguments for tool ${toolName}: ${details}`;
}

function errorResult(text: string): CallToolResult {
  return {
    content: [{type: 'text', text}],
    isError: true,
  };
}

/**
 * The page id a page tool call targets, or `undefined` when the call targets
 * the selected page. `args` can be the raw or the parsed arguments.
 */
function routedPageId(
  tool: AnyToolDefinition,
  serverArgs: ParsedArguments,
  args: Record<string, unknown>,
): number | undefined {
  if (!serverArgs.pageIdRouting || isSlimTool(tool)) {
    return undefined;
  }
  const {pageId} = args;
  return typeof pageId === 'number' && Number.isInteger(pageId)
    ? pageId
    : undefined;
}

export class ToolHandler {
  #tool: AnyToolDefinition;
  #config: ReadonlyServerConfig;
  #registeredInputSchema: zod.ZodObject<zod.ZodRawShape, zod.core.$strict>;
  #disabled = false;
  #disabledReason?: string;

  constructor(
    tool: AnyToolDefinition,
    config: ReadonlyServerConfig,
    private readonly getContext: () => Promise<McpContext>,
    private readonly abandonPendingBrowserAttemptOnTimeout: () => void,
  ) {
    this.#tool = tool;
    this.#config = config;
    this.#registeredInputSchema = zod.object(tool.schema).strict();
    this.#updateStatus(tool);
  }

  get registeredInputSchema(): zod.ZodObject<
    zod.ZodRawShape,
    zod.core.$strict
  > {
    return this.#registeredInputSchema;
  }

  /**
   * Whether the tool is hidden from the client.
   */
  get disabled(): boolean {
    return this.#disabled;
  }

  #updateStatus(tool: AnyToolDefinition): void {
    const serverArgs = this.#config.resolved;
    this.#disabledReason = getDisabledReason(tool, serverArgs);
    this.#disabled =
      Boolean(this.#disabledReason) &&
      (!isAvailableInMode(tool, serverArgs) || !serverArgs.viaCli);
  }

  /**
   * Replaces the tool definition and re-evaluates its status against the
   * current server config. Callers must pause the task runner, so calls that
   * are already waiting run with the new state. Returns true if the tool
   * listing visible to the client changed.
   */
  update(tool: AnyToolDefinition): boolean {
    const previousTool = this.#tool;
    const previousDisabled = this.#disabled;
    const previousInputSchema = this.#registeredInputSchema;
    const nextInputSchema = zod.object(tool.schema).strict();

    this.#tool = tool;
    this.#registeredInputSchema = nextInputSchema;
    this.#updateStatus(tool);

    if (previousDisabled !== this.#disabled) {
      return true;
    }
    if (this.#disabled) {
      return false;
    }

    return (
      previousTool.description !== tool.description ||
      !isDeepStrictEqual(previousTool.annotations, tool.annotations) ||
      !isDeepStrictEqual(
        toInputJsonSchema(previousInputSchema),
        toInputJsonSchema(nextInputSchema),
      )
    );
  }

  /**
   * Races a promise against TOOL_CALL_TIMEOUT_MS and signal abort, calling
   * onTimeout() only if the timer wins, never on abort.
   * The loser of the race is left running — there is no way to
   * cancel a pending connect/launch — but since nothing is left awaiting it,
   * it cannot block subsequent tool calls.
   */
  async #raceWithTimeout<T>(
    promise: Promise<T>,
    onTimeout: () => void,
    signal: AbortSignal,
  ): Promise<T> {
    const timeoutError = new ToolCallTimeoutError(
      `Tool "${this.#tool.name}" timed out after ${TOOL_CALL_TIMEOUT_MS}ms waiting for the browser connection to be established. The connection attempt will be retried automatically on the next tool call.`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(timeoutError), TOOL_CALL_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await raceWithSignal(Promise.race([promise, timeout]), signal);
    } catch (err) {
      if (err === timeoutError) {
        onTimeout();
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  #dataFormat(serverArgs: ParsedArguments): DataFormat {
    // --experimentalDataFormat takes precedence over the legacy
    // --experimentalToonFormat.
    return (
      serverArgs.experimentalDataFormat ??
      (serverArgs.experimentalToonFormat ? 'toon' : 'default')
    );
  }

  /**
   * Browserless tools never establish a browser connection, so they also never
   * wait for one under TOOL_CALL_TIMEOUT_MS.
   */
  async #runBrowserlessTool(
    tool: BrowserlessToolDefinition,
    params: Record<string, unknown>,
    response: McpResponse,
    context: McpContext,
    signal: AbortSignal,
  ): ReturnType<McpResponse['handle']> {
    try {
      signal.throwIfAborted();
      await tool.handler({params}, response, context);
    } catch (err) {
      signal.throwIfAborted();
      response.setError(toError(err));
    }
    signal.throwIfAborted();
    return await response.handle(
      context,
      this.#dataFormat(this.#config.resolved),
    );
  }

  async #runBrowserTool(
    tool: ToolDefinition | DefinedPageTool,
    params: Record<string, unknown>,
    response: McpResponse,
    context: McpContext,
    signal: AbortSignal,
    onTelemetryData: (
      devToolsData: DevToolsData | undefined,
      pageUrl: string | undefined,
    ) => void,
  ): ReturnType<McpResponse['handle']> {
    // ensureBrowser() has no cancellation mechanism, so this timeout only
    // stops us from waiting — the attempt itself keeps running abandoned.
    // abandonPendingBrowserAttemptOnTimeout() tells BrowserManager to
    // discard that attempt if it succeeds later instead of handing it to a
    // subsequent caller — see BrowserManager#abandonPendingAttempt()'s doc
    // comment for the full mechanism.
    await this.#raceWithTimeout(
      context.ensureBrowser(),
      () => this.abandonPendingBrowserAttemptOnTimeout(),
      signal,
    );
    logger?.(`${tool.name} browser: resolved`);
    if (context.consumeReconnectNotice()) {
      response.setReconnectNotice();
    }
    let page: McpPage | undefined;
    try {
      signal.throwIfAborted();
      if (isPageScopedTool(tool)) {
        const pageId = routedPageId(tool, this.#config.resolved, params);
        page =
          pageId !== undefined
            ? context.getPageById(pageId)
            : context.getSelectedMcpPage();
        await page?.init({emulateFocus: true});
        signal.throwIfAborted();
        response.setPage(page);
        // A call that runs beside others can't tell its own errors apart.
        if (tool.concurrency !== 'none') {
          response.includeConsoleErrorsFrom(page);
        }
        if (tool.blockedByDialog) {
          page.throwIfDialogOpen();
        }
        await tool.handler(
          {
            params,
            page,
          },
          response,
          context,
        );
      } else {
        await tool.handler(
          {
            params,
          },
          response,
          context,
        );
      }
    } catch (err) {
      signal.throwIfAborted();
      response.setError(toError(err));
    }
    signal.throwIfAborted();
    const devToolsData = await context.getDevToolsData(page);
    signal.throwIfAborted();
    onTelemetryData(devToolsData, context.getSelectedMcpPageUrl(page));
    return await response.handle(
      context,
      this.#dataFormat(this.#config.resolved),
    );
  }

  /**
   * The queue the call runs on. `'none'` tools run outside the runner.
   * `'page'` tools run on the queue of the page named by `rawArgs.pageId`
   * when page id routing applies; every other call runs on the context
   * queue.
   */
  #queueFor(
    context: McpContext,
    rawArgs: Record<string, unknown>,
  ): TaskQueue | undefined {
    const tool = this.#tool;
    switch (tool.concurrency) {
      case 'none':
        return undefined;
      case 'page': {
        const pageId = routedPageId(tool, this.#config.resolved, rawArgs);
        return pageId !== undefined
          ? context.pageTaskQueue(pageId)
          : context.taskQueue;
      }
      default:
        return context.taskQueue;
    }
  }

  /**
   * Cancellation stops waiting for a result, but running work keeps its queue
   * until it settles, including response processing, to preserve serialization.
   * Operations without cancellation support can keep the queue indefinitely.
   */
  async handle(
    rawArgs: Record<string, unknown> = {},
    options?: {viaMcp?: boolean; signal?: AbortSignal},
  ): Promise<CallToolResult> {
    const signal = options?.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const context = await raceWithSignal(this.getContext(), signal);
    let queueGuard: Disposable | undefined;
    try {
      queueGuard = await this.#queueFor(context, rawArgs)?.scheduleTask(signal);
    } catch (err) {
      signal.throwIfAborted();
      // The queue was disposed while the call waited, e.g. the page closed.
      return errorResult(getErrorMessage(err));
    }
    using guard = new DisposableStack();
    guard.use(queueGuard);
    signal.throwIfAborted();
    if (options?.viaMcp && this.#disabled) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Tool ${this.#tool.name} disabled`,
      );
    }

    if (this.#disabledReason) {
      return errorResult(this.#disabledReason);
    }

    const tool = this.#tool;
    const parseResult = this.#registeredInputSchema.safeParse(rawArgs);
    if (!parseResult.success) {
      return errorResult(formatValidationError(tool.name, parseResult.error));
    }
    const params = parseResult.data;

    try {
      logger?.(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
      const response = isSlimTool(tool)
        ? new SlimMcpResponse(this.#config)
        : new McpResponse(this.#config);
      // The execution owns the queue even when its caller stops waiting.
      const execution = isBrowserlessTool(tool)
        ? this.#runBrowserlessTool(tool, params, response, context, signal)
        : this.#runBrowserTool(
            tool,
            params,
            response,
            context,
            signal,
            () => {},
          );
      const executionGuard = guard.move();
      const completion = execution.finally(() => executionGuard.dispose());
      const {content, structuredContent} = await raceWithSignal(
        completion,
        signal,
      );
      const result: CallToolResult & {
        structuredContent?: Record<string, unknown>;
      } = {
        content,
      };
      if (response.error) {
        result.isError = true;
      }
      if (this.#config.resolved.experimentalStructuredContent) {
        result.structuredContent = structuredContent as Record<string, unknown>;
      }
      return result;
    } catch (err) {
      if (signal.aborted) {
        logger?.(`${tool.name} cancelled:`, signal.reason);
      }
      signal.throwIfAborted();
      logger?.(`${tool.name} error:`, err, err?.stack);
      let errorText =
        err && typeof err === 'object' && 'message' in err
          ? err.message
          : String(err);
      let cause: unknown =
        err && typeof err === 'object' && 'cause' in err
          ? err.cause
          : undefined;
      const seenCauses = new Set<unknown>([err]);
      while (
        cause &&
        typeof cause === 'object' &&
        !seenCauses.has(cause) &&
        'message' in cause &&
        typeof cause.message === 'string'
      ) {
        seenCauses.add(cause);
        errorText += `\nCause: ${cause.message}`;
        cause = 'cause' in cause ? cause.cause : undefined;
      }
      return errorResult(errorText);
    } finally {
      // ignore
    }
  }
}
