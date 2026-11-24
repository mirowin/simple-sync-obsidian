import test from "node:test";
import assert from "node:assert/strict";
import { conflictPath, decideMerge } from "../src/merge.ts";

test("uploads a new local file", () => {
  assert.equal(decideMerge("a.md", "local", null, null).kind, "upload");
});

test("downloads a new remote file", () => {
  assert.equal(decideMerge("a.md", null, "remote", null).kind, "download");
});

test("downloads when only remote changed", () => {
  assert.equal(decideMerge("a.md", "base", "remote", "base").kind, "download");
});

test("uploads when only local changed", () => {
  assert.equal(decideMerge("a.md", "local", "base", "base").kind, "upload");
});

test("preserves a local edit when remote deleted", () => {
  assert.equal(decideMerge("a.md", "local", null, "base").kind, "conflict");
});

test("creates a readable conflict filename", () => {
  const path = conflictPath("Notes/idea.md", "abcdefghi", new Date("2026-11-24T12:34:56Z"));
  assert.equal(path, "Notes/idea.conflict-2026-11-24T12-34-56Z-abcdefghi.md");
});
