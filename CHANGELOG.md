# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

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
