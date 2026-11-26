import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isViewerDocument, renderPublicationViewer } from "./viewer.mjs";

const DATA_DIR = process.env.DATA_DIR || join(fileURLToPath(new URL(".", import.meta.url)), "data");
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const MAX_JSON_BYTES = Number(process.env.MAX_JSON_BYTES || 100 * 1024 * 1024);
const MAX_BLOB_BYTES = Number(process.env.MAX_BLOB_BYTES || 50 * 1024 * 1024);

const mimeTypes = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".pdf": "application/pdf", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".wav": "audio/wav",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8"
};

await mkdir(DATA_DIR, { recursive: true });

export const server = createServer(async (req, res) => {
  try {
    await handle(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "internal_error" });
  }
});

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/") return sendHtml(res, 200, channelPage());
  if (req.method === "GET" && url.pathname === "/health") return sendJson(res, 200, { status: "ok" });

  const createMatch = url.pathname.match(/^\/v1\/vaults\/([A-Za-z0-9_-]{8,80})$/u);
  if (req.method === "POST" && createMatch) return createVault(req, res, createMatch[1]);

  const manifestMatch = url.pathname.match(/^\/v1\/vaults\/([A-Za-z0-9_-]{8,80})\/manifest$/u);
  if (manifestMatch) {
    const meta = await authenticate(req, res, manifestMatch[1]);
    if (!meta) return;
    if (req.method === "GET") return getManifest(res, manifestMatch[1]);
    if (req.method === "PUT") return putManifest(req, res, manifestMatch[1]);
  }

  const blobMatch = url.pathname.match(/^\/v1\/vaults\/([A-Za-z0-9_-]{8,80})\/blobs\/([A-Za-z0-9_-]{20,100})$/u);
  if (blobMatch) {
    const meta = await authenticate(req, res, blobMatch[1]);
    if (!meta) return;
    if (req.method === "GET") return getBlob(res, blobMatch[1], blobMatch[2]);
    if (req.method === "PUT") return putBlob(req, res, blobMatch[1], blobMatch[2]);
  }

  const publicationMatch = url.pathname.match(/^\/v1\/vaults\/([A-Za-z0-9_-]{8,80})\/publication$/u);
  if (req.method === "PUT" && publicationMatch) {
    const meta = await authenticate(req, res, publicationMatch[1]);
    if (!meta) return;
    return putPublication(req, res, publicationMatch[1]);
  }

  const viewMatch = url.pathname.match(/^\/view\/([A-Za-z0-9_-]{8,80})(?:\/(.*))?$/u);
  if (req.method === "GET" && viewMatch) return viewPublication(res, viewMatch[1], decodeViewerPath(viewMatch[2] || ""), url);

  sendJson(res, 404, { error: "not_found" });
}

async function createVault(req, res, vaultId) {
  const token = bearer(req);
  if (!token) return sendJson(res, 401, { error: "missing_token" });
  const dir = vaultDir(vaultId);
  try {
    await stat(join(dir, "meta.json"));
    return sendJson(res, 409, { error: "vault_exists" });
  } catch {}
  await mkdir(join(dir, "blobs"), { recursive: true });
  await atomicJson(join(dir, "meta.json"), { tokenHash: digest(token), createdAt: Date.now() });
  sendJson(res, 201, { created: true });
}

async function authenticate(req, res, vaultId) {
  const token = bearer(req);
  if (!token) {
    sendJson(res, 401, { error: "missing_token" });
    return null;
  }
  const meta = await readJson(join(vaultDir(vaultId), "meta.json"));
  if (!meta || !safeEqual(meta.tokenHash, digest(token))) {
    sendJson(res, 403, { error: "invalid_token" });
    return null;
  }
  return meta;
}

async function getManifest(res, vaultId) {
  const manifest = await readJson(join(vaultDir(vaultId), "manifest.json"));
  if (!manifest) return sendJson(res, 404, { error: "manifest_not_found" });
  sendJson(res, 200, manifest, { ETag: `\"${manifest.version}\"` });
}

async function putManifest(req, res, vaultId) {
  const expected = Number(req.headers["if-match"]);
  if (!Number.isInteger(expected) || expected < 0) return sendJson(res, 428, { error: "if_match_required" });
  const current = await readJson(join(vaultDir(vaultId), "manifest.json"));
  const currentVersion = current?.version || 0;
  if (expected !== currentVersion) return sendJson(res, 409, { error: "version_conflict", version: currentVersion });
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  if (!body || typeof body.payload !== "string" || body.payload.length > MAX_JSON_BYTES) return sendJson(res, 400, { error: "invalid_manifest" });
  const next = { version: currentVersion + 1, payload: body.payload, updatedAt: Date.now() };
  await atomicJson(join(vaultDir(vaultId), "manifest.json"), next);
  sendJson(res, 200, { version: next.version });
}

