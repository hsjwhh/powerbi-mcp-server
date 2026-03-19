# MCP Power BI Server

一个面向 AI 客户端的 Power BI MCP Server。

它通过 Power BI REST API 暴露一组稳定、可组合的原子能力，让支持 MCP 的客户端可以自行完成：

- 发现可访问的 workspace 和 dataset
- 读取 semantic model 的 schema
- 生成并执行 DAX 查询
- 导出查询结果
- 触发 dataset 刷新

服务端本身不负责自然语言理解，也不内置查询规划逻辑。推荐的使用方式是让上层 AI 先调用 `describe_dataset` 获取 schema，再自行生成 DAX 并调用 `execute_dax_query`。

## 功能

- `list_datasets`: 列出工作区的数据集（可选 workspace_id）
- `list_workspaces`: 列出当前服务主体可访问的工作区
- `get_dataset_metadata`: 获取数据集元数据（表/列/度量值）
- `describe_dataset`: 返回适合自然语言转 DAX 的紧凑 schema 摘要
- `execute_dax_query`: 执行 DAX 查询
- `refresh_dataset`: 触发数据集刷新
- `export_data`: 执行 DAX 并返回 CSV

## 环境变量

参考 `.env.example`：

- `POWERBI_TENANT_ID`
- `POWERBI_CLIENT_ID`
- `POWERBI_CLIENT_SECRET`
- `POWERBI_SCOPE`（可选，默认 `https://analysis.windows.net/powerbi/api/.default`）
- `POWERBI_USE_SCANNER`（可选，`true` 时启用 Admin Scanner API 获取详细模型元数据）

## 启动

```bash
npm install
npm start
```

## MCP 运行示例

如果你的 MCP host 需要配置：

```json
{
  "command": "node",
  "args": ["/root/github/power-bi/src/index.js"],
  "env": {
    "POWERBI_TENANT_ID": "...",
    "POWERBI_CLIENT_ID": "...",
    "POWERBI_CLIENT_SECRET": "..."
  }
}
```

仓库内也提供了可直接复用的示例配置：

- `mcp.codex.json`
- `mcp.gemini.json`

使用前请把其中的 `/absolute/path/to/power-bi/src/index.js` 改成你的本地绝对路径。

## 注意

- `get_dataset_metadata` 会优先调用 Push Dataset 的 `GET /groups/{groupId}/datasets/{datasetId}/tables`。
- 对普通 semantic model，服务会自动回退到 `INFO.VIEW.TABLES/COLUMNS/MEASURES()` 的 DAX 查询方案。
- 若 `INFO.VIEW` 也不可用，可将 `POWERBI_USE_SCANNER=true` 并确保管理员启用元数据扫描（Admin Scanner API）。
- 这个 MCP 服务只暴露 Power BI 的原子能力；自然语言理解、DAX 生成和结果解释应由接入的 AI 客户端负责。
- 不要提交真实 `.env`。如果你曾在本地使用过真实 `client_secret`，发布前建议轮换该密钥。
