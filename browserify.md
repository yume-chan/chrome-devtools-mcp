# chrome-devtools-mcp browserify program

# Goals

1. Remove usages of Node.js built-in modules from the browser runtime graph.
2. Keep filesystem-dependent features by using a virtual filesystem for runtime-created files.
3. Access build-folder assets through asynchronous imports or `fetch`.
4. Replace supported Node.js APIs with Web APIs.

# Method

1. Start at src/index.ts
2. For each import, and for the file itself, perform the following steps:
   1. Check if it uses Node.js built-in modules.
   2. If the whole file is for Node.js only, remove it from BUILD.gn and remove
      browser-runtime references to it.
   3. If it does, determine if it can be replaced with a Web API or virtual storage.
   4. Do not remove a feature only because it uses filesystem APIs; use OPFS
      for runtime-created files. Keep features that require other unavailable
      Node.js capabilities out of the browser build.

## Browser compatibility best practices

- Follow the runtime import graph from `src/index.ts`; distinguish runtime
  imports from type-only imports and build/test-only dependencies.
- Prefer standard Web APIs over Node.js globals and shims. Do not add a global
  `Buffer`, `process`, or Node.js module polyfill to make a browser build pass.
- Read immutable build assets with generated imports or `fetch`; use OPFS only
  for runtime-created files and document paths as virtual filesystem paths.
- Keep Node-only setup and packaging scripts outside the browser runtime graph.
- Verify the generated entrypoint and transitive bundle in a real browser;
  TypeScript compilation alone does not establish browser compatibility.
- For each change, list every modified file and state its direct Node.js
  built-in/global use and the behavior changed.

## Progress

The Node column below covers direct built-in imports and Node globals in each
changed file, not its transitive dependencies.

### Build and entry point

- [browserify.md](./browserify.md) — Node: No. Updated the progress record
  with browser-bundle separation, URLPattern changes, and current validation.
- [BUILD.gn](./BUILD.gn) — Node: N/A (GN). Removed test targets from the
  default build group.
- [index.html](./index.html) — Node: No. Added a prototype page that imports
  the generated MCP server module, maps the third-party barrel to the
  browser-specific bundle, maps the MCP SDK shim to its browser
  implementation, routes the Node memory filesystem module to the browser adapter, and
  constructs an MCP server with a real `ServerConfig` instance and a mock CDP
  transport that logs and answers browser-protocol commands. A List pages
  button invokes `mcpServer.callTool('list_pages')`; the MCP protocol row loads
  `@modelcontextprotocol/client` from unpkg.com and connects through paired
  in-memory `Transport` objects to list tools and call `list_pages`. The mock
  reports three sample pages. A local package fallback is used if unpkg.com
  cannot be reached.
- [src/BUILD.gn](./src/BUILD.gn) — Node: N/A (GN). Removed the CLI target and
  excluded daemon, telemetry, heap-snapshot, memory, and screencast sources
  from the MCP library target. Also removed ConfigLocator, ConfigParser,
  ConfigWatcher, the CLI bundle, and the CLI/Config build targets from
  browser-facing targets. The shared third-party bundle template now
  externalizes npm package specifiers across Node and browser bundles while
  leaving `third_party/devtools-frontend` relative imports bundled.
  Performance tools are included again.
- [scripts/copy-issue-descriptions.ts](./scripts/copy-issue-descriptions.ts)
  — Node: Yes (`node:fs`, `node:path`, `process.argv`; build-time only).
  Copies the descriptions and generates `index.js` with their filenames for
  browser-side Markdown imports.

### MCP runtime

