import { cp, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const release = resolve(root, "release");
const pluginDir = resolve(release, "simple-encrypted-sync");
const serverDir = resolve(release, "simple-encrypted-sync-server");

await rm(release, { recursive: true, force: true });
await mkdir(pluginDir, { recursive: true });
await mkdir(serverDir, { recursive: true });
for (const file of ["manifest.json", "styles.css"]) await cp(resolve(root, file), resolve(pluginDir, file));
await cp(resolve(root, "dist/main.js"), resolve(pluginDir, "main.js"));
for (const file of ["docker-compose.yml", "Caddyfile", ".env.example", "README.md"]) await cp(resolve(root, file), resolve(serverDir, file));
await cp(resolve(root, "server"), resolve(serverDir, "server"), { recursive: true, filter: source => !source.includes("node_modules") && !source.endsWith("server.test.mjs") });

for (const archive of ["simple-encrypted-sync-plugin-0.1.0.zip", "simple-encrypted-sync-server-0.1.0.zip"]) {
  await rm(resolve(release, archive), { force: true });
}
execFileSync("zip", ["-qr", "simple-encrypted-sync-plugin-0.1.0.zip", "simple-encrypted-sync"], { cwd: release });
execFileSync("zip", ["-qr", "simple-encrypted-sync-server-0.1.0.zip", "simple-encrypted-sync-server"], { cwd: release });
