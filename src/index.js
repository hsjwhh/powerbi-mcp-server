import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { PowerBIClient, normalizeExecuteQueryRows, toCsv } from "./powerbi.js";

const client = new PowerBIClient();

const server = new Server(
  {
    name: "mcp-powerbi",
    version: "0.1.2",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Tool definitions following MCP standards.
 */
const TOOLS = [
  {
    name: "list_workspaces",
    description: "List workspaces accessible to the configured service principal.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "list_semantic_models",
    description: "List Fabric semantic models in a workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
      },
      required: ["workspace_id"],
    },
  },
  {
    name: "list_datasets",
    description: "List datasets across all workspaces using legacy API.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid", description: "Optional workspace filter" },
      },
    },
  },
  {
    name: "get_dataset_metadata",
    description: "Get dataset schema (tables, columns, measures). Uses Push API or INFO.VIEW fallback. Note: INFO functions might not be supported in all environments.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        dataset_id: { type: "string", format: "uuid" },
      },
      required: ["workspace_id", "dataset_id"],
    },
  },
  {
    name: "describe_dataset",
    description: "Return a compact dataset summary optimized for natural-language-to-DAX. Relies on INFO.VIEW functions.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        dataset_id: { type: "string", format: "uuid" },
      },
      required: ["workspace_id", "dataset_id"],
    },
  },
  {
    name: "get_semantic_model_definition",
    description: "Get a Fabric semantic model definition (TMDL/TMSL). TMDL format is recommended for AI readability.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        semantic_model_id: { type: "string", format: "uuid" },
        format: { type: "string", enum: ["TMSL", "TMDL"], default: "TMDL" },
      },
      required: ["workspace_id", "semantic_model_id"],
    },
  },
  {
    name: "create_semantic_model",
    description: "Create a Fabric semantic model from a supplied definition.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        display_name: { type: "string" },
        description: { type: "string" },
        definition: {
          type: "object",
          properties: {
            parts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  payload: { type: "string", description: "Base64 encoded content" },
                  payloadType: { type: "string", enum: ["InlineBase64"], default: "InlineBase64" },
                },
                required: ["path", "payload"],
              },
            },
          },
          required: ["parts"],
        },
      },
      required: ["workspace_id", "display_name", "definition"],
    },
  },
  {
    name: "update_semantic_model",
    description: "Update Fabric semantic model properties (display name or description).",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        semantic_model_id: { type: "string", format: "uuid" },
        display_name: { type: "string" },
        description: { type: "string" }
      },
      required: ["workspace_id", "semantic_model_id"]
    }
  },
  {
    name: "update_semantic_model_definition",
    description: "Update a Fabric semantic model definition (schema/TMDL).",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        semantic_model_id: { type: "string", format: "uuid" },
        update_metadata: { type: "boolean", default: false },
        definition: {
          type: "object",
          properties: {
            parts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  path: { type: "string" },
                  payload: { type: "string", description: "Base64 encoded content" },
                  payloadType: { type: "string", enum: ["InlineBase64"] },
                },
                required: ["path", "payload"],
              },
            },
          },
          required: ["parts"],
        },
      },
      required: ["workspace_id", "semantic_model_id", "definition"],
    },
  },
  {
    name: "clone_semantic_model_to_new",
    description: "Clone an existing semantic model. If target_workspace_id is omitted, clones to the source workspace. Note: Connection binding may be required after cloning.",
    inputSchema: {
      type: "object",
      properties: {
        source_workspace_id: { type: "string", format: "uuid" },
        source_semantic_model_id: { type: "string", format: "uuid" },
        new_display_name: { type: "string" },
        target_workspace_id: { type: "string", format: "uuid" },
        new_description: { type: "string" },
        format: { type: "string", enum: ["TMSL", "TMDL"], default: "TMDL" },
      },
      required: ["source_workspace_id", "source_semantic_model_id", "new_display_name"],
    },
  },
  {
    name: "bind_semantic_model_connection",
    description: "Bind a semantic model to a data connection. Required for cross-workspace clones. Path based on Fabric items connection pattern.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        semantic_model_id: { type: "string", format: "uuid" },
        connection_id: { type: "string", format: "uuid" }
      },
      required: ["workspace_id", "semantic_model_id", "connection_id"]
    }
  },
  {
    name: "execute_dax_query",
    description: "Execute a DAX query against a dataset. Limits: 100k rows or 15MB.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        dataset_id: { type: "string", format: "uuid" },
        query: { type: "string" },
      },
      required: ["workspace_id", "dataset_id", "query"],
    },
  },
  {
    name: "refresh_dataset",
    description: "Trigger a dataset refresh. notify_option is required for Shared capacity.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        dataset_id: { type: "string", format: "uuid" },
        notify_option: { 
          type: "string", 
          enum: ["NoNotification", "MailOnFailure", "MailOnCompletion"],
          default: "NoNotification"
        }
      },
      required: ["workspace_id", "dataset_id"],
    },
  },
  {
    name: "export_data",
    description: "Execute a DAX query and return results as CSV. Note: API limits results to 100,000 rows or 15MB.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" },
        dataset_id: { type: "string", format: "uuid" },
        query: { type: "string" },
      },
      required: ["workspace_id", "dataset_id", "query"],
    },
  },
  {
    name: "scan_workspace_metadata",
    description: "Deep scan workspace metadata using Admin Scanner API. Requires POWERBI_USE_SCANNER=true and tenant admin permissions.",
    inputSchema: {
      type: "object",
      properties: {
        workspace_id: { type: "string", format: "uuid" }
      },
      required: ["workspace_id"]
    }
  }
];