async function putBlob(req, res, vaultId, blobId) {
  const body = await readBody(req, MAX_BLOB_BYTES);
  const target = join(vaultDir(vaultId), "blobs", blobId);
  try {
    await stat(target);
    return sendJson(res, 200, { stored: false });
  } catch {}
  await atomicWrite(target, body);
  sendJson(res, 201, { stored: true });
}

async function getBlob(res, vaultId, blobId) {
  try {
    const data = await readFile(join(vaultDir(vaultId), "blobs", blobId));
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length, "Cache-Control": "private, max-age=31536000, immutable" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "blob_not_found" });
  }
}

async function putPublication(req, res, vaultId) {
  const body = await readJsonBody(req, MAX_JSON_BYTES);
  const error = validatePublication(body);
  if (error) return sendJson(res, 400, { error: "invalid_publication", detail: error });
  await atomicJson(join(vaultDir(vaultId), "publication.json"), body);
  sendJson(res, 200, { published: true, files: body.files.length, updatedAt: body.updatedAt });
}

async function viewPublication(res, vaultId, requestedPath, url) {
  const publication = await readJson(join(vaultDir(vaultId), "publication.json"));
  if (!publication) return sendHtml(res, 404, errorPage("Веб-копия ещё не опубликована"));
  const key = url.searchParams.get("key") || "";
  const keyHash = key ? digestBase64(key) : "";
  const visibleFiles = publication.files.filter(file => canView(file.path, publication.rules, keyHash));
  const documents = visibleFiles.filter(isViewerDocument);
  let path = requestedPath;
  if (!path) path = documents[0]?.path || "";
  const file = visibleFiles.find(item => item.path === path);
  if (!file) return sendHtml(res, 404, errorPage("Страница не найдена или доступ закрыт"));

  if (!isViewerDocument(file)) {
    const data = Buffer.from(file.content, "base64");
    const contentType = mimeTypes[extname(file.path).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length, "Cache-Control": "public, max-age=300" });
    return res.end(data);
  }

  const html = renderPublicationViewer({ publication, vaultId, currentPath: file.path, visibleFiles, key });
  if (!html) return sendHtml(res, 404, errorPage("Страница не найдена или доступ закрыт"));
  sendHtml(res, 200, html);
}

function canView(path, rules, keyHash) {
  const candidates = rules
    .filter(rule => !rule.path || path === rule.path || path.startsWith(`${rule.path}/`));
  if (!candidates.length) return false;
  const maxLength = Math.max(...candidates.map(rule => rule.path.length));
  const exact = candidates.filter(rule => rule.path.length === maxLength);
  if (exact.some(rule => rule.mode === "private")) return false;
  if (exact.some(rule => rule.mode === "public")) return true;
  return Boolean(keyHash && exact.some(rule => rule.mode === "link" && rule.keyHash && safeEqual(keyHash, rule.keyHash)));
}


function validatePublication(value) {
  if (!value || value.format !== 1 || typeof value.siteTitle !== "string" || !Array.isArray(value.rules) || !Array.isArray(value.files)) return "invalid shape";
  if (value.siteTitle.length > 200 || value.files.length > 100000 || value.rules.length > 1000) return "limits exceeded";
  for (const rule of value.rules) {
    if (!rule || typeof rule.path !== "string" || !["public", "link", "private"].includes(rule.mode) || !safePath(rule.path)) return "invalid rule";
    if (rule.mode === "link" && typeof rule.keyHash !== "string") return "missing link key";
  }
  for (const file of value.files) {
    if (!file || typeof file.path !== "string" || !safePath(file.path) || typeof file.content !== "string" || !["markdown", "asset"].includes(file.kind)) return "invalid file";
  }
  return "";
}

