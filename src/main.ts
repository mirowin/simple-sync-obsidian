import { Modal, normalizePath, Notice, Platform, Plugin, PluginSettingTab, Setting, TFolder, type SettingDefinitionItem, type SettingDefinitionRender } from "obsidian";
import { bytesToBase64, decodePairingCode, deriveChannelConnection, encodePairingCode, normalizeChannelId, randomBase64, sha256 } from "./crypto";
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
  channelId: "",
  publicationEnabled: true,
  siteTitle: "Мои заметки",
  publicationFolders: ["Публичное"],
  publicationRules: "",
  publicationFingerprint: "",
  sharedSettingsUpdatedAt: 0
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
    if (!Array.isArray(loaded?.publicationFolders)) {
      const migrated = migrateLegacyPublicationRules(this.settings.publicationRules);
      this.settings.publicationFolders = migrated.folders.length ? migrated.folders : ["Публичное"];
      this.settings.publicationRules = migrated.rules;
    }
    if (!this.settings.deviceId) this.settings.deviceId = shortRandomId();
    if (!this.settings.deviceName) this.settings.deviceName = Platform.isMobileApp ? "Телефон" : "Компьютер";
    if (loaded?.sharedSettingsUpdatedAt === undefined && this.settings.publicationEnabled && this.isConfigured()) {
      this.settings.sharedSettingsUpdatedAt = Date.now();
    }
    await this.saveData(this.settings);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async saveSharedSettings(): Promise<void> {
    this.settings.sharedSettingsUpdatedAt = Date.now();
    this.settings.publicationFingerprint = "";
    await this.saveSettings();
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
      if (showNotice && result) {
        const settingsText = result.settings === "downloaded" ? ", настройки получены" : result.settings === "uploaded" ? ", настройки отправлены" : "";
        new Notice(`Синхронизация завершена. Загружено: ${result.uploaded}, скачано: ${result.downloaded}, конфликтов: ${result.conflicts}${settingsText}`);
      }
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
    const publicRules: PublicationRule[] = this.settings.publicationFolders.map(path => ({ path: normalizeRulePath(path), mode: "public" }));
    const rules = deduplicateRules([...publicRules, ...parsed.rules]);
    const files: PublicationSnapshot["files"] = [];
    const fingerprints: string[] = [];
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
    const snapshot: PublicationSnapshot = {
      format: 1,
      siteTitle: this.settings.siteTitle.trim() || "Мои заметки",
      updatedAt: Date.now(),
      rules,
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
    this.settings.channelId = "";
    this.settings.baseline = {};
    this.settings.publicationEnabled = true;
    this.settings.publicationFingerprint = "";
    this.settings.sharedSettingsUpdatedAt = Date.now();
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
    this.settings.channelId = "";
    this.settings.baseline = {};
    this.settings.publicationEnabled = false;
    this.settings.publicationFingerprint = "";
    this.settings.sharedSettingsUpdatedAt = 0;
    await this.saveSettings();
    this.restartTimer();
    this.setStatus("Устройство подключено");
    await this.runSync(false);
  }

  async connectToChannel(serverValue: string, channelValue: string): Promise<void> {
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
    this.setStatus("Канал подключён");
    await this.runSync(false);
  }

  async disconnect(): Promise<void> {
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
    this.setStatus("Синхронизация не настроена");
  }
}

class SyncSettingTab extends PluginSettingTab {
  private serverDraft = "";
  private channelDraft = "";
  private codeDraft = "";

