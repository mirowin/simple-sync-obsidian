import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = await mkdtemp(join(tmpdir(), "simple-sync-test-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
const { server } = await import("./server.mjs");
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;
const token = "test-auth-token";
const auth = { Authorization: `Bearer ${token}` };

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
});

test("health endpoint responds", async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("vault, optimistic manifest and encrypted blob flow", async () => {
  const vault = "vault-test-123";
  let response = await fetch(`${base}/v1/vaults/${vault}`, { method: "POST", headers: auth, body: "{}" });
  assert.equal(response.status, 201);

  response = await fetch(`${base}/v1/vaults/${vault}/manifest`, { headers: auth });
  assert.equal(response.status, 404);

  response = await fetch(`${base}/v1/vaults/${vault}/manifest`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json", "If-Match": "0" },
    body: JSON.stringify({ payload: "encrypted-value" })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).version, 1);

  response = await fetch(`${base}/v1/vaults/${vault}/manifest`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json", "If-Match": "0" },
    body: JSON.stringify({ payload: "stale" })
  });
  assert.equal(response.status, 409);

  const blobId = "abcdefghijklmnopqrstuvwx12345678";
  response = await fetch(`${base}/v1/vaults/${vault}/blobs/${blobId}`, { method: "PUT", headers: auth, body: Buffer.from("ciphertext") });
  assert.equal(response.status, 201);
  response = await fetch(`${base}/v1/vaults/${vault}/blobs/${blobId}`, { headers: auth });
  assert.equal(await response.text(), "ciphertext");
});

test("viewer enforces public, link and private path rules", async () => {
  const vault = "viewer-test-123";
  const secret = "family-secret";
  const secondSecret = "second-person-secret";
  await fetch(`${base}/v1/vaults/${vault}`, { method: "POST", headers: auth, body: "{}" });
  const snapshot = {
    format: 1,
    siteTitle: "Test notes",
    updatedAt: Date.now(),
    rules: [
      { path: "Public", mode: "public" },
      { path: "Public/Draft.md", mode: "private" },
      { path: "Family", mode: "link", keyHash: createHash("sha256").update(secret).digest("base64") },
      { path: "Family", mode: "link", keyHash: createHash("sha256").update(secondSecret).digest("base64") }
    ],
    files: [
      { path: "Public/Hello.md", kind: "markdown", mtime: 1, content: Buffer.from("# Hello public").toString("base64") },
      { path: "Public/Draft.md", kind: "markdown", mtime: 1, content: Buffer.from("# Secret draft").toString("base64") },
      { path: "Family/Home.md", kind: "markdown", mtime: 1, content: Buffer.from("# Family home").toString("base64") }
    ]
  };
  let response = await fetch(`${base}/v1/vaults/${vault}/publication`, { method: "PUT", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(snapshot) });
  assert.equal(response.status, 200);

  response = await fetch(`${base}/view/${vault}/Public/Hello.md`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Hello public/u);

  response = await fetch(`${base}/view/${vault}/Public/Draft.md`);
  assert.equal(response.status, 404);

  response = await fetch(`${base}/view/${vault}/Family/Home.md`);
  assert.equal(response.status, 404);
  response = await fetch(`${base}/view/${vault}/Family/Home.md?key=${encodeURIComponent(secret)}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Family home/u);
  response = await fetch(`${base}/view/${vault}/Family/Home.md?key=${encodeURIComponent(secondSecret)}`);
  assert.equal(response.status, 200);
});
