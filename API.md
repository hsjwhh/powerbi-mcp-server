# API Reference

`mcp-powerbi` 通过 `stdio` 暴露一组 Power BI / Fabric MCP 工具。本文档描述每个工具的用途、输入参数和返回约定。

## 认证与前提

- Power BI REST API 使用 `POWERBI_SCOPE`，默认值为 `https://analysis.windows.net/powerbi/api/.default`
- Fabric REST API 使用 `FABRIC_SCOPE`，默认值为 `https://api.fabric.microsoft.com/.default`
- 需要配置：
  - `POWERBI_TENANT_ID`
  - `POWERBI_CLIENT_ID`
  - `POWERBI_CLIENT_SECRET`

## 工具列表

### `list_workspaces`

列出当前服务主体可访问的 Power BI workspace。

输入：

```json
{}
```

返回：
- Power BI `groups` 列表

### `list_datasets`

列出数据集。若提供 `workspace_id`，则仅返回该 workspace 下的数据集；否则遍历所有可访问 workspace。

输入：

```json
{
  "workspace_id": "optional-uuid"
}
```

返回：
- 当传 `workspace_id` 时，返回该 workspace 下的 dataset 数组
- 否则返回聚合后的 dataset 数组，每项附带 `workspaceId` 与 `workspaceName`

### `list_semantic_models`

列出 Fabric semantic model。

输入：

```json
{
  "workspace_id": "uuid"
}
```

返回：
- Fabric `semanticModels` 列表

### `get_dataset_metadata`

获取 dataset schema。

行为：
- 对 Push Dataset，优先调用 `GET /groups/{groupId}/datasets/{datasetId}/tables`
- 对普通 semantic model，自动回退到 `INFO.VIEW.TABLES()`、`INFO.VIEW.COLUMNS()`、`INFO.VIEW.MEASURES()`
- 若设置 `POWERBI_USE_SCANNER=true`，可进一步回退到 Admin Scanner API

输入：

```json
{
  "workspace_id": "uuid",
  "dataset_id": "uuid"
}
```

返回：

```json
{
  "source": "push_tables | info_view | scanner",
  "data": {}
}
```

### `describe_dataset`

返回适合 AI 生成 DAX 的紧凑 schema 摘要。

输入：

```json
{
  "workspace_id": "uuid",
  "dataset_id": "uuid"
}
```

返回：

```json
{
  "dataset_id": "uuid",
  "tables": [
    {
      "name": "table",
      "storage_mode": "Import"
    }
  ],
  "columns": [
    {
      "table": "table",
      "name": "column",
      "data_type": "Integer",
      "summarize_by": "Sum"
    }
  ],
  "measures": [
    {
      "table": "table",
      "name": "measure",
      "expression": "...",
      "format_string": "..."
    }
  ]
}
```

### `execute_dax_query`

执行 DAX 查询。

输入：

```json
{
  "workspace_id": "uuid",
  "dataset_id": "uuid",
  "query": "EVALUATE ROW(\"Ping\", 1)"
}
```

返回：
- 原始 Power BI Execute Queries 响应

### `export_data`

执行 DAX 查询，并把第一张结果表转换为 CSV 文本。

输入：

```json
{
  "workspace_id": "uuid",
  "dataset_id": "uuid",
  "query": "EVALUATE ..."
}
```

返回：
- CSV 字符串

### `refresh_dataset`

触发 dataset refresh。

输入：

```json
{
  "workspace_id": "uuid",
  "dataset_id": "uuid"
}
```

返回：

```json
{
  "status": "accepted",
  "data": null
}
```

### `get_semantic_model_definition`

获取 Fabric semantic model definition。

输入：

```json
{
  "workspace_id": "uuid",
  "semantic_model_id": "uuid",
  "format": "optional TMSL or TMDL"
}
```

返回：
- 官方 Fabric definition 响应，通常包含：
  - `definition.format`
  - `definition.parts[]`

说明：
- `parts[].payload` 为 `InlineBase64`
- 常见 part 包括 `model.bim`、`definition.pbism`、`.platform`

### `create_semantic_model`

基于 definition 创建 Fabric semantic model。

输入：

```json
{
  "workspace_id": "uuid",
  "display_name": "new model name",
  "description": "optional",
  "definition": {
    "parts": [
      {
        "path": "model.bim",
        "payload": "base64",
        "payloadType": "InlineBase64"
      }
    ]
  }
}
```

返回：
- 官方 Fabric 创建响应
- 若该 API 触发长任务，则按官方 `operation state -> operation result` 流程返回

要求：
- 目标 workspace 至少 `Contributor`
- 服务主体具备适当 Fabric API 写权限

### `update_semantic_model_definition`

更新 semantic model definition。

输入：

```json
{
  "workspace_id": "uuid",
  "semantic_model_id": "uuid",
  "update_metadata": true,
  "definition": {
    "parts": [
      {
        "path": "model.bim",
        "payload": "base64",
        "payloadType": "InlineBase64"
      }
    ]
  }
}
```

返回：
- 官方 Fabric 更新响应

### `clone_semantic_model_to_new`

通过复用现有 model definition 克隆出一个新 semantic model。

输入：

```json
{
  "source_workspace_id": "uuid",
  "source_semantic_model_id": "uuid",
  "new_display_name": "clone name",
  "target_workspace_id": "optional uuid",
  "new_description": "optional",
  "format": "optional TMSL or TMDL"
}
```

行为：
- 先调用 `get_semantic_model_definition`
- 再调用 `create_semantic_model`

返回：

```json
{
  "source_workspace_id": "uuid",
  "source_semantic_model_id": "uuid",
  "target_workspace_id": "uuid",
  "new_display_name": "clone name",
  "created": {}
}
```

## Fabric LRO

对于 Fabric SemanticModel API 的长任务，本项目遵循官方流程：

1. 接收 `202 Accepted`
2. 读取 `Location`、`x-ms-operation-id`、`Retry-After`
3. 轮询 operation state
4. `Succeeded` 后请求 operation result

项目不会再做非官方的资源回查兜底。