/**
 * Helper to check for truncation or query errors in executeQueries response.
 */
function checkQueryErrors(result) {
  const warnings = [];
  const queryResult = result?.results?.[0];
  const tableResult = queryResult?.tables?.[0];

  if (queryResult?.error) {
    warnings.push(`Query Warning: ${JSON.stringify(queryResult.error)}`);
  }
  if (tableResult?.error) {
    warnings.push(`Table Warning: ${JSON.stringify(tableResult.error)}`);
  }
  return warnings;
}

/**
 * Register ListTools handler.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

/**
 * Register CallTool handler.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list_workspaces": {
        const data = await client.listWorkspaces();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "list_semantic_models": {
        const { workspace_id } = args;
        const data = await client.listSemanticModels(workspace_id);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "list_datasets": {
        const { workspace_id } = args;
        const data = workspace_id
          ? await client.listDatasetsInGroup(workspace_id)
          : await client.listDatasetsAllGroups();
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "get_dataset_metadata": {
        const { workspace_id, dataset_id } = args;
        let data = null;
        let source = "push_tables";
        try {
          data = await client.getDatasetTables(workspace_id, dataset_id);
        } catch (err) {
          if (err.statusCode === 400 || err.statusCode === 401 || err.statusCode === 404) {
            source = "info_view";
            data = await client.getDatasetMetadataViaInfoView(workspace_id, dataset_id);
          } else {
            throw err;
          }
        }
        return { content: [{ type: "text", text: JSON.stringify({ source, data }, null, 2) }] };
      }

      case "describe_dataset": {
        const { workspace_id, dataset_id } = args;
        const metadata = await client.getDatasetMetadataViaInfoView(workspace_id, dataset_id);
        const summary = {
          dataset_id,
          tables: metadata.tables.filter(t => !t.IsHidden).map(t => ({ name: t.Name, storage_mode: t.StorageMode })),
          columns: metadata.columns.filter(c => !c.IsHidden).map(c => ({ table: c.Table, name: c.Name, data_type: c.DataType })),
          measures: metadata.measures.map(m => ({ table: m.Table, name: m.Name, expression: m.Expression }))
        };
        return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
      }

      case "get_semantic_model_definition": {
        const { workspace_id, semantic_model_id, format } = args;
        const data = await client.getSemanticModelDefinition(workspace_id, semantic_model_id, format);
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "create_semantic_model": {
        const { workspace_id, display_name, description, definition } = args;
        const data = await client.createSemanticModel(workspace_id, {
          displayName: display_name,
          description,
          definition
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "update_semantic_model": {
        const { workspace_id, semantic_model_id, display_name, description } = args;
        // Filter undefined to avoid API errors
        const body = {};
        if (display_name !== undefined) body.displayName = display_name;
        if (description !== undefined) body.description = description;

        const data = await client.fabricFetch(`/workspaces/${workspace_id}/semanticModels/${semantic_model_id}`, {
          method: "PATCH",
          body
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "update_semantic_model_definition": {
        const { workspace_id, semantic_model_id, update_metadata, definition } = args;
        const data = await client.updateSemanticModelDefinition(
          workspace_id,
          semantic_model_id,
          { definition },
          update_metadata
        );
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "clone_semantic_model_to_new": {
        const {
          source_workspace_id,
          source_semantic_model_id,
          new_display_name,
          target_workspace_id,
          new_description,
          format
        } = args;
        
        const definition = await client.getSemanticModelDefinition(
          source_workspace_id,
          source_semantic_model_id,
          format || "TMDL"
        );

        const created = await client.createSemanticModel(target_workspace_id || source_workspace_id, {
          displayName: new_display_name,
          description: new_description,
          definition: definition.definition
        });

        return { content: [{ type: "text", text: JSON.stringify(created, null, 2) }] };
      }

      case "bind_semantic_model_connection": {
        const { workspace_id, semantic_model_id, connection_id } = args;
        // Correct Fabric item connection bind path
        const data = await client.fabricFetch(`/workspaces/${workspace_id}/items/${semantic_model_id}/connections/${connection_id}/bind`, {
          method: "POST",
          body: {}
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "execute_dax_query": {
        const { workspace_id, dataset_id, query } = args;
        const data = await client.executeDaxQuery(workspace_id, dataset_id, query);
        const warnings = checkQueryErrors(data);
        const response = { results: data.results, warnings: warnings.length ? warnings : undefined };
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
      }

      case "refresh_dataset": {
        const { workspace_id, dataset_id, notify_option } = args;
        const data = await client.refreshDataset(workspace_id, dataset_id, { notifyOption: notify_option });
        return { content: [{ type: "text", text: JSON.stringify({ status: "accepted", data }, null, 2) }] };
      }

      case "export_data": {
        const { workspace_id, dataset_id, query } = args;
        const result = await client.executeDaxQuery(workspace_id, dataset_id, query);
        const warnings = checkQueryErrors(result);
        const rows = normalizeExecuteQueryRows(result);
        const csv = toCsv(rows);
        const output = warnings.length ? `⚠️ WARNING: ${warnings.join(", ")}\n\n${csv}` : csv;
        return { content: [{ type: "text", text: output }] };
      }

      case "scan_workspace_metadata": {
        const { workspace_id } = args;
        const data = await client.scanWorkspaceMetadata(workspace_id, {
          datasetExpressions: true,
          datasourceDetails: true,
          lineage: true
        });
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

/**
 * Start the server.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Power BI MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
