var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SimpleEncryptedSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian3 = require("obsidian");

// src/crypto.ts
var encoder = new TextEncoder();
var decoder = new TextDecoder();
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function randomBase64(size = 32) {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(size)));
}
async function sha256(data) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}
async function keyedSha256(data, keyBase64) {
  const key = await crypto.subtle.importKey("raw", exactBuffer(base64ToBytes(keyBase64)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}
async function importAesKey(keyBase64) {
  return crypto.subtle.importKey("raw", exactBuffer(base64ToBytes(keyBase64)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptBytes(data, keyBase64) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyBase64);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, data));
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce, 0);
  result.set(encrypted, nonce.length);
  return result.buffer;
}
async function decryptBytes(data, keyBase64) {
  const bytes = new Uint8Array(data);
  if (bytes.length < 29) throw new Error("\u041F\u043E\u0432\u0440\u0435\u0436\u0434\u0451\u043D \u0437\u0430\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u043F\u0430\u043A\u0435\u0442");
  const key = await importAesKey(keyBase64);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
}
async function encryptJson(value, keyBase64) {
  const source = encoder.encode(JSON.stringify(value));
  return bytesToBase64(new Uint8Array(await encryptBytes(source.buffer, keyBase64)));
}
async function decryptJson(value, keyBase64) {
  return JSON.parse(decoder.decode(await decryptBytes(exactBuffer(base64ToBytes(value)), keyBase64)));
}
async function deriveAuthToken(keyBase64, vaultId) {
  const material = encoder.encode(`simple-sync-auth:${vaultId}:${keyBase64}`);
  return sha256(material.buffer);
}
async function deriveChannelConnection(channelIdValue) {
  const channelId = normalizeChannelId(channelIdValue);
  const vaultDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`simple-sync-vault:${channelId}`)));
  const keyDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`simple-sync-key:${channelId}`)));
  return {
    vaultId: toBase64Url(vaultDigest.slice(0, 18)),
    encryptionKey: bytesToBase64(keyDigest)
  };
}
function normalizeChannelId(value) {
  const normalized = value.trim().replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  let decoded;
  try {
    decoded = base64ToBytes(padded);
  } catch {
    throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 ID \u043A\u0430\u043D\u0430\u043B\u0430");
  }
  if (decoded.length !== 32) throw new Error("ID \u043A\u0430\u043D\u0430\u043B\u0430 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u0441\u043E\u0437\u0434\u0430\u043D \u0432 \u0438\u043D\u0442\u0435\u0440\u0444\u0435\u0439\u0441\u0435 \u0441\u0435\u0440\u0432\u0435\u0440\u0430");
  return toBase64Url(decoded);
}
function encodePairingCode(value) {
  return bytesToBase64(encoder.encode(JSON.stringify(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function decodePairingCode(value) {
  const normalized = value.trim().replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(decoder.decode(base64ToBytes(padded)));
}
function exactBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function toBase64Url(bytes) {
  return bytesToBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

// src/remote.ts
var import_obsidian = require("obsidian");
var ConflictError = class extends Error {
};
var RemoteClient = class _RemoteClient {
  constructor(baseUrl, vaultId, token) {
    this.baseUrl = baseUrl;
    this.vaultId = vaultId;
    this.token = token;
  }
  static async create(baseUrl, vaultId, encryptionKey) {
    return new _RemoteClient(normalizeServer(baseUrl), vaultId, await deriveAuthToken(encryptionKey, vaultId));
  }
  headers(contentType) {
    return {
      Authorization: `Bearer ${this.token}`,
      ...contentType ? { "Content-Type": contentType } : {}
    };
  }
  async createVault() {
    await (0, import_obsidian.requestUrl)({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}`,
      method: "POST",
      headers: this.headers("application/json"),
      body: "{}",
      throw: true
    });
  }
  async ping() {
    await (0, import_obsidian.requestUrl)({ url: `${this.baseUrl}/health`, method: "GET", throw: true });
  }
  async getManifest() {
    const response = await (0, import_obsidian.requestUrl)({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/manifest`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status === 404) return { version: 0, payload: null };
    if (response.status === 401 || response.status === 403) throw new Error("\u0421\u0435\u0440\u0432\u0435\u0440 \u043E\u0442\u043A\u043B\u043E\u043D\u0438\u043B \u043A\u043B\u044E\u0447 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u0438");
    if (response.status !== 200) throw new Error(`\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0441\u0435\u0440\u0432\u0435\u0440\u0430 (${response.status})`);
    const parsed = response.json;
    if (typeof parsed.version !== "number" || typeof parsed.payload !== "string") {
      throw new Error("\u0421\u0435\u0440\u0432\u0435\u0440 \u0432\u0435\u0440\u043D\u0443\u043B \u043D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043C\u0430\u043D\u0438\u0444\u0435\u0441\u0442");
    }
    return { version: parsed.version, payload: parsed.payload };
  }
  async putManifest(expectedVersion, payload) {
    const response = await (0, import_obsidian.requestUrl)({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/manifest`,
      method: "PUT",
      headers: { ...this.headers("application/json"), "If-Match": String(expectedVersion) },
      body: JSON.stringify({ payload }),
      throw: false
    });
    if (response.status === 409 || response.status === 412) throw new ConflictError("\u041C\u0430\u043D\u0438\u0444\u0435\u0441\u0442 \u0443\u0436\u0435 \u0438\u0437\u043C\u0435\u043D\u0451\u043D \u0434\u0440\u0443\u0433\u0438\u043C \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E\u043C");
    if (response.status !== 200) throw new Error(`\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C \u0441\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0441\u0435\u0440\u0432\u0435\u0440\u0430 (${response.status})`);
    const parsed = response.json;
    if (typeof parsed.version !== "number") throw new Error("\u0421\u0435\u0440\u0432\u0435\u0440 \u043D\u0435 \u0432\u0435\u0440\u043D\u0443\u043B \u0432\u0435\u0440\u0441\u0438\u044E \u043C\u0430\u043D\u0438\u0444\u0435\u0441\u0442\u0430");
    return parsed.version;
  }
  async putBlob(blobId, encrypted) {
    const response = await (0, import_obsidian.requestUrl)({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      method: "PUT",
      headers: this.headers("application/octet-stream"),
      body: encrypted,
      throw: false
    });
    if (response.status !== 200 && response.status !== 201) throw new Error(`\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0444\u0430\u0439\u043B (${response.status})`);
  }
  async getBlob(blobId) {
    const response = await (0, import_obsidian.requestUrl)({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status !== 200) throw new Error(`\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0441\u043A\u0430\u0447\u0430\u0442\u044C \u0444\u0430\u0439\u043B (${response.status})`);
    return response.arrayBuffer;
  }
  async putPublication(snapshot) {
    const response = await (0, import_obsidian.requestUrl)({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/publication`,
      method: "PUT",
      headers: this.headers("application/json"),
      body: JSON.stringify(snapshot),
      throw: false
    });
    if (response.status !== 200) throw new Error(`\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0432\u0435\u0431-\u0432\u0438\u0442\u0440\u0438\u043D\u0443 (${response.status})`);
  }
};
function normalizeServer(value) {
  const trimmed = value.trim().replace(/\/+$/u, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("\u0410\u0434\u0440\u0435\u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u0430 \u0434\u043E\u043B\u0436\u0435\u043D \u043D\u0430\u0447\u0438\u043D\u0430\u0442\u044C\u0441\u044F \u0441 http:// \u0438\u043B\u0438 https://");
  return parsed.toString().replace(/\/+$/u, "");
}

// src/sync-engine.ts
var import_obsidian2 = require("obsidian");

// src/merge.ts
function decideMerge(path, local, remote, base) {
  if (local === remote) return { kind: "same", path };
  if (base === null) {
    if (local === null) return { kind: "download", path };
    if (remote === null) return { kind: "upload", path };
    return { kind: "conflict", path };
  }
  if (local === base) {
    return remote === null ? { kind: "delete-local", path } : { kind: "download", path };
  }
  if (remote === base) {
    return local === null ? { kind: "delete-remote", path } : { kind: "upload", path };
  }
  if (local === null) return { kind: "download", path };
  if (remote === null) return { kind: "conflict", path };
  return { kind: "conflict", path };
}
function conflictPath(path, deviceId, time = /* @__PURE__ */ new Date()) {
  const safeDevice = deviceId.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 20) || "device";
  const suffix = `${time.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z")}-${safeDevice}`;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExtension = dot > slash;
  return hasExtension ? `${path.slice(0, dot)}.conflict-${suffix}${path.slice(dot)}` : `${path}.conflict-${suffix}`;
}

// src/shared-settings.ts
function isSharedSettingsEnvelope(value) {
  if (!value || typeof value !== "object") return false;
  const candidate = value;
  return Number.isFinite(candidate.updatedAt) && typeof candidate.updatedBy === "string" && Boolean(candidate.value && typeof candidate.value === "object");
}
function mergeSharedSettings(settings, remote) {
  const local = settings.sharedSettingsUpdatedAt > 0 ? createSharedSettingsEnvelope(settings) : void 0;
  if (!remote) return local ? { action: "upload", remote: local } : { action: "none", remote };
  if (!local || compareEnvelope(remote, local) > 0) {
    applySharedSettings(settings, remote);
    return { action: "download", remote };
  }
  if (compareEnvelope(local, remote) > 0) return { action: "upload", remote: local };
  return { action: "none", remote };
}
function createSharedSettingsEnvelope(settings) {
  return {
    updatedAt: settings.sharedSettingsUpdatedAt,
    updatedBy: settings.deviceId,
    value: {
      publicationEnabled: settings.publicationEnabled,
      siteTitle: settings.siteTitle,
      publicationFolders: [...settings.publicationFolders],
      publicationRules: settings.publicationRules
    }
  };
}
function applySharedSettings(settings, envelope) {
  settings.publicationEnabled = Boolean(envelope.value.publicationEnabled);
  settings.siteTitle = String(envelope.value.siteTitle || "\u041C\u043E\u0438 \u0437\u0430\u043C\u0435\u0442\u043A\u0438");
  settings.publicationFolders = Array.isArray(envelope.value.publicationFolders) ? [...new Set(envelope.value.publicationFolders.map(normalizeSharedPath))].sort((a, b) => a.localeCompare(b, "ru")) : [];
  settings.publicationRules = String(envelope.value.publicationRules || "");
  settings.sharedSettingsUpdatedAt = envelope.updatedAt;
  settings.publicationFingerprint = "";
}
function compareEnvelope(left, right) {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  return left.updatedBy.localeCompare(right.updatedBy);
}
function normalizeSharedPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}

// src/sync-engine.ts
var SyncEngine = class {
  constructor(app, getSettings, saveSettings, onStatus) {
    this.app = app;
    this.getSettings = getSettings;
    this.saveSettings = saveSettings;
    this.onStatus = onStatus;
    this.running = false;
  }
  async sync() {
    if (this.running) return null;
    const settings = this.getSettings();
    if (!settings.serverUrl || !settings.vaultId || !settings.encryptionKey) return null;
    this.running = true;
    this.onStatus("\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F\u2026");
    try {
      const result = await this.syncAttempt(settings);
      this.onStatus(`\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u043D\u043E: \u2191${result.uploaded} \u2193${result.downloaded}, \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u043E\u0432: ${result.conflicts}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onStatus(`\u041E\u0448\u0438\u0431\u043A\u0430: ${message}`, true);
      throw error;
    } finally {
      this.running = false;
    }
  }
  async syncAttempt(settings) {
    const client = await RemoteClient.create(settings.serverUrl, settings.vaultId, settings.encryptionKey);
    const remoteResponse = await client.getManifest();
    const manifest = remoteResponse.payload ? await decryptJson(remoteResponse.payload, settings.encryptionKey) : { format: 1, updatedAt: Date.now(), entries: {} };
    if (manifest.format !== 1 || !manifest.entries) throw new Error("\u041D\u0435\u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043C\u044B\u0439 \u0444\u043E\u0440\u043C\u0430\u0442 \u0443\u0434\u0430\u043B\u0451\u043D\u043D\u043E\u0433\u043E \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0430");
    let remoteChanged = false;
    const sharedMerge = mergeSharedSettings(settings, isSharedSettingsEnvelope(manifest.sharedSettings) ? manifest.sharedSettings : void 0);
    if (sharedMerge.action === "upload") {
      manifest.sharedSettings = sharedMerge.remote;
      remoteChanged = true;
    }
    const local = await this.readLocalFiles();
    const paths = /* @__PURE__ */ new Set([...local.keys(), ...Object.keys(manifest.entries), ...Object.keys(settings.baseline)]);
    const summary = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, settings: sharedMerge.action === "upload" ? "uploaded" : sharedMerge.action === "download" ? "downloaded" : "none" };
    for (const path of [...paths].sort()) {
      const localFile = local.get(path) ?? null;
      const remoteEntry = manifest.entries[path] ?? null;
      const base = settings.baseline[path] ?? null;
      const decision = decideMerge(path, localFile?.hash ?? null, remoteEntry?.hash ?? null, base);
      switch (decision.kind) {
        case "same":
          break;
        case "upload": {
          if (!localFile) break;
          manifest.entries[path] = await this.uploadFile(client, localFile, settings.encryptionKey);
          summary.uploaded++;
          remoteChanged = true;
          break;
        }
        case "download": {
          if (!remoteEntry) break;
          await this.downloadFile(client, remoteEntry, settings.encryptionKey);
          summary.downloaded++;
          break;
        }
        case "delete-local": {
          await this.deleteLocal(path);
          summary.deleted++;
          break;
        }
        case "delete-remote": {
          delete manifest.entries[path];
          summary.deleted++;
          remoteChanged = true;
          break;
        }
        case "conflict": {
          if (!localFile) break;
          const copyPath = conflictPath(path, settings.deviceName || settings.deviceId);
          const copy = { ...localFile, path: copyPath, mtime: Date.now() };
          await this.writeLocal(copyPath, copy.data, copy.mtime);
          manifest.entries[copyPath] = await this.uploadFile(client, copy, settings.encryptionKey);
          if (remoteEntry) {
            await this.downloadFile(client, remoteEntry, settings.encryptionKey);
            summary.downloaded++;
          } else {
            await this.deleteLocal(path);
            summary.deleted++;
          }
          summary.conflicts++;
          summary.uploaded++;
          remoteChanged = true;
          break;
        }
      }
    }
    if (remoteChanged) {
      manifest.updatedAt = Date.now();
      const payload = await encryptJson(manifest, settings.encryptionKey);
      try {
        await client.putManifest(remoteResponse.version, payload);
      } catch (error) {
        if (error instanceof ConflictError) throw new Error("\u0414\u0440\u0443\u0433\u043E\u0435 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u043B\u043E\u0441\u044C \u043E\u0434\u043D\u043E\u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E. \u041F\u043E\u0432\u0442\u043E\u0440\u0438\u0442\u0435 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044E");
        throw error;
      }
    }
    settings.baseline = Object.fromEntries(Object.entries(manifest.entries).map(([path, entry]) => [path, entry.hash]));
    await this.saveSettings();
    return summary;
  }
  async readLocalFiles() {
    const result = /* @__PURE__ */ new Map();
    const configDir = (0, import_obsidian2.normalizePath)(this.app.vault.configDir);
    for (const file of this.app.vault.getFiles()) {
      if (file.path === configDir || file.path.startsWith(`${configDir}/`)) continue;
      const data = await this.app.vault.readBinary(file);
      result.set(file.path, {
        path: file.path,
        hash: await sha256(data),
        mtime: file.stat.mtime,
        size: file.stat.size,
        data
      });
    }
    return result;
  }
  async uploadFile(client, file, key) {
    const blobId = (await keyedSha256(file.data, key)).replaceAll("/", "_").replaceAll("+", "-").replace(/=+$/u, "");
    await client.putBlob(blobId, await encryptBytes(file.data, key));
    return { path: file.path, blobId, hash: file.hash, mtime: file.mtime, size: file.size };
  }
  async downloadFile(client, entry, key) {
    const data = await decryptBytes(await client.getBlob(entry.blobId), key);
    if (await sha256(data) !== entry.hash) throw new Error(`\u041F\u0440\u043E\u0432\u0435\u0440\u043A\u0430 \u0446\u0435\u043B\u043E\u0441\u0442\u043D\u043E\u0441\u0442\u0438 \u043D\u0435 \u043F\u0440\u043E\u0439\u0434\u0435\u043D\u0430: ${entry.path}`);
    await this.writeLocal(entry.path, data, entry.mtime);
  }
  async writeLocal(path, data, mtime) {
    await this.ensureParent(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian2.TFile) {
      await this.app.vault.modifyBinary(existing, data, { mtime });
    } else if (existing) {
      throw new Error(`\u041D\u0435\u0432\u043E\u0437\u043C\u043E\u0436\u043D\u043E \u0437\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0444\u0430\u0439\u043B: \u043F\u0443\u0442\u044C \u0437\u0430\u043D\u044F\u0442 \u043F\u0430\u043F\u043A\u043E\u0439 ${path}`);
    } else {
      await this.app.vault.createBinary(path, data, { mtime });
    }
  }
  async deleteLocal(path) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof import_obsidian2.TFile) await this.app.fileManager.trashFile(existing);
  }
  async ensureParent(path) {
    const segments = (0, import_obsidian2.normalizePath)(path).split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
};

// src/main.ts
var DEFAULT_SETTINGS = {
  serverUrl: "",
  vaultId: "",
  encryptionKey: "",
  deviceId: "",
  deviceName: "",
  intervalSeconds: 30,
  baseline: {},
  pairingCode: "",
  channelId: "",
  publicationEnabled: true,
  siteTitle: "\u041C\u043E\u0438 \u0437\u0430\u043C\u0435\u0442\u043A\u0438",
  publicationFolders: ["\u041F\u0443\u0431\u043B\u0438\u0447\u043D\u043E\u0435"],
  publicationRules: "",
  publicationFingerprint: "",
  sharedSettingsUpdatedAt: 0
};
var SimpleEncryptedSyncPlugin = class extends import_obsidian3.Plugin {
  constructor() {
    super(...arguments);
    this.settings = { ...DEFAULT_SETTINGS };
    this.intervalId = null;
    this.debounceId = null;
    this.statusText = "\u041D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043E";
    this.statusError = false;
  }
  async onload() {
    await this.loadSettings();
    this.statusElement = this.addStatusBarItem();
    this.engine = new SyncEngine(this.app, () => this.settings, () => this.saveSettings(), (message, error) => this.setStatus(message, Boolean(error)));
    this.settingsTab = new SyncSettingTab(this);
    this.addSettingTab(this.settingsTab);
    this.addRibbonIcon("refresh-cw", "\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C Obsidian", () => {
      void this.runSync(true);
    });
    this.addCommand({ id: "sync-now", name: "\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u0435\u0439\u0447\u0430\u0441", callback: () => {
      void this.runSync(true);
    } });
    const schedule = () => this.scheduleSync();
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));
    this.restartTimer();
    this.setStatus(this.isConfigured() ? "\u041E\u0436\u0438\u0434\u0430\u043D\u0438\u0435 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u0438" : "\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u0430");
    this.app.workspace.onLayoutReady(() => {
      if (this.isConfigured()) window.setTimeout(() => {
        void this.runSync(false);
      }, 1500);
    });
  }
  onunload() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
  }
  async loadSettings() {
    const loaded = await this.loadData();
    this.settings = { ...DEFAULT_SETTINGS, ...loaded ?? {} };
    if (!Array.isArray(loaded?.publicationFolders)) {
      const migrated = migrateLegacyPublicationRules(this.settings.publicationRules);
      this.settings.publicationFolders = migrated.folders.length ? migrated.folders : ["\u041F\u0443\u0431\u043B\u0438\u0447\u043D\u043E\u0435"];
      this.settings.publicationRules = migrated.rules;
    }
    if (!this.settings.deviceId) this.settings.deviceId = shortRandomId();
    if (!this.settings.deviceName) this.settings.deviceName = import_obsidian3.Platform.isMobileApp ? "\u0422\u0435\u043B\u0435\u0444\u043E\u043D" : "\u041A\u043E\u043C\u043F\u044C\u044E\u0442\u0435\u0440";
    if (loaded?.sharedSettingsUpdatedAt === void 0 && this.settings.publicationEnabled && this.isConfigured()) {
      this.settings.sharedSettingsUpdatedAt = Date.now();
    }
    await this.saveData(this.settings);
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async saveSharedSettings() {
    this.settings.sharedSettingsUpdatedAt = Date.now();
    this.settings.publicationFingerprint = "";
    await this.saveSettings();
  }
  isConfigured() {
    return Boolean(this.settings.serverUrl && this.settings.vaultId && this.settings.encryptionKey);
  }
  getStatus() {
    return { text: this.statusText, error: this.statusError };
  }
  setStatus(message, error = false) {
    this.statusText = message;
    this.statusError = error;
    this.statusElement.setText(`Sync: ${message}`);
    this.statusElement.toggleClass("simple-sync-danger", error);
  }
  async runSync(showNotice) {
    if (!this.isConfigured()) {
      if (showNotice) new import_obsidian3.Notice("\u0421\u043D\u0430\u0447\u0430\u043B\u0430 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u0442\u0435 Simple Encrypted Sync");
      return;
    }
    try {
      const result = await this.engine.sync();
      if (result && this.settings.publicationEnabled) await this.publishSnapshot();
      if (showNotice && result) {
        const settingsText = result.settings === "downloaded" ? ", \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u044B" : result.settings === "uploaded" ? ", \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u044B" : "";
        new import_obsidian3.Notice(`\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D\u0430. \u0417\u0430\u0433\u0440\u0443\u0436\u0435\u043D\u043E: ${result.uploaded}, \u0441\u043A\u0430\u0447\u0430\u043D\u043E: ${result.downloaded}, \u043A\u043E\u043D\u0444\u043B\u0438\u043A\u0442\u043E\u0432: ${result.conflicts}${settingsText}`);
      }
    } catch (error) {
      if (showNotice) new import_obsidian3.Notice(error instanceof Error ? error.message : String(error), 8e3);
    }
  }
  getViewerUrl() {
    return `${this.settings.serverUrl}/view/${encodeURIComponent(this.settings.vaultId)}/`;
  }
  async publishSnapshot(force = false) {
    if (!this.isConfigured()) return;
    const parsed = await parsePublicationRules(this.settings.publicationRules);
    const publicRules = this.settings.publicationFolders.map((path) => ({ path: normalizeRulePath(path), mode: "public" }));
    const rules = deduplicateRules([...publicRules, ...parsed.rules]);
    const files = [];
    const fingerprints = [];
    for (const file of this.app.vault.getFiles()) {
      const rule = matchingRule(file.path, rules);
      if (!rule || rule.mode === "private") continue;
      const data = await this.app.vault.readBinary(file);
      files.push({
        path: file.path,
        content: bytesToBase64(new Uint8Array(data)),
        mtime: file.stat.mtime,
        kind: file.extension.toLowerCase() === "md" ? "markdown" : "asset"
      });
      fingerprints.push(`${file.path}:${await sha256(data)}`);
    }
    const fingerprintSource = new TextEncoder().encode(JSON.stringify({ title: this.settings.siteTitle, rules, files: fingerprints.sort() }));
    const fingerprint = await sha256(fingerprintSource.buffer);
    if (!force && fingerprint === this.settings.publicationFingerprint) return;
    const snapshot = {
      format: 1,
      siteTitle: this.settings.siteTitle.trim() || "\u041C\u043E\u0438 \u0437\u0430\u043C\u0435\u0442\u043A\u0438",
      updatedAt: Date.now(),
      rules,
      files
    };
    const client = await RemoteClient.create(this.settings.serverUrl, this.settings.vaultId, this.settings.encryptionKey);
    await client.putPublication(snapshot);
    this.settings.publicationFingerprint = fingerprint;
    await this.saveSettings();
  }
  restartTimer() {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    const seconds = Math.max(10, this.settings.intervalSeconds || 30);
    this.intervalId = window.setInterval(() => {
      void this.runSync(false);
    }, seconds * 1e3);
  }
  scheduleSync() {
    if (!this.isConfigured()) return;
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.debounceId = window.setTimeout(() => {
      void this.runSync(false);
    }, 2e3);
  }
  async createRemoteVault(serverValue) {
    const serverUrl = normalizeServer(serverValue);
    const vaultId = shortRandomId(16);
    const encryptionKey = randomBase64(32);
    const client = await RemoteClient.create(serverUrl, vaultId, encryptionKey);
    await client.ping();
    await client.createVault();
    const payload = { version: 1, serverUrl, vaultId, encryptionKey };
    this.settings.serverUrl = serverUrl;
    this.settings.vaultId = vaultId;
    this.settings.encryptionKey = encryptionKey;
    this.settings.pairingCode = encodePairingCode(payload);
    this.settings.channelId = "";
    this.settings.baseline = {};
    this.settings.publicationEnabled = true;
    this.settings.publicationFingerprint = "";
    this.settings.sharedSettingsUpdatedAt = Date.now();
    await this.saveSettings();
    this.restartTimer();
    this.setStatus("\u0425\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 \u0441\u043E\u0437\u0434\u0430\u043D\u043E");
    await this.runSync(false);
  }
  async joinWithCode(code) {
    const payload = decodePairingCode(code);
    if (payload.version !== 1 || !payload.serverUrl || !payload.vaultId || !payload.encryptionKey) throw new Error("\u041D\u0435\u043A\u043E\u0440\u0440\u0435\u043A\u0442\u043D\u044B\u0439 \u043A\u043E\u0434 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F");
    const serverUrl = normalizeServer(payload.serverUrl);
    const client = await RemoteClient.create(serverUrl, payload.vaultId, payload.encryptionKey);
    await client.getManifest();
    this.settings.serverUrl = serverUrl;
    this.settings.vaultId = payload.vaultId;
    this.settings.encryptionKey = payload.encryptionKey;
    this.settings.pairingCode = code.trim();
    this.settings.channelId = "";
    this.settings.baseline = {};
    this.settings.publicationEnabled = false;
    this.settings.publicationFingerprint = "";
    this.settings.sharedSettingsUpdatedAt = 0;
    await this.saveSettings();
    this.restartTimer();
    this.setStatus("\u0423\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E");
    await this.runSync(false);
  }
  async connectToChannel(serverValue, channelValue) {
    const serverUrl = normalizeServer(serverValue);
    const channelId = normalizeChannelId(channelValue);
    const connection = await deriveChannelConnection(channelId);
    const client = await RemoteClient.create(serverUrl, connection.vaultId, connection.encryptionKey);
    await client.ping();
    const remote = await client.getManifest();
    this.settings.serverUrl = serverUrl;
    this.settings.vaultId = connection.vaultId;
    this.settings.encryptionKey = connection.encryptionKey;
    this.settings.channelId = channelId;
    this.settings.pairingCode = "";
    this.settings.baseline = {};
    this.settings.publicationFingerprint = "";
    this.settings.sharedSettingsUpdatedAt = remote.payload ? 0 : Date.now();
    await this.saveSettings();
    this.restartTimer();
    this.setStatus("\u041A\u0430\u043D\u0430\u043B \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D");
    await this.runSync(false);
  }
  async disconnect() {
    this.settings = {
      ...this.settings,
      serverUrl: "",
      vaultId: "",
      encryptionKey: "",
      pairingCode: "",
      channelId: "",
      baseline: {}
    };
    await this.saveSettings();
    this.setStatus("\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u0430");
  }
};
var SyncSettingTab = class extends import_obsidian3.PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
    this.serverDraft = "";
    this.channelDraft = "";
    this.codeDraft = "";
    this.serverDraft = plugin.settings.serverUrl;
  }
  getSettingDefinitions() {
    const status = this.plugin.getStatus();
    const statusDefinition = renderSetting("\u0421\u043E\u0441\u0442\u043E\u044F\u043D\u0438\u0435 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u0438", status.text, (setting) => {
      setting.setClass("simple-sync-status");
      setting.settingEl.toggleClass("simple-sync-danger", status.error);
    });
    if (!this.plugin.isConfigured()) {
      return [
        { type: "group", heading: "Simple Encrypted Sync", items: [statusDefinition] },
        {
          type: "group",
          heading: "\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\u0441\u044F \u043A \u043A\u0430\u043D\u0430\u043B\u0443 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u0438",
          items: [
            renderSetting("\u0410\u0434\u0440\u0435\u0441 \u0441\u0435\u0440\u0432\u0435\u0440\u0430", "\u041E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u044D\u0442\u043E\u0442 \u0430\u0434\u0440\u0435\u0441 \u0432 \u0431\u0440\u0430\u0443\u0437\u0435\u0440\u0435, \u0441\u043E\u0437\u0434\u0430\u0439\u0442\u0435 \u043A\u0430\u043D\u0430\u043B \u0438 \u0441\u043A\u043E\u043F\u0438\u0440\u0443\u0439\u0442\u0435 \u0435\u0433\u043E ID", (setting) => {
              setting.addText((text) => text.setPlaceholder("https://sync.example.ru").setValue(this.serverDraft).onChange((value) => {
                this.serverDraft = value;
              }));
            }),
            renderSetting("ID \u043A\u0430\u043D\u0430\u043B\u0430", "\u041E\u0434\u0438\u043D \u0438 \u0442\u043E\u0442 \u0436\u0435 \u0441\u0435\u043A\u0440\u0435\u0442\u043D\u044B\u0439 ID \u0432\u0432\u043E\u0434\u0438\u0442\u0441\u044F \u043D\u0430 \u043A\u043E\u043C\u043F\u044C\u044E\u0442\u0435\u0440\u0435 \u0438 \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0435", (setting) => {
              setting.addTextArea((area) => area.setPlaceholder("\u0412\u0441\u0442\u0430\u0432\u044C\u0442\u0435 ID \u043A\u0430\u043D\u0430\u043B\u0430").setValue(this.channelDraft).onChange((value) => {
                this.channelDraft = value;
              })).addButton((button) => button.setButtonText("\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C").setCta().onClick(async () => {
                button.setDisabled(true);
                try {
                  await this.plugin.connectToChannel(this.serverDraft, this.channelDraft);
                  new import_obsidian3.Notice("\u041A\u0430\u043D\u0430\u043B \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0451\u043D");
                  this.update();
                } catch (error) {
                  new import_obsidian3.Notice(error instanceof Error ? error.message : String(error), 8e3);
                } finally {
                  button.setDisabled(false);
                }
              }));
            })
          ]
        },
        {
          type: "group",
          heading: "\u0421\u043E\u0432\u043C\u0435\u0441\u0442\u0438\u043C\u043E\u0441\u0442\u044C \u0441\u043E \u0441\u0442\u0430\u0440\u044B\u043C\u0438 \u0432\u0435\u0440\u0441\u0438\u044F\u043C\u0438",
          items: [renderSetting("\u041A\u043E\u0434 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F", "\u0421\u043A\u043E\u043F\u0438\u0440\u0443\u0439\u0442\u0435 \u043A\u043E\u0434 \u0441 \u0443\u0436\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u043E\u0433\u043E \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430", (setting) => {
            setting.setClass("simple-sync-code").addTextArea((area) => area.setPlaceholder("\u0412\u0441\u0442\u0430\u0432\u044C\u0442\u0435 \u043A\u043E\u0434").setValue(this.codeDraft).onChange((value) => {
              this.codeDraft = value;
            })).addButton((button) => button.setButtonText("\u041F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C").setCta().onClick(async () => {
              button.setDisabled(true);
              try {
                await this.plugin.joinWithCode(this.codeDraft);
                new import_obsidian3.Notice("\u0423\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043E");
                this.update();
              } catch (error) {
                new import_obsidian3.Notice(error instanceof Error ? error.message : String(error), 8e3);
              } finally {
                button.setDisabled(false);
              }
            }));
          })]
        }
      ];
    }
    const connectionSecret = this.plugin.settings.channelId || this.plugin.settings.pairingCode;
    return [
      {
        type: "group",
        heading: "Simple Encrypted Sync",
        items: [
          statusDefinition,
          renderSetting("\u0418\u043C\u044F \u044D\u0442\u043E\u0433\u043E \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430", "\u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u0432 \u043D\u0430\u0437\u0432\u0430\u043D\u0438\u044F\u0445 conflict-\u043A\u043E\u043F\u0438\u0439", (setting) => {
            setting.addText((text) => text.setValue(this.plugin.settings.deviceName).onChange(async (value) => {
              this.plugin.settings.deviceName = value.trim() || (import_obsidian3.Platform.isMobileApp ? "\u0422\u0435\u043B\u0435\u0444\u043E\u043D" : "\u041A\u043E\u043C\u043F\u044C\u044E\u0442\u0435\u0440");
              await this.plugin.saveSettings();
            }));
          })
        ]
      },
      {
        type: "group",
        heading: "\u0412\u0435\u0431-\u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0449\u0438\u043A (\u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0442\u0435\u043D\u0438\u0435)",
        items: [
          renderSetting("\u041F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0432\u044B\u0431\u0440\u0430\u043D\u043D\u044B\u0435 \u0437\u0430\u043C\u0435\u0442\u043A\u0438", "\u041E\u0441\u043D\u043E\u0432\u043D\u043E\u0435 \u0437\u0430\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u043D\u043E\u0435 \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0435 \u043F\u0440\u0438 \u044D\u0442\u043E\u043C \u043E\u0441\u0442\u0430\u0451\u0442\u0441\u044F \u0437\u0430\u043A\u0440\u044B\u0442\u044B\u043C", (setting) => {
            setting.addToggle((toggle) => toggle.setValue(this.plugin.settings.publicationEnabled).onChange(async (value) => {
              this.plugin.settings.publicationEnabled = value;
              await this.plugin.saveSharedSettings();
            }));
          }),
          renderSetting("\u041D\u0430\u0437\u0432\u0430\u043D\u0438\u0435 \u0441\u0430\u0439\u0442\u0430", void 0, (setting) => {
            setting.addText((text) => text.setValue(this.plugin.settings.siteTitle).onChange(async (value) => {
              this.plugin.settings.siteTitle = value;
              await this.plugin.saveSharedSettings();
            }));
          }),
          renderSetting("\u041F\u0430\u043F\u043A\u0438 \u0434\u043B\u044F \u043F\u0443\u0431\u043B\u0438\u0447\u043D\u043E\u0433\u043E \u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0430", publicationFoldersDescription(this.plugin.settings.publicationFolders), (setting) => {
            setting.addButton((button) => button.setButtonText("\u0412\u044B\u0431\u0440\u0430\u0442\u044C \u043F\u0430\u043F\u043A\u0438").setCta().onClick(() => {
              new PublicationFoldersModal(this.plugin, () => this.update()).open();
            }));
          }),
          renderSetting("\u0414\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0435 \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u0434\u043E\u0441\u0442\u0443\u043F\u0430", "\u041D\u0435\u043E\u0431\u044F\u0437\u0430\u0442\u0435\u043B\u044C\u043D\u043E. \u0424\u043E\u0440\u043C\u0430\u0442: link | \u041F\u0430\u043F\u043A\u0430 | \u0441\u0435\u043A\u0440\u0435\u0442 \u0438\u043B\u0438 private | \u041F\u0430\u043F\u043A\u0430/\u0424\u0430\u0439\u043B.md. \u041F\u0443\u0431\u043B\u0438\u0447\u043D\u044B\u0435 \u043F\u0430\u043F\u043A\u0438 \u0432\u044B\u0431\u0438\u0440\u0430\u044E\u0442\u0441\u044F \u043A\u043D\u043E\u043F\u043A\u043E\u0439 \u0432\u044B\u0448\u0435", (setting) => {
            setting.setClass("simple-sync-code").addTextArea((area) => area.setValue(this.plugin.settings.publicationRules).onChange(async (value) => {
              this.plugin.settings.publicationRules = value;
              await this.plugin.saveSharedSettings();
            }));
          }),
          renderSetting("\u0410\u0434\u0440\u0435\u0441 \u043F\u0440\u043E\u0441\u043C\u043E\u0442\u0440\u0449\u0438\u043A\u0430", this.plugin.getViewerUrl(), (setting) => {
            setting.addButton((button) => button.setButtonText("\u041E\u0442\u043A\u0440\u044B\u0442\u044C").onClick(() => {
              window.open(this.plugin.getViewerUrl());
            })).addButton((button) => button.setButtonText("\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C").onClick(async () => {
              await navigator.clipboard.writeText(this.plugin.getViewerUrl());
              new import_obsidian3.Notice("\u0421\u0441\u044B\u043B\u043A\u0430 \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D\u0430");
            }));
          }),
          renderSetting("\u041E\u0431\u043D\u043E\u0432\u0438\u0442\u044C \u0432\u0435\u0431-\u043A\u043E\u043F\u0438\u044E", "\u0414\u043B\u044F \u0437\u0430\u043A\u0440\u044B\u0442\u043E\u0439 \u043F\u0430\u043F\u043A\u0438 \u0434\u043E\u0431\u0430\u0432\u044C\u0442\u0435 \u043A \u0430\u0434\u0440\u0435\u0441\u0443 ?key=\u0432\u0430\u0448-\u0441\u0435\u043A\u0440\u0435\u0442", (setting) => {
            setting.addButton((button) => button.setButtonText("\u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C").setCta().onClick(async () => {
              button.setDisabled(true);
              try {
                await this.plugin.publishSnapshot(true);
                new import_obsidian3.Notice("\u0412\u0435\u0431-\u043A\u043E\u043F\u0438\u044F \u043E\u0431\u043D\u043E\u0432\u043B\u0435\u043D\u0430");
              } catch (error) {
                new import_obsidian3.Notice(error instanceof Error ? error.message : String(error), 8e3);
              } finally {
                button.setDisabled(false);
              }
            }));
          })
        ]
      },
      {
        type: "group",
        heading: "\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u044F",
        items: [
          renderSetting("\u0418\u043D\u0442\u0435\u0440\u0432\u0430\u043B \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u0438", "\u041D\u0435 \u0440\u0435\u0436\u0435 10 \u0441\u0435\u043A\u0443\u043D\u0434", (setting) => {
            setting.addText((text) => text.setValue(String(this.plugin.settings.intervalSeconds)).onChange(async (value) => {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) this.plugin.settings.intervalSeconds = Math.max(10, Math.round(parsed));
              await this.plugin.saveSettings();
              this.plugin.restartTimer();
            }));
          }),
          renderSetting("\u0421\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u0442\u044C \u0441\u0435\u0439\u0447\u0430\u0441", void 0, (setting) => {
            setting.addButton((button) => button.setButtonText("\u0417\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C").setCta().onClick(async () => {
              await this.plugin.runSync(true);
            }));
          }),
          renderSetting(this.plugin.settings.channelId ? "ID \u043A\u0430\u043D\u0430\u043B\u0430 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0430\u0446\u0438\u0438" : "\u0421\u0442\u0430\u0440\u044B\u0439 \u043A\u043E\u0434 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F", "\u042D\u0442\u043E \u0441\u0435\u043A\u0440\u0435\u0442: \u043B\u044E\u0431\u043E\u0439, \u043A\u0442\u043E \u0435\u0433\u043E \u043F\u043E\u043B\u0443\u0447\u0438\u0442, \u0441\u043C\u043E\u0436\u0435\u0442 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0438\u0442\u044C\u0441\u044F \u043A \u0437\u0430\u0448\u0438\u0444\u0440\u043E\u0432\u0430\u043D\u043D\u043E\u043C\u0443 \u0445\u0440\u0430\u043D\u0438\u043B\u0438\u0449\u0443", (setting) => {
            setting.setClass("simple-sync-code").addTextArea((area) => area.setValue(connectionSecret).setDisabled(true)).addButton((button) => button.setButtonText("\u041A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u0442\u044C").onClick(async () => {
              await navigator.clipboard.writeText(connectionSecret);
              new import_obsidian3.Notice(this.plugin.settings.channelId ? "ID \u043A\u0430\u043D\u0430\u043B\u0430 \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D" : "\u041A\u043E\u0434 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u0441\u043A\u043E\u043F\u0438\u0440\u043E\u0432\u0430\u043D");
            }));
          }),
          renderSetting("\u041E\u0442\u043A\u043B\u044E\u0447\u0438\u0442\u044C \u044D\u0442\u043E \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E", "\u041B\u043E\u043A\u0430\u043B\u044C\u043D\u044B\u0435 \u0437\u0430\u043C\u0435\u0442\u043A\u0438 \u043E\u0441\u0442\u0430\u043D\u0443\u0442\u0441\u044F \u043D\u0430 \u043C\u0435\u0441\u0442\u0435", (setting) => {
            setting.addButton((button) => button.setButtonText("\u041E\u0442\u043A\u043B\u044E\u0447\u0438\u0442\u044C").setDestructive().onClick(async () => {
              await this.plugin.disconnect();
              this.update();
            }));
          })
        ]
      }
    ];
  }
};
function renderSetting(name, desc, render) {
  return {
    name,
    ...desc === void 0 ? {} : { desc },
    render: (setting) => {
      setting.setName(name);
      if (desc !== void 0) setting.setDesc(desc);
      render(setting);
    }
  };
}
var PublicationFoldersModal = class extends import_obsidian3.Modal {
  constructor(syncPlugin, onSaved) {
    super(syncPlugin.app);
    this.syncPlugin = syncPlugin;
    this.onSaved = onSaved;
    this.selected = new Set(syncPlugin.settings.publicationFolders);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("simple-sync-folder-modal");
    new import_obsidian3.Setting(contentEl).setName("\u041F\u0430\u043F\u043A\u0438 \u0434\u043B\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438").setHeading();
    contentEl.createEl("p", { text: "\u0412\u044B\u0431\u0440\u0430\u043D\u043D\u0430\u044F \u043F\u0430\u043F\u043A\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442\u0441\u044F \u0432\u043C\u0435\u0441\u0442\u0435 \u0441\u043E \u0432\u0441\u0435\u043C\u0438 \u043F\u043E\u0434\u043F\u0430\u043F\u043A\u0430\u043C\u0438. \u0417\u0430\u043A\u0440\u044B\u0442\u044B\u0435 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u044F \u043C\u043E\u0436\u043D\u043E \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0432 \u0434\u043E\u043F\u043E\u043B\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0445 \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u0445.", cls: "setting-item-description" });
    const configDir = (0, import_obsidian3.normalizePath)(this.syncPlugin.app.vault.configDir);
    const folders = this.syncPlugin.app.vault.getAllLoadedFiles().filter((item) => item instanceof import_obsidian3.TFolder && item.path !== configDir && !item.path.startsWith(`${configDir}/`)).sort((left, right) => left.path.localeCompare(right.path, "ru", { numeric: true }));
    const list = contentEl.createDiv({ cls: "simple-sync-folder-list" });
    this.addFolderToggle(list, "", "\u0412\u0435\u0441\u044C vault", 0);
    for (const folder of folders) {
      const depth = folder.path.split("/").length - 1;
      this.addFolderToggle(list, folder.path, folder.name, depth);
    }
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "\u041E\u0442\u043C\u0435\u043D\u0430" });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "\u0421\u043E\u0445\u0440\u0430\u043D\u0438\u0442\u044C", cls: "mod-cta" });
    save.addEventListener("click", () => {
      void (async () => {
        this.syncPlugin.settings.publicationFolders = [...this.selected].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
        await this.syncPlugin.saveSharedSettings();
        this.close();
        this.onSaved();
        new import_obsidian3.Notice("\u041F\u0430\u043F\u043A\u0438 \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u044B \u0438 \u0431\u0443\u0434\u0443\u0442 \u0441\u0438\u043D\u0445\u0440\u043E\u043D\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u043D\u044B");
      })();
    });
  }
  onClose() {
    this.contentEl.empty();
  }
  addFolderToggle(container, path, label, depth) {
    const setting = new import_obsidian3.Setting(container).setName(label).setDesc(path || "\u041F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0432\u0441\u0435 \u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B\u0435 \u0444\u0430\u0439\u043B\u044B").addToggle((toggle) => toggle.setValue(this.selected.has(path)).onChange((value) => {
      if (value) this.selected.add(path);
      else this.selected.delete(path);
    }));
    setting.settingEl.style.paddingLeft = `${Math.min(depth, 6) * 18 + 8}px`;
  }
};
function shortRandomId(size = 9) {
  return randomBase64(size).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function publicationFoldersDescription(folders) {
  if (!folders.length) return "\u041F\u0443\u0431\u043B\u0438\u0447\u043D\u044B\u0435 \u043F\u0430\u043F\u043A\u0438 \u043D\u0435 \u0432\u044B\u0431\u0440\u0430\u043D\u044B";
  if (folders.includes("")) return "\u0412\u044B\u0431\u0440\u0430\u043D \u0432\u0435\u0441\u044C vault";
  const preview = folders.slice(0, 3).join(", ");
  return folders.length > 3 ? `${preview} \u0438 \u0435\u0449\u0451 ${folders.length - 3}` : preview;
}
function migrateLegacyPublicationRules(source) {
  const folders = [];
  const remaining = [];
  for (const raw of String(source || "").split(/\r?\n/u)) {
    const parts = raw.split("|").map((value) => value.trim());
    if (parts[0] === "public") folders.push(normalizeRulePath(parts[1] ?? ""));
    else if (raw.trim()) remaining.push(raw);
  }
  return { folders: [...new Set(folders)], rules: remaining.join("\n") };
}
function deduplicateRules(rules) {
  const result = /* @__PURE__ */ new Map();
  for (const rule of rules) result.set(`${rule.mode}:${rule.path}:${rule.keyHash || ""}`, rule);
  return [...result.values()];
}
async function parsePublicationRules(source) {
  const rules = [];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map((value) => value.trim());
    const mode = parts[0];
    if (mode !== "public" && mode !== "link" && mode !== "private") throw new Error(`\u0421\u0442\u0440\u043E\u043A\u0430 ${index + 1}: \u0440\u0435\u0436\u0438\u043C \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C public, link \u0438\u043B\u0438 private`);
    const path = normalizeRulePath(parts[1] ?? "");
    const rule = { path, mode };
    if (mode === "link") {
      if (!parts[2]) throw new Error(`\u0421\u0442\u0440\u043E\u043A\u0430 ${index + 1}: \u0434\u043B\u044F link \u043D\u0443\u0436\u0435\u043D \u0441\u0435\u043A\u0440\u0435\u0442`);
      rule.keyHash = await sha256(new TextEncoder().encode(parts[2]).buffer);
    }
    rules.push(rule);
  }
  return { rules };
}
function normalizeRulePath(path) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized.split("/").includes("..")) throw new Error("\u041F\u0443\u0442\u044C \u043F\u0440\u0430\u0432\u0438\u043B\u0430 \u043D\u0435 \u043C\u043E\u0436\u0435\u0442 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C ..");
  return normalized;
}
function matchingRule(path, rules) {
  const candidates = rules.filter((rule) => !rule.path || path === rule.path || path.startsWith(`${rule.path}/`));
  candidates.sort((a, b) => b.path.length - a.path.length || (a.mode === "private" ? -1 : 1));
  return candidates[0] ?? null;
}
