import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(repositoryRoot, "src", "apps", "webui", "public");
const target = join(repositoryRoot, "dist", "apps", "webui", "public");
const assets = ["index.html", "app.css", "app.js", "favicon.svg"];

await mkdir(target, { recursive: true });
await Promise.all(assets.map((asset) =>
  copyFile(join(source, asset), join(target, asset))
));
