export interface RemoteEntry {
  path: string;
  blobId: string;
  hash: string;
  mtime: number;
  size: number;
}

export interface VaultManifest {
  format: 1;
  updatedAt: number;
  entries: Record<string, RemoteEntry>;
}

export interface LocalFile {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  data: ArrayBuffer;
}

export interface SyncSettings {
  serverUrl: string;
  vaultId: string;
  encryptionKey: string;
  deviceId: string;
  deviceName: string;
  intervalSeconds: number;
  baseline: Record<string, string>;
  pairingCode: string;
  publicationEnabled: boolean;
  siteTitle: string;
  publicationRules: string;
  publicationFingerprint: string;
}

export interface PairingPayload {
  version: 1;
  serverUrl: string;
  vaultId: string;
  encryptionKey: string;
}

export type PublicationMode = "public" | "link" | "private";

export interface PublicationRule {
  path: string;
  mode: PublicationMode;
  keyHash?: string;
}

export interface PublishedFile {
  path: string;
  content: string;
  mtime: number;
  kind: "markdown" | "asset";
}

export interface PublicationSnapshot {
  format: 1;
  siteTitle: string;
  updatedAt: number;
  rules: PublicationRule[];
  files: PublishedFile[];
}

export type MergeDecision =
  | { kind: "same"; path: string }
  | { kind: "upload"; path: string }
  | { kind: "download"; path: string }
  | { kind: "delete-local"; path: string }
  | { kind: "delete-remote"; path: string }
  | { kind: "conflict"; path: string };