  constructor(private readonly plugin: SimpleEncryptedSyncPlugin) {
    super(plugin.app, plugin);
    this.serverDraft = plugin.settings.serverUrl;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const status = this.plugin.getStatus();
    const statusDefinition = renderSetting("Состояние синхронизации", status.text, setting => {
      setting.setClass("simple-sync-status");
      setting.settingEl.toggleClass("simple-sync-danger", status.error);
    });

    if (!this.plugin.isConfigured()) {
      return [
        { type: "group", heading: "Simple Encrypted Sync", items: [statusDefinition] },
        {
          type: "group",
          heading: "Подключиться к каналу синхронизации",
          items: [
            renderSetting("Адрес сервера", "Откройте этот адрес в браузере, создайте канал и скопируйте его ID", setting => {
              setting.addText(text => text.setPlaceholder("https://sync.example.ru").setValue(this.serverDraft).onChange(value => { this.serverDraft = value; }));
            }),
            renderSetting("ID канала", "Один и тот же секретный ID вводится на компьютере и телефоне", setting => {
              setting.addTextArea(area => area.setPlaceholder("Вставьте ID канала").setValue(this.channelDraft).onChange(value => { this.channelDraft = value; }))
                .addButton(button => button.setButtonText("Подключить").setCta().onClick(async () => {
                  button.setDisabled(true);
                  try {
                    await this.plugin.connectToChannel(this.serverDraft, this.channelDraft);
                    new Notice("Канал подключён");
                    this.update();
                  } catch (error) {
                    new Notice(error instanceof Error ? error.message : String(error), 8000);
                  } finally {
                    button.setDisabled(false);
                  }
                }));
            })
          ]
        },
        {
          type: "group",
          heading: "Совместимость со старыми версиями",
          items: [renderSetting("Код подключения", "Скопируйте код с уже настроенного устройства", setting => {
            setting.setClass("simple-sync-code")
              .addTextArea(area => area.setPlaceholder("Вставьте код").setValue(this.codeDraft).onChange(value => { this.codeDraft = value; }))
              .addButton(button => button.setButtonText("Подключить").setCta().onClick(async () => {
                button.setDisabled(true);
                try {
                  await this.plugin.joinWithCode(this.codeDraft);
                  new Notice("Устройство подключено");
                  this.update();
                } catch (error) {
                  new Notice(error instanceof Error ? error.message : String(error), 8000);
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
          renderSetting("Имя этого устройства", "Используется в названиях conflict-копий", setting => {
            setting.addText(text => text.setValue(this.plugin.settings.deviceName).onChange(async value => {
              this.plugin.settings.deviceName = value.trim() || (Platform.isMobileApp ? "Телефон" : "Компьютер");
              await this.plugin.saveSettings();
            }));
          })
        ]
      },
      {
        type: "group",
        heading: "Веб-просмотрщик (только чтение)",
        items: [
          renderSetting("Публиковать выбранные заметки", "Основное зашифрованное хранилище при этом остаётся закрытым", setting => {
            setting.addToggle(toggle => toggle.setValue(this.plugin.settings.publicationEnabled).onChange(async value => {
              this.plugin.settings.publicationEnabled = value;
              await this.plugin.saveSharedSettings();
            }));
          }),
          renderSetting("Название сайта", undefined, setting => {
            setting.addText(text => text.setValue(this.plugin.settings.siteTitle).onChange(async value => {
              this.plugin.settings.siteTitle = value;
              await this.plugin.saveSharedSettings();
            }));
          }),
          renderSetting("Папки для публичного просмотра", publicationFoldersDescription(this.plugin.settings.publicationFolders), setting => {
            setting.addButton(button => button.setButtonText("Выбрать папки").setCta().onClick(() => {
              new PublicationFoldersModal(this.plugin, () => this.update()).open();
            }));
          }),
          renderSetting("Дополнительные правила доступа", "Необязательно. Формат: link | Папка | секрет или private | Папка/Файл.md. Публичные папки выбираются кнопкой выше", setting => {
            setting.setClass("simple-sync-code").addTextArea(area => area.setValue(this.plugin.settings.publicationRules).onChange(async value => {
              this.plugin.settings.publicationRules = value;
              await this.plugin.saveSharedSettings();
            }));
          }),
          renderSetting("Адрес просмотрщика", this.plugin.getViewerUrl(), setting => {
            setting.addButton(button => button.setButtonText("Открыть").onClick(() => { window.open(this.plugin.getViewerUrl()); }))
              .addButton(button => button.setButtonText("Копировать").onClick(async () => {
                await navigator.clipboard.writeText(this.plugin.getViewerUrl());
                new Notice("Ссылка скопирована");
              }));
          }),
          renderSetting("Обновить веб-копию", "Для закрытой папки добавьте к адресу ?key=ваш-секрет", setting => {
            setting.addButton(button => button.setButtonText("Опубликовать").setCta().onClick(async () => {
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
          })
        ]
      },
      {
        type: "group",
        heading: "Синхронизация",
        items: [
          renderSetting("Интервал синхронизации", "Не реже 10 секунд", setting => {
            setting.addText(text => text.setValue(String(this.plugin.settings.intervalSeconds)).onChange(async value => {
              const parsed = Number(value);
              if (Number.isFinite(parsed)) this.plugin.settings.intervalSeconds = Math.max(10, Math.round(parsed));
              await this.plugin.saveSettings();
              this.plugin.restartTimer();
            }));
          }),
          renderSetting("Синхронизировать сейчас", undefined, setting => {
            setting.addButton(button => button.setButtonText("Запустить").setCta().onClick(async () => {
              await this.plugin.runSync(true);
            }));
          }),
          renderSetting(this.plugin.settings.channelId ? "ID канала синхронизации" : "Старый код подключения", "Это секрет: любой, кто его получит, сможет подключиться к зашифрованному хранилищу", setting => {
            setting.setClass("simple-sync-code")
              .addTextArea(area => area.setValue(connectionSecret).setDisabled(true))
              .addButton(button => button.setButtonText("Копировать").onClick(async () => {
                await navigator.clipboard.writeText(connectionSecret);
                new Notice(this.plugin.settings.channelId ? "ID канала скопирован" : "Код подключения скопирован");
              }));
          }),
          renderSetting("Отключить это устройство", "Локальные заметки останутся на месте", setting => {
            setting.addButton(button => button.setButtonText("Отключить").setDestructive().onClick(async () => {
              await this.plugin.disconnect();
              this.update();
            }));
          })
        ]
      }
    ];
  }
}

function renderSetting(name: string, desc: string | undefined, render: (setting: Setting) => void): SettingDefinitionRender {
  return {
    name,
    ...(desc === undefined ? {} : { desc }),
    render: setting => {
      setting.setName(name);
      if (desc !== undefined) setting.setDesc(desc);
      render(setting);
    }
  };
}

class PublicationFoldersModal extends Modal {
  private readonly selected: Set<string>;

  constructor(private readonly syncPlugin: SimpleEncryptedSyncPlugin, private readonly onSaved: () => void) {
    super(syncPlugin.app);
    this.selected = new Set(syncPlugin.settings.publicationFolders);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("simple-sync-folder-modal");
    new Setting(contentEl).setName("Папки для публикации").setHeading();
    contentEl.createEl("p", { text: "Выбранная папка публикуется вместе со всеми подпапками. Закрытые исключения можно добавить в дополнительных правилах.", cls: "setting-item-description" });

    const configDir = normalizePath(this.syncPlugin.app.vault.configDir);
    const folders = this.syncPlugin.app.vault.getAllLoadedFiles()
      .filter((item): item is TFolder => item instanceof TFolder && item.path !== configDir && !item.path.startsWith(`${configDir}/`))
      .sort((left, right) => left.path.localeCompare(right.path, "ru", { numeric: true }));
    const list = contentEl.createDiv({ cls: "simple-sync-folder-list" });
    this.addFolderToggle(list, "", "Весь vault", 0);
    for (const folder of folders) {
      const depth = folder.path.split("/").length - 1;
      this.addFolderToggle(list, folder.path, folder.name, depth);
    }

    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const cancel = actions.createEl("button", { text: "Отмена" });
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "Сохранить", cls: "mod-cta" });
    save.addEventListener("click", () => {
      void (async () => {
        this.syncPlugin.settings.publicationFolders = [...this.selected].sort((a, b) => a.localeCompare(b, "ru", { numeric: true }));
        await this.syncPlugin.saveSharedSettings();
        this.close();
        this.onSaved();
        new Notice("Папки публикации сохранены и будут синхронизированы");
      })();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private addFolderToggle(container: HTMLElement, path: string, label: string, depth: number): void {
    const setting = new Setting(container)
      .setName(label)
      .setDesc(path || "Публиковать все доступные файлы")
      .addToggle(toggle => toggle.setValue(this.selected.has(path)).onChange(value => {
        if (value) this.selected.add(path);
        else this.selected.delete(path);
      }));
    setting.settingEl.style.paddingLeft = `${Math.min(depth, 6) * 18 + 8}px`;
  }
}

function shortRandomId(size = 9): string {
  return randomBase64(size).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function publicationFoldersDescription(folders: string[]): string {
  if (!folders.length) return "Публичные папки не выбраны";
  if (folders.includes("")) return "Выбран весь vault";
  const preview = folders.slice(0, 3).join(", ");
  return folders.length > 3 ? `${preview} и ещё ${folders.length - 3}` : preview;
}

function migrateLegacyPublicationRules(source: string): { folders: string[]; rules: string } {
  const folders: string[] = [];
  const remaining: string[] = [];
  for (const raw of String(source || "").split(/\r?\n/u)) {
    const parts = raw.split("|").map(value => value.trim());
    if (parts[0] === "public") folders.push(normalizeRulePath(parts[1] ?? ""));
    else if (raw.trim()) remaining.push(raw);
  }
  return { folders: [...new Set(folders)], rules: remaining.join("\n") };
}

function deduplicateRules(rules: PublicationRule[]): PublicationRule[] {
  const result = new Map<string, PublicationRule>();
  for (const rule of rules) result.set(`${rule.mode}:${rule.path}:${rule.keyHash || ""}`, rule);
  return [...result.values()];
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
