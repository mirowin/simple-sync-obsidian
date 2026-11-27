import { App, normalizePath, TFile } from "obsidian";
import { decryptBytes, decryptJson, encryptBytes, encryptJson, keyedSha256, sha256 } from "./crypto";
import { conflictPath, decideMerge } from "./merge";
import { ConflictError, RemoteClient } from "./remote";
import { isSharedSettingsEnvelope, mergeSharedSettings } from "./shared-settings";
import type { LocalFile, RemoteEntry, SyncSettings, VaultManifest } from "./types";

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deleted: number;
  conflicts: number;
  settings: "none" | "uploaded" | "downloaded";
}

export class SyncEngine {
  private running = false;

  constructor(
    private readonly app: App,
    private readonly getSettings: () => SyncSettings,
    private readonly saveSettings: () => Promise<void>,
    private readonly onStatus: (message: string, error?: boolean) => void
  ) {}

  async sync(): Promise<SyncSummary | null> {
    if (this.running) return null;
    const settings = this.getSettings();
    if (!settings.serverUrl || !settings.vaultId || !settings.encryptionKey) return null;
    this.running = true;
    this.onStatus("Синхронизация…");
    try {
      const result = await this.syncAttempt(settings);
      this.onStatus(`Синхронизировано: ↑${result.uploaded} ↓${result.downloaded}, конфликтов: ${result.conflicts}`);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.onStatus(`Ошибка: ${message}`, true);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async syncAttempt(settings: SyncSettings): Promise<SyncSummary> {
    const client = await RemoteClient.create(settings.serverUrl, settings.vaultId, settings.encryptionKey);
    const remoteResponse = await client.getManifest();
    const manifest: VaultManifest = remoteResponse.payload
      ? await decryptJson<VaultManifest>(remoteResponse.payload, settings.encryptionKey)
      : { format: 1, updatedAt: Date.now(), entries: {} };
    if (manifest.format !== 1 || !manifest.entries) throw new Error("Неподдерживаемый формат удалённого хранилища");

    let remoteChanged = false;
    const sharedMerge = mergeSharedSettings(settings, isSharedSettingsEnvelope(manifest.sharedSettings) ? manifest.sharedSettings : undefined);
    if (sharedMerge.action === "upload") {
      manifest.sharedSettings = sharedMerge.remote;
      remoteChanged = true;
    }

    const local = await this.readLocalFiles();
    const paths = new Set([...local.keys(), ...Object.keys(manifest.entries), ...Object.keys(settings.baseline)]);
    const summary: SyncSummary = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, settings: sharedMerge.action === "upload" ? "uploaded" : sharedMerge.action === "download" ? "downloaded" : "none" };

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
          const copy: LocalFile = { ...localFile, path: copyPath, mtime: Date.now() };
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
        if (error instanceof ConflictError) throw new Error("Другое устройство синхронизировалось одновременно. Повторите синхронизацию");
        throw error;
      }
    }

    settings.baseline = Object.fromEntries(Object.entries(manifest.entries).map(([path, entry]) => [path, entry.hash]));
    await this.saveSettings();
    return summary;
  }

  private async readLocalFiles(): Promise<Map<string, LocalFile>> {
    const result = new Map<string, LocalFile>();
    const configDir = normalizePath(this.app.vault.configDir);
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

  private async uploadFile(client: RemoteClient, file: LocalFile, key: string): Promise<RemoteEntry> {
    const blobId = (await keyedSha256(file.data, key)).replaceAll("/", "_").replaceAll("+", "-").replace(/=+$/u, "");
    await client.putBlob(blobId, await encryptBytes(file.data, key));
    return { path: file.path, blobId, hash: file.hash, mtime: file.mtime, size: file.size };
  }

  private async downloadFile(client: RemoteClient, entry: RemoteEntry, key: string): Promise<void> {
    const data = await decryptBytes(await client.getBlob(entry.blobId), key);
    if (await sha256(data) !== entry.hash) throw new Error(`Проверка целостности не пройдена: ${entry.path}`);
    await this.writeLocal(entry.path, data, entry.mtime);
  }

  private async writeLocal(path: string, data: ArrayBuffer, mtime: number): Promise<void> {
    await this.ensureParent(path);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, data, { mtime });
    } else if (existing) {
      throw new Error(`Невозможно записать файл: путь занят папкой ${path}`);
    } else {
      await this.app.vault.createBinary(path, data, { mtime });
    }
  }

  private async deleteLocal(path: string): Promise<void> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.fileManager.trashFile(existing);
  }

  private async ensureParent(path: string): Promise<void> {
    const segments = normalizePath(path).split("/").slice(0, -1);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }
}
