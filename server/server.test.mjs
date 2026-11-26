import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";

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

test("viewer renders folder hierarchy, full-text index and Obsidian Bases without leaking private notes", async () => {
  const vault = "viewer-bases-123";
  await fetch(`${base}/v1/vaults/${vault}`, { method: "POST", headers: auth, body: "{}" });
  const encode = value => Buffer.from(value).toString("base64");
  const snapshot = {
    format: 1,
    siteTitle: "Money vault",
    updatedAt: Date.now(),
    rules: [
      { path: "Public", mode: "public" },
      { path: "Public/Money/Список/Секрет.md", mode: "private" }
    ],
    files: [
      {
        path: "Public/Money/Расходы.md",
        kind: "markdown",
        mtime: 10,
        content: encode("# Расходы\n\n![[БД.base]]\n\nНалик 191к +40к")
      },
      {
        path: "Public/Money/БД.base",
        kind: "asset",
        mtime: 11,
        content: encode(`filters:\n  file.inFolder("Public/Money/Список")\nviews:\n  - type: table\n    name: Крупные\n    filters:\n      and:\n        - amount >= 5000\n        - wife == false\n    order:\n      - file.name\n      - amount\n      - wife\n    summaries:\n      amount: Sum\n  - type: table\n    name: Жене\n    filters:\n      wife == true\n    order:\n      - file.name\n      - amount\n      - wife\n`)
      },
      {
        path: "Public/Money/Список/Еда.md",
        kind: "markdown",
        mtime: 12,
        content: encode("---\namount: 30000\nwife: false\n---\n# Еда\nОбычная покупка продуктов")
      },
      {
        path: "Public/Money/Список/Кошка.md",
        kind: "markdown",
        mtime: 13,
        content: encode("---\namount: 3000\nwife: true\n---\n# Кошка\nКорм и наполнитель")
      },
      {
        path: "Public/Money/Список/Секрет.md",
        kind: "markdown",
        mtime: 14,
        content: encode("---\namount: 999999\n---\n# Скрытая трата\nНЕ ДОЛЖНО ПОПАСТЬ В HTML")
      }
    ]
  };
  let response = await fetch(`${base}/v1/vaults/${vault}/publication`, {
    method: "PUT",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(snapshot)
  });
  assert.equal(response.status, 200);

  response = await fetch(`${base}/view/${vault}/Public/Money/Расходы.md`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /class="tree-folder"/u);
  assert.match(html, />Money</u);
  assert.match(html, />Список</u);
  assert.match(html, /class="obsidian-base"/u);
  assert.match(html, /class="base-tab active"/u);
  assert.match(html, /class="base-filter-toggle"/u);
  assert.match(html, /data-total="1"/u);
  assert.match(html, /data-filter-default="\{&quot;mode&quot;:&quot;and&quot;,&quot;conditions&quot;:\[/u);
  assert.match(html, /&quot;column&quot;:&quot;amount&quot;,&quot;operator&quot;:&quot;gte&quot;,&quot;value&quot;:&quot;5000&quot;/u);
  assert.match(html, /&quot;column&quot;:&quot;wife&quot;,&quot;operator&quot;:&quot;false&quot;/u);
  assert.match(html, /data-property="amount" data-type="number"/u);
  assert.match(html, /data-property="amount" data-type="number" data-value="30000"/u);
  assert.match(html, /data-summary="Sum" data-property="amount"/u);
  assert.match(html, /new URLSearchParams\(location\.search\)\.get\('bf'\)/u);
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/gu)) {
    assert.doesNotThrow(() => new Script(match[1]), "viewer must emit valid browser JavaScript");
  }
  assert.match(html, />30000</u);
  assert.match(html, />3000</u);
  assert.match(html, /Sum 33000/u);
  assert.match(html, /Как в Obsidian/u);
  assert.match(html, /Показать все/u);
  assert.match(html, /обычная покупка продуктов/u);
  assert.doesNotMatch(html, /НЕ ДОЛЖНО ПОПАСТЬ В HTML/u);
  assert.doesNotMatch(html, /999999/u);

  response = await fetch(`${base}/view/${vault}/Public/Money/БД.base`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /class="base-table"/u);
});
