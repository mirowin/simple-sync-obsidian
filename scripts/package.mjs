import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const release = resolve(root, "release");
const pluginDir = resolve(release, "simple-encrypted-sync");
const serverDir = resolve(release, "simple-encrypted-sync-server");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const version = manifest.version;
const pluginArchive = `simple-encrypted-sync-plugin-${version}.zip`;
const serverArchive = `simple-encrypted-sync-server-${version}.zip`;

await rm(release, { recursive: true, force: true });
await mkdir(pluginDir, { recursive: true });
await mkdir(serverDir, { recursive: true });
for (const file of ["manifest.json", "styles.css"]) await cp(resolve(root, file), resolve(pluginDir, file));
await cp(resolve(root, "dist/main.js"), resolve(pluginDir, "main.js"));
for (const file of ["docker-compose.yml", "Caddyfile", ".env.example", "README.md"]) await cp(resolve(root, file), resolve(serverDir, file));
await cp(resolve(root, "server"), resolve(serverDir, "server"), { recursive: true, filter: source => !source.includes("node_modules") && !source.endsWith("server.test.mjs") });
await cp(resolve(root, "deploy"), resolve(serverDir, "deploy"), { recursive: true });
await mkdir(resolve(serverDir, "scripts"), { recursive: true });
for (const file of ["install-vps.sh", "configure-vps.sh", "bootstrap-vps.sh"]) {
  await cp(resolve(root, "scripts", file), resolve(serverDir, "scripts", file));
}

for (const archive of [pluginArchive, serverArchive]) {
  await rm(resolve(release, archive), { force: true });
}
execFileSync("zip", ["-qr", pluginArchive, "simple-encrypted-sync"], { cwd: release });
execFileSync("zip", ["-qr", serverArchive, "simple-encrypted-sync-server"], { cwd: release });
