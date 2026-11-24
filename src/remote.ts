import { requestUrl } from "obsidian";
import { deriveAuthToken } from "./crypto";

export class ConflictError extends Error {}

export interface ManifestResponse {
  version: number;
  payload: string | null;
}

export class RemoteClient {
  private constructor(
    private readonly baseUrl: string,
    private readonly vaultId: string,
    private readonly token: string
  ) {}

  static async create(baseUrl: string, vaultId: string, encryptionKey: string): Promise<RemoteClient> {
    return new RemoteClient(normalizeServer(baseUrl), vaultId, await deriveAuthToken(encryptionKey, vaultId));
  }

  private headers(contentType?: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      ...(contentType ? { "Content-Type": contentType } : {})
    };
  }

  async createVault(): Promise<void> {
    await requestUrl({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}`,
      method: "POST",
      headers: this.headers("application/json"),
      body: "{}",
      throw: true
    });
  }

  async ping(): Promise<void> {
    await requestUrl({ url: `${this.baseUrl}/health`, method: "GET", throw: true });
  }

  async getManifest(): Promise<ManifestResponse> {
    const response = await requestUrl({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/manifest`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status === 404) return { version: 0, payload: null };
    if (response.status === 401 || response.status === 403) throw new Error("Сервер отклонил ключ синхронизации");
    if (response.status !== 200) throw new Error(`Не удалось получить состояние сервера (${response.status})`);
    const parsed = response.json as { version?: unknown; payload?: unknown };
    if (typeof parsed.version !== "number" || typeof parsed.payload !== "string") {
      throw new Error("Сервер вернул некорректный манифест");
    }
    return { version: parsed.version, payload: parsed.payload };
  }

  async putManifest(expectedVersion: number, payload: string): Promise<number> {
    const response = await requestUrl({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/manifest`,
      method: "PUT",
      headers: { ...this.headers("application/json"), "If-Match": String(expectedVersion) },
      body: JSON.stringify({ payload }),
      throw: false
    });
    if (response.status === 409 || response.status === 412) throw new ConflictError("Манифест уже изменён другим устройством");
    if (response.status !== 200) throw new Error(`Не удалось сохранить состояние сервера (${response.status})`);
    const parsed = response.json as { version?: unknown };
    if (typeof parsed.version !== "number") throw new Error("Сервер не вернул версию манифеста");
    return parsed.version;
  }

  async putBlob(blobId: string, encrypted: ArrayBuffer): Promise<void> {
    const response = await requestUrl({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      method: "PUT",
      headers: this.headers("application/octet-stream"),
      body: encrypted,
      throw: false
    });
    if (response.status !== 200 && response.status !== 201) throw new Error(`Не удалось загрузить файл (${response.status})`);
  }

  async getBlob(blobId: string): Promise<ArrayBuffer> {
    const response = await requestUrl({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/blobs/${encodeURIComponent(blobId)}`,
      method: "GET",
      headers: this.headers(),
      throw: false
    });
    if (response.status !== 200) throw new Error(`Не удалось скачать файл (${response.status})`);
    return response.arrayBuffer;
  }

  async putPublication(snapshot: unknown): Promise<void> {
    const response = await requestUrl({
      url: `${this.baseUrl}/v1/vaults/${encodeURIComponent(this.vaultId)}/publication`,
      method: "PUT",
      headers: this.headers("application/json"),
      body: JSON.stringify(snapshot),
      throw: false
    });
    if (response.status !== 200) throw new Error(`Не удалось обновить веб-витрину (${response.status})`);
  }
}

export function normalizeServer(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Адрес сервера должен начинаться с http:// или https://");
  return parsed.toString().replace(/\/+$/u, "");
}
