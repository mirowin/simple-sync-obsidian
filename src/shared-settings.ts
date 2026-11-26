import type { SharedSettingsEnvelope, SyncSettings } from "./types";

export type SharedSettingsMerge =
  | { action: "none"; remote: SharedSettingsEnvelope | undefined }
  | { action: "upload"; remote: SharedSettingsEnvelope }
  | { action: "download"; remote: SharedSettingsEnvelope };

export function isSharedSettingsEnvelope(value: unknown): value is SharedSettingsEnvelope {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SharedSettingsEnvelope>;
  return Number.isFinite(candidate.updatedAt)
    && typeof candidate.updatedBy === "string"
    && Boolean(candidate.value && typeof candidate.value === "object");
}

export function mergeSharedSettings(settings: SyncSettings, remote: SharedSettingsEnvelope | undefined): SharedSettingsMerge {
  const local = settings.sharedSettingsUpdatedAt > 0 ? createSharedSettingsEnvelope(settings) : undefined;
  if (!remote) return local ? { action: "upload", remote: local } : { action: "none", remote };
  if (!local || compareEnvelope(remote, local) > 0) {
    applySharedSettings(settings, remote);
    return { action: "download", remote };
  }
  if (compareEnvelope(local, remote) > 0) return { action: "upload", remote: local };
  return { action: "none", remote };
}

export function createSharedSettingsEnvelope(settings: SyncSettings): SharedSettingsEnvelope {
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

export function applySharedSettings(settings: SyncSettings, envelope: SharedSettingsEnvelope): void {
  settings.publicationEnabled = Boolean(envelope.value.publicationEnabled);
  settings.siteTitle = String(envelope.value.siteTitle || "Мои заметки");
  settings.publicationFolders = Array.isArray(envelope.value.publicationFolders)
    ? [...new Set(envelope.value.publicationFolders.map(normalizeSharedPath))].sort((a, b) => a.localeCompare(b, "ru"))
    : [];
  settings.publicationRules = String(envelope.value.publicationRules || "");
  settings.sharedSettingsUpdatedAt = envelope.updatedAt;
  settings.publicationFingerprint = "";
}

function compareEnvelope(left: SharedSettingsEnvelope, right: SharedSettingsEnvelope): number {
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt;
  return left.updatedBy.localeCompare(right.updatedBy);
}

function normalizeSharedPath(value: unknown): string {
  return String(value).replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
}
