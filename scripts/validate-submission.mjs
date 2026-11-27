import { access, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const versions = JSON.parse(await readFile("versions.json", "utf8"));
const errors = [];

for (const file of ["README.md", "LICENSE", "manifest.json", "versions.json", "dist/main.js", "styles.css"]) {
  try {
    await access(file);
  } catch {
    errors.push(`Missing required file: ${file}`);
  }
}

if (!/^[a-z0-9-]+$/u.test(manifest.id ?? "")) errors.push("manifest.id must contain only lowercase letters, numbers, and hyphens");
if ((manifest.id ?? "").includes("obsidian")) errors.push("manifest.id must not contain 'obsidian'");
if (!/^\d+\.\d+\.\d+$/u.test(manifest.version ?? "")) errors.push("manifest.version must use x.y.z format");
if (manifest.version !== packageJson.version) errors.push("manifest.json and package.json versions must match");
if (!(manifest.version in versions)) errors.push("versions.json must contain the current plugin version");
if (typeof manifest.minAppVersion !== "string" || !/^\d+\.\d+\.\d+$/u.test(manifest.minAppVersion)) errors.push("minAppVersion must use x.y.z format");
if (typeof manifest.description !== "string" || manifest.description.length > 250) errors.push("description must be at most 250 characters");
if (typeof manifest.description === "string" && !manifest.description.endsWith(".")) errors.push("description must end with a period");
if (/\bobsidian\b/iu.test(manifest.description ?? "")) errors.push("description must not contain the redundant word 'Obsidian'");
if (versions[manifest.version] !== manifest.minAppVersion) errors.push("versions.json must map the current version to manifest.minAppVersion");
if (typeof manifest.name !== "string" || !manifest.name.trim()) errors.push("manifest.name is required");
if (typeof manifest.author !== "string" || !manifest.author.trim()) errors.push("manifest.author is required");
if (manifest.isDesktopOnly !== false) errors.push("isDesktopOnly must remain false for Android support");

if (errors.length) {
  console.error(errors.map(error => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log(`Obsidian submission files are valid for ${manifest.id} ${manifest.version}`);

