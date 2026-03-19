# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog.

## [Unreleased]

### Added

- Power BI workspace and dataset discovery tools
- Dataset metadata support for both Push Dataset tables and `INFO.VIEW` fallback
- DAX query execution, CSV export, and dataset refresh tools
- Fabric semantic model tools for listing, definition retrieval, creation, update, and clone
- MCP example configs for Codex and Gemini
- API reference document in `API.md`

### Changed

- Refined the server toward atomic Power BI / Fabric capabilities for AI clients
- Restricted Fabric long-running operation handling to the official `state -> result` flow

### Security

- Added `.gitignore` protection for `.env`, `node_modules`, and editor state
- Documented secret rotation and publish-time credential hygiene
