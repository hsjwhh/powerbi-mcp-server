# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [0.1.1] - 2026-03-19

### Fixed

- **DAX Query Truncation**: Added detection for `results[0].error` and `tables[0].error` in `execute_dax_query` and `export_data` tools.
- **Shared Capacity Refresh**: Fixed `refresh_dataset` body to support `notifyOption` (required for Shared capacity).
- **Metadata Reliability**: Implemented case-insensitive field matching for `INFO.VIEW` results.
- **Rate Limiting**: Added HTTP 429 `Retry-After` handling with automatic retries in `apiFetch`.
- **Concurrent Token Refresh**: Implemented a Promise-based lock in `getToken` to prevent redundant OAuth2 requests.
- **Robust Error Handling**: Switched from fragile string matching to HTTP status code checks (400/401/404) for metadata fallbacks.

### Added

- **`update_semantic_model`**: Tool to update model name and description.
- **`bind_semantic_model_connection`**: Tool to bind models to data connections (crucial for cross-workspace clones).
- **`scan_workspace_metadata`**: Exposed the Admin Scanner API as a tool for deep workspace auditing.
- **Concurrency & Isolation**: Refactored `listDatasetsAllGroups` to use `Promise.allSettled` for faster, isolated workspace traversal.

### Changed

- Unified all internal comments to English.
- Refactored `PowerBIClient` to use constructor-initialized credentials, reducing redundant environment lookups.
- Improved tool descriptions with official API limits and usage warnings.

## [0.1.0] - 2026-03-19

### Added

- Power BI workspace and dataset discovery tools (`list_workspaces`, `list_datasets`)
- Dataset metadata support via Push Dataset API and `INFO.VIEW` DAX fallback (`get_dataset_metadata`, `describe_dataset`)
- DAX query execution and CSV export (`execute_dax_query`, `export_data`)
- Dataset refresh support (`refresh_dataset`)
- **Fabric Semantic Model REST API (V1)** support:
  - `list_semantic_models`: List models in a Fabric workspace
  - `get_semantic_model_definition`: Retrieve TMDL/TMSL definitions
  - `create_semantic_model`: Create models from definitions
  - `update_semantic_model_definition`: Update model schema/metadata
  - `clone_semantic_model_to_new`: Clone models across workspaces
- Robust Long-Running Operation (LRO) polling for Fabric asynchronous APIs
- Multi-scope OAuth2 token management (Power BI & Fabric)
- MCP example configs for Codex and Gemini
- API reference document in `API.md`

### Changed

- **Breaking Change**: Migrated to `@modelcontextprotocol/sdk` **v1.0.0+**
  - Refactored server to use `setRequestHandler` for `ListToolsRequestSchema` and `CallToolRequestSchema`
  - Replaced deprecated `server.registerTool` with standard request-response handlers
- Refined the server toward atomic Power BI / Fabric capabilities for AI clients
- Restricted Fabric long-running operation handling to the official `state -> result` flow
- Improved API reliability with `fetchWithTimeout` and enhanced error handling

### Security

- Added `.gitignore` protection for `.env`, `node_modules`, and editor state
- Documented secret rotation and publish-time credential hygiene
