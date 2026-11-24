const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBase64(size = 32): string {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(size)));
}

export async function sha256(data: ArrayBuffer): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

export async function keyedSha256(data: ArrayBuffer, keyBase64: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", exactBuffer(base64ToBytes(keyBase64)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, data)));
}

async function importAesKey(keyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", exactBuffer(base64ToBytes(keyBase64)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptBytes(data: ArrayBuffer, keyBase64: string): Promise<ArrayBuffer> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await importAesKey(keyBase64);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, data));
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce, 0);
  result.set(encrypted, nonce.length);
  return result.buffer;
}

export async function decryptBytes(data: ArrayBuffer, keyBase64: string): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(data);
  if (bytes.length < 29) throw new Error("Повреждён зашифрованный пакет");
  const key = await importAesKey(keyBase64);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
}

export async function encryptJson(value: unknown, keyBase64: string): Promise<string> {
  const source = encoder.encode(JSON.stringify(value));
  return bytesToBase64(new Uint8Array(await encryptBytes(source.buffer, keyBase64)));
}

export async function decryptJson<T>(value: string, keyBase64: string): Promise<T> {
  return JSON.parse(decoder.decode(await decryptBytes(exactBuffer(base64ToBytes(value)), keyBase64))) as T;
}

export async function deriveAuthToken(keyBase64: string, vaultId: string): Promise<string> {
  const material = encoder.encode(`simple-sync-auth:${vaultId}:${keyBase64}`);
  return sha256(material.buffer);
}

export function encodePairingCode(value: object): string {
  return bytesToBase64(encoder.encode(JSON.stringify(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodePairingCode<T>(value: string): T {
  const normalized = value.trim().replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(decoder.decode(base64ToBytes(padded))) as T;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
