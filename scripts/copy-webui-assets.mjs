import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repositoryRoot, "src", "apps", "webui", "public");
const target = join(repositoryRoot, "dist", "apps", "webui", "public");
const assets = ["index.html", "app.css", "favicon.svg"];
const profileSource = join(repositoryRoot, "config", "cordis.yml");
const profileTarget = join(repositoryRoot, "dist", "config", "cordis.yml");

await mkdir(target, { recursive: true });
await mkdir(dirname(profileTarget), { recursive: true });
// Exact generated files from the retired shell; do not clean unrelated build output.
await Promise.all(["app.js", "next.html", "next.css"].map(asset => rm(join(target, asset), { force: true })));
await Promise.all([
  ...assets.map((asset) => copyFile(join(source, asset), join(target, asset))),
  copyFile(profileSource, profileTarget),
]);
