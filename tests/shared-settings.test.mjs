import test from "node:test";
import assert from "node:assert/strict";
import { deriveChannelConnection, normalizeChannelId } from "../src/crypto.ts";
import { mergeSharedSettings } from "../src/shared-settings.ts";

function settings(overrides = {}) {
  return {
    serverUrl: "https://sync.example",
    vaultId: "vault",
    encryptionKey: "key",
    deviceId: "device-a",
    deviceName: "Компьютер",
    intervalSeconds: 30,
    baseline: {},
    pairingCode: "",
    channelId: "",
    publicationEnabled: true,
    siteTitle: "Мои заметки",
    publicationFolders: ["Публичное"],
    publicationRules: "",
    publicationFingerprint: "fingerprint",
    sharedSettingsUpdatedAt: 100,
    ...overrides
  };
}

test("channel ID deterministically derives connection secrets", async () => {
  const channel = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  assert.equal(normalizeChannelId(channel), channel);
  const first = await deriveChannelConnection(channel);
  const second = await deriveChannelConnection(channel);
  assert.deepEqual(first, second);
  assert.match(first.vaultId, /^[A-Za-z0-9_-]{24}$/u);
  assert.match(first.encryptionKey, /^[A-Za-z0-9+/]+={0,2}$/u);
});

test("newer remote shared settings are applied locally", () => {
  const local = settings();
  const remote = {
    updatedAt: 200,
    updatedBy: "device-b",
    value: {
      publicationEnabled: false,
      siteTitle: "Общая база",
      publicationFolders: ["Команда", "Команда/Документы"],
      publicationRules: "private | Команда/Черновики"
    }
  };
  const result = mergeSharedSettings(local, remote);
  assert.equal(result.action, "download");
  assert.equal(local.siteTitle, "Общая база");
  assert.deepEqual(local.publicationFolders, ["Команда", "Команда/Документы"]);
  assert.equal(local.publicationFingerprint, "");
});

test("newer local shared settings are prepared for upload", () => {
  const local = settings({ sharedSettingsUpdatedAt: 300, siteTitle: "Локальное название" });
  const remote = {
    updatedAt: 200,
    updatedBy: "device-b",
    value: { publicationEnabled: true, siteTitle: "Старое", publicationFolders: [], publicationRules: "" }
  };
  const result = mergeSharedSettings(local, remote);
  assert.equal(result.action, "upload");
  assert.equal(result.remote.value.siteTitle, "Локальное название");
});

test("uninitialized second device adopts remote settings", () => {
  const local = settings({ sharedSettingsUpdatedAt: 0 });
  const remote = {
    updatedAt: 200,
    updatedBy: "device-a",
    value: { publicationEnabled: true, siteTitle: "С сервера", publicationFolders: ["Public"], publicationRules: "" }
  };
  assert.equal(mergeSharedSettings(local, remote).action, "download");
  assert.equal(local.siteTitle, "С сервера");
});