function safePath(path) { return !path.startsWith("/") && !path.split("/").includes("..") && !path.includes("\\"); }
function decodeViewerPath(value) { try { return value.split("/").map(decodeURIComponent).join("/"); } catch { return "\0"; } }
function encodePath(value) { return value.split("/").map(encodeURIComponent).join("/"); }
function vaultDir(id) { return join(DATA_DIR, id); }
function bearer(req) { const value = req.headers.authorization || ""; return value.startsWith("Bearer ") ? value.slice(7) : ""; }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function digestBase64(value) { return createHash("sha256").update(value).digest("base64"); }
function safeEqual(a, b) { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); return left.length === right.length && timingSafeEqual(left, right); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function errorPage(message) { return `<!doctype html><html lang=ru><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Нет доступа</title><style>body{font:18px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#171719;color:#eee}main{text-align:center;max-width:500px;padding:24px}p{color:#aaa}</style><main><h1>Simple Sync</h1><p>${escapeHtml(message)}</p></main>`; }
function channelPage() { return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Simple Sync — каналы</title><style>:root{font-family:Inter,system-ui,sans-serif;color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171719;color:#eee}.card{width:min(620px,calc(100% - 32px));box-sizing:border-box;padding:28px;border:1px solid #39393f;border-radius:16px;background:#222226;box-shadow:0 20px 70px #0007}h1{margin:0 0 8px;font-size:30px}p{color:#b8b8c0;line-height:1.55}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}button{border:0;border-radius:9px;padding:11px 16px;font:inherit;font-weight:650;cursor:pointer;background:#7c3aed;color:white}button.secondary{background:#39393f}button:disabled{opacity:.55;cursor:wait}.result{margin-top:22px;padding:14px;border:1px solid #494950;border-radius:10px;background:#18181b}.result[hidden]{display:none}textarea{box-sizing:border-box;width:100%;min-height:92px;resize:none;border:1px solid #494950;border-radius:8px;padding:10px;background:#111113;color:#fff;font:13px/1.45 ui-monospace,monospace}.warning{color:#f1b76a;font-size:13px}.status{min-height:22px;color:#e9a3a3}</style></head><body><main class="card"><h1>Simple Sync</h1><p>Создайте отдельный зашифрованный канал, затем вставьте его ID в плагин Obsidian на компьютере и телефоне.</p><p>Ключи выводятся из ID локально в браузере. Сервер получает только технический идентификатор и токен доступа.</p><div class="actions"><button id="create" type="button">Создать канал</button></div><p id="status" class="status"></p><section id="result" class="result" hidden><strong>ID канала</strong><p class="warning">Храните его как пароль. Любой владелец ID сможет подключить устройство.</p><textarea id="channel" readonly></textarea><div class="actions"><button id="copy" class="secondary" type="button">Копировать ID</button></div></section></main><script>(()=>{const encoder=new TextEncoder(),create=document.getElementById('create'),status=document.getElementById('status'),result=document.getElementById('result'),channel=document.getElementById('channel'),copy=document.getElementById('copy');function base64(bytes){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary)}function base64url(bytes){return base64(bytes).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')}async function digest(value){return new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))}create.onclick=async()=>{create.disabled=true;status.textContent='Создаю канал…';result.hidden=true;try{const id=base64url(crypto.getRandomValues(new Uint8Array(32))),vaultHash=await digest('simple-sync-vault:'+id),keyHash=await digest('simple-sync-key:'+id),vaultId=base64url(vaultHash.slice(0,18)),encryptionKey=base64(keyHash),token=base64(await digest('simple-sync-auth:'+vaultId+':'+encryptionKey)),response=await fetch('/v1/vaults/'+encodeURIComponent(vaultId),{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw new Error('Сервер не создал канал ('+response.status+')');channel.value=id;result.hidden=false;status.textContent='Канал создан';}catch(error){status.textContent=error instanceof Error?error.message:String(error)}finally{create.disabled=false}};copy.onclick=async()=>{try{await navigator.clipboard.writeText(channel.value)}catch{channel.select();document.execCommand('copy')}copy.textContent='Скопировано';setTimeout(()=>copy.textContent='Копировать ID',1500)}})();</script></body></html>`; }
function sendHtml(res, status, html) { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'" }); res.end(html); }
function sendJson(res, status, value, extra = {}) { const body = JSON.stringify(value); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...extra }); res.end(body); }
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function readJsonBody(req, limit) { try { return JSON.parse((await readBody(req, limit)).toString("utf8")); } catch { return null; } }
async function readBody(req, limit) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("request too large"); chunks.push(chunk); } return Buffer.concat(chunks); }
async function atomicJson(path, value) { await atomicWrite(path, Buffer.from(JSON.stringify(value))); }
async function atomicWrite(path, data) { const temp = `${path}.${process.pid}.${Date.now()}.tmp`; await writeFile(temp, data); await rename(temp, path); }

if (process.env.NODE_ENV !== "test") server.listen(PORT, HOST, () => console.log(`Simple Sync listening on http://${HOST}:${PORT}`));
