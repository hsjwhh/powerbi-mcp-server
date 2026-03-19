import { setTimeout as delay } from "timers/promises";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const POWERBI_API_BASE = "https://api.powerbi.com/v1.0/myorg";
const FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1";
const LOGIN_BASE = "https://login.microsoftonline.com";
const DEFAULT_SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const DEFAULT_FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";

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
    this.fabricScope =
      options.fabricScope || process.env.FABRIC_SCOPE || DEFAULT_FABRIC_SCOPE;
    this.userAgent = options.userAgent || "mcp-powerbi/0.1.0";
    this._tokenCache = new Map();
  }

  async getToken(scope) {
    const cached = this._tokenCache.get(scope);
    if (cached && Date.now() < cached.expiresAt - 60_000) {
      return cached.token;
    }

    const tenantId = requireEnv("POWERBI_TENANT_ID");
    const clientId = requireEnv("POWERBI_CLIENT_ID");
    const clientSecret = requireEnv("POWERBI_CLIENT_SECRET");

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
    const token = data.access_token;
    this._tokenCache.set(scope, {
      token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    });
    return token;
  }

  async getAccessToken() {
    return this.getToken(this.scope);
  }

  async getFabricAccessToken() {
    return this.getToken(this.fabricScope);
  }

  async apiFetch(pathOrUrl, options = {}) {
    const token = await this.getAccessToken();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${POWERBI_API_BASE}${pathOrUrl}`;

    const res = await this.fetchWithTimeout(url, {
      method: options.method || "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    }, options.timeoutMs);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Power BI API error (${res.status}): ${text}`);
    }

    if (res.status === 204) {
      return null;
    }

    return res.json();
  }

  async fabricFetch(pathOrUrl, options = {}) {
    const token = await this.getFabricAccessToken();
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : `${FABRIC_API_BASE}${pathOrUrl}`;

    const res = await this.fetchWithTimeout(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": this.userAgent,
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    }, options.timeoutMs);

    return this.handleFabricResponse(res, options);
  }

  async fetchWithTimeout(url, init, timeoutMs = 30_000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`Request timeout after ${timeoutMs}ms for ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async handleFabricResponse(res, options = {}) {
    if (res.status === 202) {
      return this.pollFabricOperation(res, options);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Fabric API error (${res.status}): ${text}`);
    }

    if (res.status === 204) {
      return null;
    }

    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async pollFabricOperation(res, options = {}) {
    const operationId = res.headers.get("x-ms-operation-id");
    let location = res.headers.get("location");
    if (!location && operationId) {
      location = `${FABRIC_API_BASE}/operations/${operationId}`;
    }

    if (!location) {
      throw new Error("Fabric LRO did not provide a polling URL.");
    }

    const timeoutMs = options.timeoutMs || 120_000;
    const deadline = Date.now() + timeoutMs;
    let pollUrl = location;
    let lastResponse = res;

    while (Date.now() < deadline) {
      const retryAfterSeconds = Number(lastResponse.headers.get("retry-after") || 2);
      await delay(Math.max(retryAfterSeconds, 1) * 1000);

      const token = await this.getFabricAccessToken();
      const pollRes = await this.fetchWithTimeout(pollUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": this.userAgent
        }
      }, 30_000);

      if (pollRes.status === 202) {
        const nextLocation = pollRes.headers.get("location");
        if (nextLocation) {
          pollUrl = nextLocation;
        }
        lastResponse = pollRes;
        continue;
      }

      if (!pollRes.ok) {
        const text = await pollRes.text();
        throw new Error(`Fabric LRO polling error (${pollRes.status}): ${text}`);
      }

      const nextLocation = pollRes.headers.get("location");
      const body = await this.parseJsonResponse(pollRes);

      if (!body || !body.status) {
        if (nextLocation && nextLocation !== pollUrl) {
          pollUrl = nextLocation;
          lastResponse = pollRes;
          continue;
        }
        return body;
      }

      if (body.status === "Succeeded") {
        const resultUrl =
          (nextLocation && nextLocation !== pollUrl && nextLocation) ||
          (operationId ? `/operations/${operationId}/result` : null);

        if (resultUrl) {
          return this.fabricFetch(resultUrl, { method: "GET", timeoutMs: 15_000 });
        }
        return {
          ...body,
          operationId,
          resultUrl
        };
      }

      if (body.status === "Failed" || body.status === "Canceled") {
        throw new Error(`Fabric LRO failed: ${JSON.stringify(body)}`);
      }

      if (nextLocation) {
        pollUrl = nextLocation;
      }
      lastResponse = pollRes;
    }

    throw new Error("Fabric LRO timeout waiting for operation completion.");
  }

  async parseJsonResponse(res) {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
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

  async listSemanticModels(workspaceId) {
    const items = [];
    let next = `/workspaces/${workspaceId}/semanticModels`;

    while (next) {
      const data = await this.fabricFetch(next);
      if (Array.isArray(data?.value)) {
        items.push(...data.value);
      }
      next = data?.continuationUri || null;
    }

    return items;
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

  async getSemanticModel(workspaceId, semanticModelId) {
    return this.fabricFetch(`/workspaces/${workspaceId}/semanticModels/${semanticModelId}`);
  }

  async getSemanticModelDefinition(workspaceId, semanticModelId, format) {
    const suffix = format ? `?format=${encodeURIComponent(format)}` : "";
    return this.fabricFetch(
      `/workspaces/${workspaceId}/semanticModels/${semanticModelId}/getDefinition${suffix}`,
      {
        method: "POST"
      }
    );
  }

  async createSemanticModel(workspaceId, body) {
    return this.fabricFetch(`/workspaces/${workspaceId}/semanticModels`, {
      method: "POST",
      body
    });
  }

  async updateSemanticModelDefinition(workspaceId, semanticModelId, body, updateMetadata) {
    const suffix =
      typeof updateMetadata === "boolean"
        ? `?updateMetadata=${encodeURIComponent(String(updateMetadata))}`
        : "";
    return this.fabricFetch(
      `/workspaces/${workspaceId}/semanticModels/${semanticModelId}/updateDefinition${suffix}`,
      {
        method: "POST",
        body
      }
    );
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
