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
function sendHtml(res, status, html) { res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https:; media-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'" }); res.end(html); }
function sendJson(res, status, value, extra = {}) { const body = JSON.stringify(value); res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", ...extra }); res.end(body); }
async function readJson(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }
async function readJsonBody(req, limit) { try { return JSON.parse((await readBody(req, limit)).toString("utf8")); } catch { return null; } }
async function readBody(req, limit) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("request too large"); chunks.push(chunk); } return Buffer.concat(chunks); }
async function atomicJson(path, value) { await atomicWrite(path, Buffer.from(JSON.stringify(value))); }
async function atomicWrite(path, data) { const temp = `${path}.${process.pid}.${Date.now()}.tmp`; await writeFile(temp, data); await rename(temp, path); }

if (process.env.NODE_ENV !== "test") server.listen(PORT, HOST, () => console.log(`Simple Sync listening on http://${HOST}:${PORT}`));