- [src/BrowserManager.ts](./src/BrowserManager.ts) — Node: Yes (`process`
  global; also calls Puppeteer's `browser.process()`). Removed local Chrome
  launching, profile/file handling, and OS detection; connection now requires
  `browserUrl`, `wsEndpoint`, or a transport.
- [src/McpContext.ts](./src/McpContext.ts) — Node: No. Removed filesystem
  roots and host-path validation; added memory-file-system-backed file reads, writes, and
  temporary outputs; uses `isDeepStrictEqual` from the shared deep-equality
  utility for option checks. Restored heap-snapshot manager integration and
  all heap tool context methods. Screencast cleanup remains excluded.
- [src/McpPage.ts](./src/McpPage.ts) — Node: No. Removed screencast recorder
  state, accessors, and disposal handling.
- [src/McpResponse.ts](./src/McpResponse.ts) — Node: No. Snapshot and
  network-body outputs can be written through memory-file-system-backed context callbacks.
  Restored heap-snapshot response state, structured fields, formatting, and
  pagination.
- [src/LogpointManager.ts](./src/LogpointManager.ts) — Node: No. Replaced
  `node:vm.Script` syntax validation with the Acorn parser already bundled
  through the third-party entrypoint; expressions are parsed, never run.
- [src/TextSnapshot.ts](./src/TextSnapshot.ts) — Node: No. Made `loaderId`
  explicit and initialized it for extra snapshot nodes.
- [src/ToolHandler.ts](./src/ToolHandler.ts) — Node: No. Removed file-path
  validation, local-browser detection, and telemetry logging; replaced
  `node:url`/`node:util` helpers. Browser tool calls retain the original
  timeout-protected lazy connection initialization before running handlers.
  Replaced the private deep-equality implementation with the shared
  `isDeepStrictEqual` utility.
- [src/processors/HeapSnapshotManager.ts](./src/processors/HeapSnapshotManager.ts)
  — Node: No built-in imports remain. Restored the original snapshot loading,
  caching, filtering, diffing, and disposal logic with normalized virtual
  paths and memory-file-system reads. Heap snapshot worker chunks are decoded into strings
  for the existing loader proxy.
- [src/index.ts](./src/index.ts) — Node: No. Exports the memory volume and
  filesystem for browser-host seeding and access. Removed CLI setup, config
  watching, filesystem roots, telemetry initialization, and the legacy
  `createMcpServer` helper; the server now receives its browser manager.
  Restored shared `HeapSnapshotManager` ownership and disposes it on server
  shutdown.

### Configuration and browser integration

- [src/config/ServerConfig.ts](./src/config/ServerConfig.ts) — Node: No direct
  built-in imports. Uses option descriptors to resolve defaults and a guarded
  environment-based temp-directory default, so the real class can be loaded
  and instantiated in the browser. Uses `isDeepStrictEqual` for non-reloadable
  and resolved option comparisons.
- [src/config/ConfigParser.ts](./src/config/ConfigParser.ts) — Node: Yes
  (`node:fs`, `node:path`). CLI config paths are resolved here rather than in
  the shared option definition.
- [src/config/browser-options.ts](./src/config/browser-options.ts) — Node:
  No. Added `transport`; removed auto-connect, user-data-directory, channel,
  and WebSocket-header options.
- [src/config/mcp-options.ts](./src/config/mcp-options.ts) — Node: No direct
  Node imports. The OS-temp default and config-path resolution moved to
  Node-only config code.
- [src/devtools/issueDescriptions.ts](./src/devtools/issueDescriptions.ts) —
  Node: No. Replaced filesystem enumeration/reads with the generated filename
  manifest; browsers fetch Markdown descriptions while Node uses text imports.
- [src/third_party/index.ts](./src/third_party/index.ts) — Node: No direct
  built-in use. Switched Puppeteer exports to its browser entry point, removed
  unused CLI, browser-installation, and screen-recorder runtime exports, and
  re-exports the shared URLPattern polyfill and Acorn parser without importing
  the Node CLI bundle. It does not import a memfs FSA adapter.
- [src/third_party/cli.ts](./src/third_party/cli.ts) — Node: No direct
  built-in imports. Still exports CLI-only yargs and PipeTransport APIs;
  URLPattern now comes from its shared module instead of being coupled to
  the CLI bundle.
- [src/third_party/urlpattern.ts](./src/third_party/urlpattern.ts) — Node: No.
  Centralized Puppeteer's URLPattern polyfill so browser runtime modules no
  longer load the full CLI bundle for this one API.
- [src/third_party/lighthouse-devtools-mcp-bundle.d.ts](./src/third_party/lighthouse-devtools-mcp-bundle.d.ts)
  — Node: No. Updated the Lighthouse `Page` type to Puppeteer's browser type.

### Tools, formatters, and utilities

- [src/formatters/NetworkFormatter.ts](./src/formatters/NetworkFormatter.ts)
  — Node: No. Replaced `Buffer` decoding with `TextDecoder` and added a
  callback for writing request/response bodies to memory storage.
- [src/formatters/WebAuthnFormatter.ts](./src/formatters/WebAuthnFormatter.ts)
  — Node: No. Replaced `Buffer` base64url conversion with Web API
  `atob`/`btoa` conversion in the shared byte utilities.
- [src/tools/ToolDefinition.ts](./src/tools/ToolDefinition.ts) — Node: No.
  Added virtual-file read/write and temporary-save context APIs and retained
  file-path output fields for snapshots and Lighthouse reports.
- [src/tools/input.ts](./src/tools/input.ts) — Node: No. Added specific
  `ElementHandle` element types for select-option property access.
- [src/tools/lighthouse.ts](./src/tools/lighthouse.ts) — Node: No. Replaced
  `node:path` and host filesystem report writes with memory-backed report
  output.
- [src/tools/memory.ts](./src/tools/memory.ts) — Node: No. Restored the original
  heap snapshot and analysis tool definitions. Heap capture now listens for
  `HeapProfiler.addHeapSnapshotChunk` events over the page CDP session and
  writes the resulting chunks to memory storage instead of passing a host `path`.
- [src/tools/tools.ts](./src/tools/tools.ts) — Node: No. Restored memory tool
  registration in the shared tool factory.
- [src/tools/network.ts](./src/tools/network.ts) — Node: No. Replaced
  host-file mock response reads with memory-file-system reads; upstream mocks remain.
- [src/tools/performance.ts](./src/tools/performance.ts) — Node: No. Replaced
  `node:zlib` with `CompressionStream` and raw-trace memory-file-system output.
- [src/tools/screenshot.ts](./src/tools/screenshot.ts) — Node: No. Replaced
  the `Buffer` global with Web API base64 encoding and writes file/temporary
  outputs to memory storage.
- [src/tools/script.ts](./src/tools/script.ts) — Node: No. Replaced
  `node:url` and host-file access with URL/Web API and memory-file-system handling for
  `sourcePath` and result output.
- [src/tools/slim/tools.ts](./src/tools/slim/tools.ts) — Node: No. Restored
  the slim-mode screenshot tool with memory-file-system-backed file and temporary output.
- [src/tools/snapshot.ts](./src/tools/snapshot.ts) — Node: No. Restored the
  snapshot `filePath` output through memory storage.
- [src/tools/tools.ts](./src/tools/tools.ts) — Node: No. Removed memory and
  screencast tools from tool registration.
- [src/types.ts](./src/types.ts) — Node: No. Made snapshot `loaderId`
  required.
- [src/utils/disclaimers.ts](./src/utils/disclaimers.ts) — Node: No. Removed
  the usage-statistics opt-out disclaimer.
- [src/utils/logger.ts](./src/utils/logger.ts) — Node: No. Removed `node:fs`
  and `node:util`, file logging, and `debuglog`; logging now uses
  `console.log`.
- [src/utils/errorHandling.ts](./src/utils/errorHandling.ts) — Node: No.
  Kept error conversion helpers browser-safe; moved the process-level
  unhandled-rejection listener to a Node-only module.
- [src/utils/deepEqual.ts](./src/utils/deepEqual.ts) — Node: No. Shares deep
  equality checks between configuration merging and context/tool option
  changes. The export is named `isDeepStrictEqual`; McpContext,
  ServerConfig, and ToolHandler import that shared browser-safe implementation.
- [src/utils/unhandledRejection.ts](./src/utils/unhandledRejection.ts) —
  Node: Yes (`node:process`). Holds the process-only rejection handler used
  by the Node server and daemon entry points.
- [src/utils/network.ts](./src/utils/network.ts) — Node: No. Uses URLPattern
  from the shared browser-safe third-party entrypoint for network-mock URL
  validation.
- [src/utils/url.ts](./src/utils/url.ts) — Node: No. Removed `node:os` and
  local network-interface lookup; local endpoint detection now checks the
  unspecified-host addresses. URLPattern validation no longer imports the
  CLI bundle.
- [src/NetworkOverrideManager.ts](./src/NetworkOverrideManager.ts) — Node:
  No. Replaced `node:path` extension lookup with string-based handling and
  now imports URLPattern from the shared browser-safe third-party entrypoint.
- [src/utils/bytes.ts](./src/utils/bytes.ts) — Node: No. Added Web API
  base64 encoding for screenshots and base64url conversion for WebAuthn IDs.
- [src/utils/memory-file-system.ts](./src/utils/memory-file-system.ts) — Node: No
  direct built-in use. Provides shared virtual paths and an in-memory Map-backed
  filesystem for Node runtime-created files.
- [src/utils/memory-file-system-browser.ts](./src/utils/memory-file-system-browser.ts)
  — Node: No. Uses the Origin Private File System for browser runtime-created
  files, with a Map fallback when OPFS is unavailable.
- [src/utils/memory-file-system-common.ts](./src/utils/memory-file-system-common.ts)
  — Node: No. Shares virtual-path normalization, file URL conversion, and unique
  temporary path generation between the Node and browser filesystem adapters.
- [src/bin/chrome-devtools-mcp-main.ts](./src/bin/chrome-devtools-mcp-main.ts)
  — Node: Yes (`node:process`; Node entry point). Imports the rejection
  handler from its Node-only module.
- [src/daemon/daemon.ts](./src/daemon/daemon.ts) — Node: Yes (`node:fs`,
  `node:net`, `node:os`, `node:path`, `node:process`; Node-only daemon).
  Imports the separated rejection handler.
- [package.json](./package.json) and [package-lock.json](./package-lock.json)
  — Removed memfs and its transitive dependencies.
- [tests/utils/bytes.test.ts](./tests/utils/bytes.test.ts) and
  [tests/utils/files.test.ts](./tests/utils/files.test.ts) — Added focused
  tests for Web API base64 encoding and memory path/read/write behavior.
- [tests/utils/errorHandling.test.ts](./tests/utils/errorHandling.test.ts),
  [tests/config/ServerConfig.test.ts](./tests/config/ServerConfig.test.ts),
  and [tests/cli.test.ts](./tests/cli.test.ts) — Updated imports for the
  moved handler and filesystem-root default; existing CLI coverage verifies
  relative config paths still resolve.
- [tests/LogpointManager.test.ts](./tests/LogpointManager.test.ts) — Added a
  case rejecting statement injection in a logpoint expression.
- [tests/utils/files.test.ts](./tests/utils/files.test.ts) — Added coverage
  for browser-adapter reads, writes, nested directories, and cleanup.
- [src/BUILD.gn](./src/BUILD.gn) — Node: N/A (GN). Added a separate browser
  third-party bundle, externalized its MCP SDK browser shim and unused
  Puppeteer browser-channel dependencies, and included shared URLPattern,
  filesystem adapter, and deep-equality modules in the TypeScript target.

## Remaining

- The page is still a browser prototype, not a supported browser-hosted MCP
  product. The page constructs a `McpServer`; raw and protocol-level
  `list_pages` calls return its three sample pages. The shared browser could
  not reach unpkg.com and used the local client package fallback. Other browser
  tools and their required CDP behavior still need validation.
- The browser entry uses the OPFS-backed adapter. The browser import map
  selects that adapter instead of the Node Map-backed implementation; no
  Node.js module polyfill was added.
- The mock CDP transport provides discovery and attachment events for three
  sample pages, target info, browser version, and the observed selected-page
  setup commands. Unsupported commands return an explicit protocol error;
  DevTools-specific target attachment is not implemented.
- Node.js built-ins remain in the Node-only files marked Yes above. Continue
  checking the browser graph as functionality is restored.
- Heap-snapshot capture and analysis are restored, but real browser capture
  still needs validation against live `HeapProfiler` chunk events. Screencast
  remains excluded and should be assessed separately.
- Review and document the behavior intentionally unavailable in the
  browser-hosted build.
- The test target is excluded from the default build, and the remaining tests
  depend on the removed `src:bin` target. The current `npm run test` path
  therefore does not validate these changes; adapt the test build before
  relying on its result.

## Validation

- `npm run format` — passed.
- `npm run build` — passed.
- Heap snapshot build — `npm run build` passed after restoring the memory tool
  registration, manager, context integration, and response formatting.
- Dependency bundle build — `npm run build` passed with npm packages externalized
  in the Node and browser third-party bundles. Metafile checks found no
  `node_modules` inputs: the browser bundle kept 512 DevTools submodule inputs
  bundled.
- Browser — reloaded the generated `src/index.js` graph with the browser
  bundles and memory-file-system adapter import mappings. `globalThis.serverConfig` is a
  `ServerConfig` instance. The raw List pages button and MCP client both
  returned three mock pages; the MCP client connected over the in-memory
  transport pair and listed the available tools. unpkg.com timed out in the
  shared browser, so the local package fallback was exercised. Browser-side
  memory-file-system write/read/recursive-remove smoke test passed.
- `npm run test` — exited successfully, but the script emitted no test results;
  treat it as a build check rather than evidence that the unit tests ran.
- `npm run test tests/utils/files.test.ts` — could not run because
  `out/Default/gen/tests/utils/files.test.js` is not generated by the current
  test build.
- `npm run test tests/ToolHandler.test.ts` — could not run because
  `out/Default/gen/tests/ToolHandler.test.js` is not generated by the current
  test build.
