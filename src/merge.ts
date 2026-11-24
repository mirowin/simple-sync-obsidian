import type { MergeDecision } from "./types";

export function decideMerge(path: string, local: string | null, remote: string | null, base: string | null): MergeDecision {
  if (local === remote) return { kind: "same", path };

  if (base === null) {
    if (local === null) return { kind: "download", path };
    if (remote === null) return { kind: "upload", path };
    return { kind: "conflict", path };
  }

  if (local === base) {
    return remote === null ? { kind: "delete-local", path } : { kind: "download", path };
  }

  if (remote === base) {
    return local === null ? { kind: "delete-remote", path } : { kind: "upload", path };
  }

  if (local === null) return { kind: "download", path };
  if (remote === null) return { kind: "conflict", path };
  return { kind: "conflict", path };
}

export function conflictPath(path: string, deviceId: string, time = new Date()): string {
  const safeDevice = deviceId.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 20) || "device";
  const suffix = `${time.toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/u, "Z")}-${safeDevice}`;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExtension = dot > slash;
  return hasExtension
    ? `${path.slice(0, dot)}.conflict-${suffix}${path.slice(dot)}`
    : `${path}.conflict-${suffix}`;
}
