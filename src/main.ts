import { Notice, Platform, Plugin, PluginSettingTab, Setting } from "obsidian";
import { bytesToBase64, decodePairingCode, encodePairingCode, randomBase64, sha256 } from "./crypto";
import { RemoteClient, normalizeServer } from "./remote";
import { SyncEngine } from "./sync-engine";
import type { PairingPayload, PublicationRule, PublicationSnapshot, SyncSettings } from "./types";

const DEFAULT_SETTINGS: SyncSettings = {
  serverUrl: "",
  vaultId: "",
  encryptionKey: "",
  deviceId: "",
  deviceName: "",
  intervalSeconds: 30,
  baseline: {},
  pairingCode: "",
  publicationEnabled: true,
  siteTitle: "Мои заметки",
  publicationRules: "public | Публичное",
  publicationFingerprint: ""
};

export default class SimpleEncryptedSyncPlugin extends Plugin {
  settings: SyncSettings = { ...DEFAULT_SETTINGS };
  engine!: SyncEngine;
  private intervalId: number | null = null;
  private debounceId: number | null = null;
  private statusText = "Не настроено";
  private statusError = false;
  private statusElement!: HTMLElement;
  settingsTab!: SyncSettingTab;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.statusElement = this.addStatusBarItem();
    this.engine = new SyncEngine(this.app, () => this.settings, () => this.saveSettings(), (message, error) => this.setStatus(message, Boolean(error)));
    this.settingsTab = new SyncSettingTab(this);
    this.addSettingTab(this.settingsTab);

    this.addRibbonIcon("refresh-cw", "Синхронизировать Obsidian", () => { void this.runSync(true); });
    this.addCommand({ id: "sync-now", name: "Синхронизировать сейчас", callback: () => { void this.runSync(true); } });

    const schedule = (): void => this.scheduleSync();
    this.registerEvent(this.app.vault.on("create", schedule));
    this.registerEvent(this.app.vault.on("modify", schedule));
    this.registerEvent(this.app.vault.on("delete", schedule));
    this.registerEvent(this.app.vault.on("rename", schedule));

    this.restartTimer();
    this.setStatus(this.isConfigured() ? "Ожидание синхронизации" : "Синхронизация не настроена");
    this.app.workspace.onLayoutReady(() => {
      if (this.isConfigured()) window.setTimeout(() => { void this.runSync(false); }, 1500);
    });
  }

  onunload(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData() as Partial<SyncSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };
    if (!this.settings.deviceId) this.settings.deviceId = shortRandomId();
    if (!this.settings.deviceName) this.settings.deviceName = Platform.isMobileApp ? "Телефон" : "Компьютер";
    await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  isConfigured(): boolean {
    return Boolean(this.settings.serverUrl && this.settings.vaultId && this.settings.encryptionKey);
  }

  getStatus(): { text: string; error: boolean } {
    return { text: this.statusText, error: this.statusError };
  }

  setStatus(message: string, error = false): void {
    this.statusText = message;
    this.statusError = error;
    this.statusElement.setText(`Sync: ${message}`);
    this.statusElement.toggleClass("simple-sync-danger", error);
  }

  async runSync(showNotice: boolean): Promise<void> {
    if (!this.isConfigured()) {
      if (showNotice) new Notice("Сначала настройте Simple Encrypted Sync");
      return;
    }
    try {
      const result = await this.engine.sync();
      if (result && this.settings.publicationEnabled) await this.publishSnapshot();
      if (showNotice && result) new Notice(`Синхронизация завершена. Загружено: ${result.uploaded}, скачано: ${result.downloaded}, конфликтов: ${result.conflicts}`);
    } catch (error) {
      if (showNotice) new Notice(error instanceof Error ? error.message : String(error), 8000);
    }
  }

  getViewerUrl(): string {
    return `${this.settings.serverUrl}/view/${encodeURIComponent(this.settings.vaultId)}/`;
  }

  async publishSnapshot(force = false): Promise<void> {
    if (!this.isConfigured()) return;
    const parsed = await parsePublicationRules(this.settings.publicationRules);
    const files: PublicationSnapshot["files"] = [];
    const fingerprints: string[] = [];
    for (const file of this.app.vault.getFiles()) {
      const rule = matchingRule(file.path, parsed.rules);
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
    const fingerprintSource = new TextEncoder().encode(JSON.stringify({ title: this.settings.siteTitle, rules: parsed.rules, files: fingerprints.sort() }));
    const fingerprint = await sha256(fingerprintSource.buffer);
    if (!force && fingerprint === this.settings.publicationFingerprint) return;
    const snapshot: PublicationSnapshot = {
      format: 1,
      siteTitle: this.settings.siteTitle.trim() || "Мои заметки",
      updatedAt: Date.now(),
      rules: parsed.rules,
      files
    };
    const client = await RemoteClient.create(this.settings.serverUrl, this.settings.vaultId, this.settings.encryptionKey);
    await client.putPublication(snapshot);
    this.settings.publicationFingerprint = fingerprint;
    await this.saveSettings();
  }

  restartTimer(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    const seconds = Math.max(10, this.settings.intervalSeconds || 30);
    this.intervalId = window.setInterval(() => { void this.runSync(false); }, seconds * 1000);
  }

  private scheduleSync(): void {
    if (!this.isConfigured()) return;
    if (this.debounceId !== null) window.clearTimeout(this.debounceId);
    this.debounceId = window.setTimeout(() => { void this.runSync(false); }, 2000);
  }

  async createRemoteVault(serverValue: string): Promise<void> {
    const serverUrl = normalizeServer(serverValue);
    const vaultId = shortRandomId(16);
    const encryptionKey = randomBase64(32);
    const client = await RemoteClient.create(serverUrl, vaultId, encryptionKey);
    await client.ping();
    await client.createVault();
    const payload: PairingPayload = { version: 1, serverUrl, vaultId, encryptionKey };
    this.settings.serverUrl = serverUrl;
    this.settings.vaultId = vaultId;
    this.settings.encryptionKey = encryptionKey;
    this.settings.pairingCode = encodePairingCode(payload);
    this.settings.baseline = {};
    this.settings.publicationEnabled = true;
    this.settings.publicationFingerprint = "";
    await this.saveSettings();
    this.restartTimer();
    this.setStatus("Хранилище создано");
    await this.runSync(false);
  }

  async joinWithCode(code: string): Promise<void> {
    const payload = decodePairingCode<Partial<PairingPayload>>(code);
    if (payload.version !== 1 || !payload.serverUrl || !payload.vaultId || !payload.encryptionKey) throw new Error("Некорректный код подключения");
    const serverUrl = normalizeServer(payload.serverUrl);
    const client = await RemoteClient.create(serverUrl, payload.vaultId, payload.encryptionKey);
    await client.getManifest();
    this.settings.serverUrl = serverUrl;
    this.settings.vaultId = payload.vaultId;
    this.settings.encryptionKey = payload.encryptionKey;
    this.settings.pairingCode = code.trim();
    this.settings.baseline = {};
    this.settings.publicationEnabled = false;
    this.settings.publicationFingerprint = "";
    await this.saveSettings();
    this.restartTimer();
    this.setStatus("Устройство подключено");
    await this.runSync(false);
  }

  async disconnect(): Promise<void> {
    this.settings = {
      ...this.settings,
      serverUrl: "",
      vaultId: "",
      encryptionKey: "",
      pairingCode: "",
      baseline: {}
    };
    await this.saveSettings();
    this.setStatus("Синхронизация не настроена");
  }
}

