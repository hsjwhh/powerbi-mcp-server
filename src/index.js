import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PowerBIClient, normalizeExecuteQueryRows, toCsv } from "./powerbi.js";

const server = new Server(
  {
    name: "mcp-powerbi",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

const client = new PowerBIClient();

server.registerTool(
  "list_workspaces",
  {
    description: "List workspaces accessible to the configured service principal.",
    inputSchema: z.object({})
  },
  async () => {
    const data = await client.listWorkspaces();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  "list_datasets",
  {
    description:
      "List datasets. If workspace_id is provided, lists datasets in that workspace; otherwise returns datasets across all workspaces.",
    inputSchema: z.object({
      workspace_id: z.string().uuid().optional()
    })
  },
  async ({ workspace_id }) => {
    const data = workspace_id
      ? await client.listDatasetsInGroup(workspace_id)
      : await client.listDatasetsAllGroups();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  "get_dataset_metadata",
  {
    description:
      "Get dataset schema (tables, columns, measures). Uses Push Dataset tables endpoint when available, otherwise falls back to INFO.VIEW DAX queries for standard semantic models; optionally falls back to Admin Scanner API when POWERBI_USE_SCANNER=true.",
    inputSchema: z.object({
      workspace_id: z.string().uuid(),
      dataset_id: z.string().uuid()
    })
  },
  async ({ workspace_id, dataset_id }) => {
    let data = null;
    let source = "push_tables";

    try {
      data = await client.getDatasetTables(workspace_id, dataset_id);
    } catch (err) {
      const message = String(err);
      const shouldTryInfoView =
        message.includes("not Push API dataset") ||
        message.includes("does not have write access") ||
        message.includes("PowerBIEntityNotFound") ||
        message.includes("Unauthorized");

      if (shouldTryInfoView) {
        source = "info_view";
        data = await client.getDatasetMetadataViaInfoView(workspace_id, dataset_id);
      } else {
        const useScanner = String(process.env.POWERBI_USE_SCANNER || "").toLowerCase() === "true";
        if (!useScanner) {
          throw err;
        }
        source = "scanner";
        const scan = await client.scanWorkspaceMetadata(workspace_id, {
          datasetExpressions: true,
          datasourceDetails: false,
          lineage: false
        });

        const ws = (scan.workspaces || []).find((w) => w.id === workspace_id);
        const dataset = ws?.datasets?.find((d) => d.id === dataset_id);
        if (!dataset) {
          throw new Error("Dataset not found in scanner result.");
        }
        data = dataset;
      }
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ source, data }, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  "describe_dataset",
  {
    description:
      "Return a compact dataset summary optimized for natural-language-to-DAX workflows, including visible tables, columns, and measures.",
    inputSchema: z.object({
      workspace_id: z.string().uuid(),
      dataset_id: z.string().uuid()
    })
  },
  async ({ workspace_id, dataset_id }) => {
    const metadata = await client.getDatasetMetadataViaInfoView(workspace_id, dataset_id);
    const visibleTables = metadata.tables
      .filter((table) => !table.IsHidden)
      .map((table) => ({
        name: table.Name,
        storage_mode: table.StorageMode
      }));

    const visibleColumns = metadata.columns
      .filter((column) => !column.IsHidden)
      .map((column) => ({
        table: column.Table,
        name: column.Name,
        data_type: column.DataType,
        summarize_by: column.SummarizeBy
      }));

    const measures = metadata.measures.map((measure) => ({
      table: measure.Table,
      name: measure.Name,
      expression: measure.Expression,
      format_string: measure.FormatString
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              dataset_id,
              tables: visibleTables,
              columns: visibleColumns,
              measures
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.registerTool(
  "execute_dax_query",
  {
    description: "Execute a DAX query against a dataset.",
    inputSchema: z.object({
      workspace_id: z.string().uuid(),
      dataset_id: z.string().uuid(),
      query: z.string().min(1)
    })
  },
  async ({ workspace_id, dataset_id, query }) => {
    const data = await client.executeDaxQuery(workspace_id, dataset_id, query);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  "refresh_dataset",
  {
    description: "Trigger a dataset refresh.",
    inputSchema: z.object({
      workspace_id: z.string().uuid(),
      dataset_id: z.string().uuid()
    })
  },
  async ({ workspace_id, dataset_id }) => {
    const data = await client.refreshDataset(workspace_id, dataset_id);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "accepted", data }, null, 2)
        }
      ]
    };
  }
);

server.registerTool(
  "export_data",
  {
    description: "Execute a DAX query and return the first table as CSV.",
    inputSchema: z.object({
      workspace_id: z.string().uuid(),
      dataset_id: z.string().uuid(),
      query: z.string().min(1)
    })
  },
  async ({ workspace_id, dataset_id, query }) => {
    const result = await client.executeDaxQuery(workspace_id, dataset_id, query);
    const rows = normalizeExecuteQueryRows(result);
    const csv = toCsv(rows);

    return {
      content: [
        {
          type: "text",
          text: csv
        }
      ]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
