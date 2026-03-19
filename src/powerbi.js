import { setTimeout as delay } from "timers/promises";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

const POWERBI_API_BASE = "https://api.powerbi.com/v1.0/myorg";
const FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1";
const LOGIN_BASE = "https://login.microsoftonline.com";
const DEFAULT_SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const DEFAULT_FABRIC_SCOPE = "https://api.fabric.microsoft.com/.default";

loadDotEnv();

/**
 * Loads environment variables from .env file if it exists.
 */
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

/**
 * Helper to get value from environment or throw.
 */
function getEnv(name) {
  return process.env[name];
}

export class PowerBIClient {
  constructor(options = {}) {
    this.tenantId = options.tenantId || getEnv("POWERBI_TENANT_ID");
    this.clientId = options.clientId || getEnv("POWERBI_CLIENT_ID");
    this.clientSecret = options.clientSecret || getEnv("POWERBI_CLIENT_SECRET");
    this.scope = options.scope || getEnv("POWERBI_SCOPE") || DEFAULT_SCOPE;
    this.fabricScope =
      options.fabricScope || getEnv("FABRIC_SCOPE") || DEFAULT_FABRIC_SCOPE;
    this.userAgent = options.userAgent || "mcp-powerbi/0.1.0";
    
    // Token cache stores both the token/expiry and any pending refresh Promise
    this._tokenCache = new Map();
  }

  /**
   * Securely retrieves access token with concurrency locking.
   */
  async getToken(scope) {
    const cached = this._tokenCache.get(scope);
    
    // Check if we have a valid cached token
    if (cached && cached.token && !(cached.token instanceof Promise) && Date.now() < cached.expiresAt - 60_000) {
      return cached.token;
    }

    // If a refresh is already in progress, wait for it
    if (cached && cached.token instanceof Promise) {
      return cached.token;
    }

    if (!this.tenantId || !this.clientId || !this.clientSecret) {
      throw new Error("Missing required Power BI credentials (Tenant/Client ID or Secret).");
    }

    // Start a new refresh and store the Promise as a lock
    const refreshPromise = (async () => {
      try {
        const url = `${LOGIN_BASE}/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`;
        const body = new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope,
          grant_type: "client_credentials"
        });

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
      } catch (error) {
        // Clear the failed Promise lock so next attempt can retry
        this._tokenCache.delete(scope);
        throw error;
      }
    })();

    this._tokenCache.set(scope, { token: refreshPromise, expiresAt: Infinity });
    return refreshPromise;
  }

  async getAccessToken() {
    return this.getToken(this.scope);
  }

  async getFabricAccessToken() {
    return this.getToken(this.fabricScope);
  }

  /**
   * Generic fetch for Power BI API with 429 retry and timeout support.
   */
  async apiFetch(pathOrUrl, options = {}, retries = 3) {
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

    // Handle Rate Limiting (HTTP 429)
    if (res.status === 429 && retries > 0) {
      const retryAfter = Number(res.headers.get("retry-after") || 5);
      await delay(retryAfter * 1000);
      return this.apiFetch(pathOrUrl, options, retries - 1);
    }

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Power BI API error (${res.status}): ${text}`);
      err.statusCode = res.status;
      throw err;
    }

    if (res.status === 204 || res.status === 202) {
      return null;
    }

    return res.json();
  }

  /**
   * Generic fetch for Fabric API with LRO polling support.
   */
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

    // Still handle 429 for Fabric even though handleFabricResponse is called after first fetch
    if (res.status === 429) {
       const retryAfter = Number(res.headers.get("retry-after") || 5);
       await delay(retryAfter * 1000);
       // Simple one-time internal retry for Fabric start
       return this.fabricFetch(res.url, options);
    }

    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`Fabric API error (${res.status}): ${text}`);
      err.statusCode = res.status;
      throw err;
    }

    if (res.status === 204 || res.status === 202) {
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

  /**
   * Parallel traversal of all workspaces with error isolation.
   */
  async listDatasetsAllGroups() {
    const workspaces = await this.listWorkspaces();
    
    // Concurrently fetch datasets from each workspace using allSettled to isolate errors
    const results = await Promise.allSettled(
      workspaces.map(async (ws) => {
        const datasets = await this.listDatasetsInGroup(ws.id);
        return datasets.map((ds) => ({
          workspaceId: ws.id,
          workspaceName: ws.name,
          datasetId: ds.id,
          datasetName: ds.name,
          addRowsAPIEnabled: ds.addRowsAPIEnabled,
          configuredBy: ds.configuredBy,
          isRefreshable: ds.isRefreshable
        }));
      })
    );

    return results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value);
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

  /**
   * Robust metadata extraction using INFO.VIEW with field case-insensitivity.
   */
  async getDatasetMetadataViaInfoView(groupId, datasetId) {
    const [tablesResult, columnsResult, measuresResult] = await Promise.all([
      this.executeDaxQuery(groupId, datasetId, "EVALUATE INFO.VIEW.TABLES()"),
      this.executeDaxQuery(groupId, datasetId, "EVALUATE INFO.VIEW.COLUMNS()"),
      this.executeDaxQuery(groupId, datasetId, "EVALUATE INFO.VIEW.MEASURES()")
    ]);

    const normalizeInfoViewRows = (result) => {
      const rows = normalizeExecuteQueryRows(result);
      return rows.map(row => {
        const normalized = {};
        for (const [key, val] of Object.entries(row)) {
          // Normalize common fields for stability across Power BI versions
          if (key.toLowerCase() === "ishidden") normalized.IsHidden = val;
          if (key.toLowerCase() === "name") normalized.Name = val;
          if (key.toLowerCase() === "table") normalized.Table = val;
          normalized[key] = val;
        }
        return normalized;
      });
    };

    return { 
      tables: normalizeInfoViewRows(tablesResult), 
      columns: normalizeInfoViewRows(columnsResult), 
      measures: normalizeInfoViewRows(measuresResult) 
    };
  }

  /**
   * Triggers dataset refresh with support for notifyOption (critical for Shared capacity).
   */
  async refreshDataset(groupId, datasetId, options = {}) {
    const body = {
      notifyOption: options.notifyOption || "NoNotification"
    };
    return this.apiFetch(`/groups/${groupId}/datasets/${datasetId}/refreshes`, {
      method: "POST",
      body
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

/**
 * Converts result rows to CSV string with escaping.
 */
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

/**
 * Cleans up property names from executeQueries response (removes [Table] brackets).
 */
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