class SyncSettingTab extends PluginSettingTab {
  private serverDraft = "";
  private codeDraft = "";

  constructor(private readonly plugin: SimpleEncryptedSyncPlugin) {
    super(plugin.app, plugin);
    this.serverDraft = plugin.settings.serverUrl;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Simple Encrypted Sync" });

    const status = this.plugin.getStatus();
    const statusEl = containerEl.createDiv({ cls: "simple-sync-status", text: status.text });
    statusEl.toggleClass("simple-sync-danger", status.error);

    if (this.plugin.isConfigured()) {
      new Setting(containerEl)
        .setName("Имя этого устройства")
        .setDesc("Используется в названиях conflict-копий")
        .addText(text => text.setValue(this.plugin.settings.deviceName).onChange(async value => {
          this.plugin.settings.deviceName = value.trim() || (Platform.isMobileApp ? "Телефон" : "Компьютер");
          await this.plugin.saveSettings();
        }));

      containerEl.createEl("h3", { text: "Веб-просмотрщик (только чтение)" });
      new Setting(containerEl)
        .setName("Публиковать выбранные заметки")
        .setDesc("Основное зашифрованное хранилище при этом остаётся закрытым")
        .addToggle(toggle => toggle.setValue(this.plugin.settings.publicationEnabled).onChange(async value => {
          this.plugin.settings.publicationEnabled = value;
          await this.plugin.saveSettings();
        }));
      new Setting(containerEl)
        .setName("Название сайта")
        .addText(text => text.setValue(this.plugin.settings.siteTitle).onChange(async value => {
          this.plugin.settings.siteTitle = value;
          await this.plugin.saveSettings();
        }));

      const rules = new Setting(containerEl)
        .setName("Правила просмотра")
        .setDesc("Формат: public | Папка; link | Папка | секрет; private | Папка/Файл.md. Повторите link для каждого человека; удалите строку, чтобы отозвать его доступ")
        .setClass("simple-sync-code");
      rules.addTextArea(area => area.setValue(this.plugin.settings.publicationRules).onChange(async value => {
        this.plugin.settings.publicationRules = value;
        await this.plugin.saveSettings();
      }));

      new Setting(containerEl)
        .setName("Адрес просмотрщика")
        .setDesc(this.plugin.getViewerUrl())
        .addButton(button => button.setButtonText("Открыть").onClick(() => { window.open(this.plugin.getViewerUrl()); }))
        .addButton(button => button.setButtonText("Копировать").onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.getViewerUrl());
          new Notice("Ссылка скопирована");
        }));

      new Setting(containerEl)
        .setName("Обновить веб-копию")
        .setDesc("Для закрытой папки добавьте к адресу ?key=ваш-секрет")
        .addButton(button => button.setButtonText("Опубликовать").setCta().onClick(async () => {
          button.setDisabled(true);
          try {
            await this.plugin.publishSnapshot(true);
            new Notice("Веб-копия обновлена");
          } catch (error) {
            new Notice(error instanceof Error ? error.message : String(error), 8000);
          } finally {
            button.setDisabled(false);
          }
        }));

      new Setting(containerEl)
        .setName("Интервал синхронизации")
        .setDesc("Не реже 10 секунд")
        .addText(text => text.setValue(String(this.plugin.settings.intervalSeconds)).onChange(async value => {
          const parsed = Number(value);
          if (Number.isFinite(parsed)) this.plugin.settings.intervalSeconds = Math.max(10, Math.round(parsed));
          await this.plugin.saveSettings();
          this.plugin.restartTimer();
        }));

      new Setting(containerEl)
        .setName("Синхронизировать сейчас")
        .addButton(button => button.setButtonText("Запустить").setCta().onClick(async () => {
          await this.plugin.runSync(true);
        }));

      const pair = new Setting(containerEl)
        .setName("Код подключения второго устройства")
        .setDesc("Это секретный код: не публикуйте его и не отправляйте посторонним")
        .setClass("simple-sync-code");
      pair.addTextArea(area => area.setValue(this.plugin.settings.pairingCode).setDisabled(true));
      pair.addButton(button => button.setButtonText("Копировать").onClick(async () => {
        await navigator.clipboard.writeText(this.plugin.settings.pairingCode);
        new Notice("Код подключения скопирован");
      }));

      new Setting(containerEl)
        .setName("Отключить это устройство")
        .setDesc("Локальные заметки останутся на месте")
        .addButton(button => button.setButtonText("Отключить").setWarning().onClick(async () => {
          await this.plugin.disconnect();
          this.display();
        }));
      return;
    }

    containerEl.createEl("h3", { text: "Создать новое хранилище" });
    new Setting(containerEl)
      .setName("Адрес сервера")
      .setDesc("Например: https://sync.example.ru")
      .addText(text => text.setPlaceholder("https://sync.example.ru").setValue(this.serverDraft).onChange(value => { this.serverDraft = value; }));
    new Setting(containerEl)
      .setName("Первое устройство")
      .setDesc("Создаст зашифрованное хранилище и код подключения")
      .addButton(button => button.setButtonText("Создать").setCta().onClick(async () => {
        button.setDisabled(true);
        try {
          await this.plugin.createRemoteVault(this.serverDraft);
          new Notice("Хранилище создано");
          this.display();
        } catch (error) {
          new Notice(error instanceof Error ? error.message : String(error), 8000);
        } finally {
          button.setDisabled(false);
        }
      }));

    containerEl.createEl("h3", { text: "Подключить второе устройство" });
    const join = new Setting(containerEl)
      .setName("Код подключения")
      .setDesc("Скопируйте код с уже настроенного устройства")
      .setClass("simple-sync-code");
    join.addTextArea(area => area.setPlaceholder("Вставьте код").setValue(this.codeDraft).onChange(value => { this.codeDraft = value; }));
    join.addButton(button => button.setButtonText("Подключить").setCta().onClick(async () => {
      button.setDisabled(true);
      try {
        await this.plugin.joinWithCode(this.codeDraft);
        new Notice("Устройство подключено");
        this.display();
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error), 8000);
      } finally {
        button.setDisabled(false);
      }
    }));
  }
}

function shortRandomId(size = 9): string {
  return randomBase64(size).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function parsePublicationRules(source: string): Promise<{ rules: PublicationRule[] }> {
  const rules: PublicationRule[] = [];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("|").map(value => value.trim());
    const mode = parts[0];
    if (mode !== "public" && mode !== "link" && mode !== "private") throw new Error(`Строка ${index + 1}: режим должен быть public, link или private`);
    const path = normalizeRulePath(parts[1] ?? "");
    const rule: PublicationRule = { path, mode };
    if (mode === "link") {
      if (!parts[2]) throw new Error(`Строка ${index + 1}: для link нужен секрет`);
      rule.keyHash = await sha256(new TextEncoder().encode(parts[2]).buffer);
    }
    rules.push(rule);
  }
  return { rules };
}

function normalizeRulePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  if (normalized.split("/").includes("..")) throw new Error("Путь правила не может содержать ..");
  return normalized;
}

function matchingRule(path: string, rules: PublicationRule[]): PublicationRule | null {
  const candidates = rules.filter(rule => !rule.path || path === rule.path || path.startsWith(`${rule.path}/`));
  candidates.sort((a, b) => b.path.length - a.path.length || (a.mode === "private" ? -1 : 1));
  return candidates[0] ?? null;
}
