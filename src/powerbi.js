import { setTimeout as delay } from "timers/promises";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const POWERBI_API_BASE = "https://api.powerbi.com/v1.0/myorg";
const LOGIN_BASE = "https://login.microsoftonline.com";
const DEFAULT_SCOPE = "https://analysis.windows.net/powerbi/api/.default";

loadDotEnv();

function loadDotEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = trimmed.slice(separatorIndex + 1).trim();
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export class PowerBIClient {
  constructor(options = {}) {
    this.tenantId = options.tenantId || process.env.POWERBI_TENANT_ID;
    this.clientId = options.clientId || process.env.POWERBI_CLIENT_ID;
    this.clientSecret = options.clientSecret || process.env.POWERBI_CLIENT_SECRET;
    this.scope = options.scope || process.env.POWERBI_SCOPE || DEFAULT_SCOPE;
    this.userAgent = options.userAgent || "mcp-powerbi/0.1.0";
    this._token = null;
    this._tokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this._token && Date.now() < this._tokenExpiresAt - 60_000) {
      return this._token;
    }

    const tenantId = requireEnv("POWERBI_TENANT_ID");
    const clientId = requireEnv("POWERBI_CLIENT_ID");
    const clientSecret = requireEnv("POWERBI_CLIENT_SECRET");
    const scope = this.scope;

    const url = `${LOGIN_BASE}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope,
      grant_type: "client_credentials"
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Token request failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    this._token = data.access_token;
    this._tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    return this._token;
  }

  async apiFetch(pathOrUrl, options = {}) {
    const token = await this.getAccessToken();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${POWERBI_API_BASE}${pathOrUrl}`;

    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Power BI API error (${res.status}): ${text}`);
    }

    if (res.status === 204) {
      return null;
    }

    return res.json();
  }

  async fetchAll(url) {
    let next = url;
    const items = [];
    while (next) {
      const data = await this.apiFetch(next);
      if (Array.isArray(data.value)) {
        items.push(...data.value);
      }
      next = data["@odata.nextLink"] || null;
    }
    return items;
  }

  async listWorkspaces() {
    return this.fetchAll(`${POWERBI_API_BASE}/groups`);
  }

  async listDatasetsInGroup(groupId) {
    return this.fetchAll(`${POWERBI_API_BASE}/groups/${groupId}/datasets`);
  }

  async listDatasetsAllGroups() {
    const workspaces = await this.listWorkspaces();
    const results = [];

    for (const ws of workspaces) {
      const datasets = await this.listDatasetsInGroup(ws.id);
      for (const ds of datasets) {
        results.push({
          workspaceId: ws.id,
          workspaceName: ws.name,
          datasetId: ds.id,
          datasetName: ds.name,
          addRowsAPIEnabled: ds.addRowsAPIEnabled,
          configuredBy: ds.configuredBy,
          isRefreshable: ds.isRefreshable
        });
      }
    }

    return results;
  }

  async getDatasetTables(groupId, datasetId) {
    return this.apiFetch(`/groups/${groupId}/datasets/${datasetId}/tables`);
  }

  async executeDaxQuery(groupId, datasetId, query) {
    const body = {
      queries: [{ query }],
      serializerSettings: { includeNulls: true }
    };
    return this.apiFetch(`/groups/${groupId}/datasets/${datasetId}/executeQueries`, {
      method: "POST",
      body
    });
  }

  async getDatasetMetadataViaInfoView(groupId, datasetId) {
    const [tablesResult, columnsResult, measuresResult] = await Promise.all([
      this.executeDaxQuery(groupId, datasetId, "EVALUATE INFO.VIEW.TABLES()"),
      this.executeDaxQuery(groupId, datasetId, "EVALUATE INFO.VIEW.COLUMNS()"),
      this.executeDaxQuery(groupId, datasetId, "EVALUATE INFO.VIEW.MEASURES()")
    ]);

    const tables = normalizeExecuteQueryRows(tablesResult);
    const columns = normalizeExecuteQueryRows(columnsResult);
    const measures = normalizeExecuteQueryRows(measuresResult);

    return { tables, columns, measures };
  }

  async refreshDataset(groupId, datasetId) {
    return this.apiFetch(`/groups/${groupId}/datasets/${datasetId}/refreshes`, {
      method: "POST",
      body: {}
    });
  }

  async scanWorkspaceMetadata(groupId, options = {}) {
    const query = new URLSearchParams({
      datasetSchema: "true",
      datasetExpressions: options.datasetExpressions ? "true" : "false",
      datasourceDetails: options.datasourceDetails ? "true" : "false",
      lineage: options.lineage ? "true" : "false"
    });

    const body = { workspaces: [groupId] };
    const scan = await this.apiFetch(`/admin/workspaces/getInfo?${query.toString()}`, {
      method: "POST",
      body
    });

    const scanId = scan.id;
    if (!scanId) {
      throw new Error("Scanner API did not return scan id.");
    }

    const maxWaitMs = options.maxWaitMs || 60_000;
    const pollIntervalMs = options.pollIntervalMs || 2_000;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      const status = await this.apiFetch(`/admin/workspaces/scanStatus/${scanId}`);
      if (status?.status === "Succeeded") {
        return this.apiFetch(`/admin/workspaces/scanResult/${scanId}`);
      }
      if (status?.status === "Failed") {
        throw new Error(`Scanner API failed: ${JSON.stringify(status)}`);
      }
      await delay(pollIntervalMs);
    }

    throw new Error("Scanner API timeout waiting for scan result.");
  }
}

export function toCsv(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return "";
  }
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[",\n]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  };

  const lines = [headers.map(escape).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(","));
  }
  return lines.join("\n");
}

export function normalizeExecuteQueryRows(result) {
  const rows = result?.results?.[0]?.tables?.[0]?.rows || [];
  return rows.map((row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      const cleanKey =
        key.startsWith("[") && key.endsWith("]") ? key.slice(1, -1) : key;
      normalized[cleanKey] = value;
    }
    return normalized;
  });
}
