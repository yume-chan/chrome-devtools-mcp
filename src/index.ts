/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BrowserManager} from './BrowserManager.js';
import type {BrowserManagerLike} from './BrowserManager.js';
import {ServerConfig} from './config/ServerConfig.js';
import {loadIssueDescriptions} from './devtools/issueDescriptions.js';
import {McpContext} from './McpContext.js';
import {HeapSnapshotManager} from './processors/HeapSnapshotManager.js';
import {
  type CallToolResult,
  ProtocolError,
  ProtocolErrorCode,
  type RegisteredTool,
  McpServer as SdkMcpServer,
  type Transport,
} from './third_party/index.js';
import {ToolHandler} from './ToolHandler.js';
import type {AnyToolDefinition} from './tools/ToolDefinition.js';
import {createTools} from './tools/tools.js';
import {logCruxDisclaimer} from './utils/disclaimers.js';
import {logger} from './utils/logger.js';
import {TaskRunner} from './utils/TaskRunner.js';
import {VERSION} from './version.js';
import type {Environment} from './utils/memory-file-system-common.js';
import {memoryEnvironment} from './utils/memory-file-system.js';

export {memoryFileSystem, memoryVolume} from './utils/memory-file-system.js';
export {memoryEnvironment} from './utils/memory-file-system.js';
export {
  opfsEnvironment,
  opfsFileSystem,
  opfsVolume,
} from './utils/memory-file-system-browser.js';
export type {
  Environment,
  MemoryFileSystem,
} from './utils/memory-file-system-common.js';

export {BrowserManager, ServerConfig};
export type {BrowserManagerLike};

export interface McpServerOptions {
  browserManager: BrowserManagerLike;
  environment?: Environment;
}

interface ToolEntry {
  handler: ToolHandler;
  registeredTool: RegisteredTool;
}

export class McpServer {
  readonly server: SdkMcpServer;
  #config: ServerConfig;
  #browserManager: BrowserManagerLike;
  #context: McpContext;
  /** Runs every tool call and config reload. */
  #taskRunner = new TaskRunner();
  #heapSnapshotManager: HeapSnapshotManager;

  #tools = new Map<string, ToolEntry>();

  private constructor(config: ServerConfig, options: McpServerOptions) {
    this.#config = config;
    this.#browserManager = options.browserManager;
    const environment = options.environment ?? memoryEnvironment;
    this.#heapSnapshotManager = new HeapSnapshotManager(
      this.#taskRunner,
      environment,
    );

    this.server = new SdkMcpServer(
      {
        name: 'chrome_devtools',
        title: 'Chrome DevTools MCP server',
        version: VERSION,
      },
      {
        capabilities: {logging: {}, tools: {listChanged: true}},
        // Enabling or updating many tools at once sends a single notification.
        debouncedNotificationMethods: ['notifications/tools/list_changed'],
      },
    );

    this.#context = McpContext.create(logger, {
      config: this.#config,
      heapSnapshotManager: this.#heapSnapshotManager,
      taskRunner: this.#taskRunner,
      environment,
      getBrowser: () => this.#browserManager.ensureBrowser(),
    });

    this.server.server.setRequestHandler('logging/setLevel', () => {
      return {};
    });
  }

  async connect(transport: Transport): Promise<void> {
    return await this.server.connect(transport);
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<CallToolResult> {
    const toolHandler = this.#tools.get(name)?.handler;
    if (!toolHandler) {
      return {
        content: [
          {
            type: 'text',
            text: `Tool ${name} not found`,
          },
        ],
        isError: true,
      };
    }
    return await toolHandler.handle(args);
  }

  /**
   * Applies a new config to the running server. Only reloadable options are
   * applied, all other options keep the value the server was started with.
   * Tools are updated in place and only tools whose listing changed notify
   * the client, which results in at most one `tools/list_changed`
   * notification.
   */
  async applyConfig(config: ServerConfig): Promise<void> {
    // Goes ahead of waiting tool calls and waits for running ones, so every
    // waiting call runs with the new config.
    using guard = await this.#taskRunner.pause();
    await this.#applyConfigLocked(this.#config.mergeReloadable(config));
  }

  async #applyConfigLocked(nextConfig: ServerConfig): Promise<void> {
    const previousArgs = this.#config.resolved;
    const nextArgs = nextConfig.resolved;
    // Build everything before committing so that a throwing tool factory
    // leaves the server untouched.
    const updates: Array<{
      entry: ToolEntry;
      tool: AnyToolDefinition;
    }> = [];
    for (const tool of createTools(nextArgs)) {
      const entry = this.#tools.get(tool.name);
      if (entry) {
        updates.push({entry, tool});
      }
    }

    this.#config.commit(nextConfig);
    for (const {entry, tool} of updates) {
      if (entry.handler.update(tool)) {
        entry.registeredTool.update({
          description: tool.description,
          paramsSchema: entry.handler.registeredInputSchema,
          annotations: tool.annotations,
          enabled: !entry.handler.disabled,
        });
      }
    }

    if (!previousArgs.performanceCrux || previousArgs.slim) {
      logCruxDisclaimer(nextArgs);
    }

    await this.#context.onConfigChanged(previousArgs);
  }

  /**
   * Closes the MCP connection and disposes internal context/listeners.
   */
  async close(): Promise<void> {
    try {
      this.#context.dispose();
    } catch (err) {
      logger?.('Failed to dispose context', err);
    }
    this.#heapSnapshotManager.dispose();
    await Promise.allSettled([
      this.#browserManager.close(),
      this.server.close(),
    ]);
  }

  [Symbol.dispose](): void {
    this.close().catch(err => {
      logger?.('Failed to dispose McpServer', err);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  static async from(
    config: ServerConfig,
    options: McpServerOptions,
  ): Promise<McpServer> {
    const server = new McpServer(config, options);
    await server.#init();
    return server;
  }

  async #init(): Promise<void> {
    // Tool definitions take a ParsedArguments snapshot; reload recreates them.
    for (const tool of createTools(this.#config.resolved)) {
      this.#registerTool(tool);
    }
    this.#setToolCallRequestHandler();
    await loadIssueDescriptions();
  }

  async #getContext(): Promise<McpContext> {
    return this.#context;
  }

  #createToolHandler(tool: AnyToolDefinition): ToolHandler {
    return new ToolHandler(
      tool,
      this.#config,
      () => this.#getContext(),
      () => this.#browserManager.abandonPendingAttempt(),
    );
  }

  /**
   * Overrides the SDK's `tools/call` handler so enabled and input-schema
   * checks run inside `ToolHandler.handle()` inside the task runner.
   */
  #setToolCallRequestHandler(): void {
    this.server.server.setRequestHandler('tools/call', async (request, ctx) => {
      const entry = this.#tools.get(request.params.name);
      if (!entry) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Tool ${request.params.name} not found`,
        );
      }
      const result = await entry.handler.handle(request.params.arguments, {
        viaMcp: true,
        signal: ctx.mcpReq.signal,
      });
      return this.server.server.projectCallToolResult(result, undefined);
    });
  }

  #registerTool(tool: AnyToolDefinition): void {
    const handler = this.#createToolHandler(tool);

    const registeredTool = this.server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: handler.registeredInputSchema,
        annotations: tool.annotations,
      },
      args => handler.handle(args),
    );

    if (handler.disabled) {
      registeredTool.disable();
    }

    this.#tools.set(tool.name, {handler, registeredTool});
  }
}
