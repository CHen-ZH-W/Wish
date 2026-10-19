import { constants } from "node:fs";
import { open, mkdir, rename, readdir, rm, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, digest } from "../agent-profiles/validation.js";
import { verifyCode } from "../agent-profiles/composition.js";
import { artifact, fail, sha } from "./validation.js";
import type { CandidateArtifact } from "./types.js";

/** Host publishes only bounded regular-file bytes, never a child-owned inode/symlink. */
export class CandidateArtifacts {
  constructor(readonly directory: string) {}
  path(key: string): string { return join(this.directory, sha(key)); }
  async put(value: CandidateArtifact): Promise<CandidateArtifact> {
    const data = artifact(value); await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const destination = this.path(data.digest);
    try { return await this.get(data.digest); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const staging = join(this.directory, `stage-${randomUUID()}`); await mkdir(staging, { mode: 0o700 });
    for (const [name, content] of Object.entries({ ...data.files, "artifact.json": canonical(data) })) {
      const filename = join(staging, name); await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
      const file = await open(filename, "wx", 0o400);
      try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
    }
    try { await rename(staging, destination); }
    catch (error) { if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; await rm(staging, { recursive: true }); }
    const parent = await open(this.directory, "r"); try { await parent.sync(); } finally { await parent.close(); }
    return this.get(data.digest);
  }
  async get(key: string): Promise<CandidateArtifact> {
    const directory = this.path(key);
    if (await realpath(directory) !== resolve(directory)) fail("candidate_artifact_symlink");
    const data = artifact(JSON.parse(await regularFile(join(directory, "artifact.json"), 8 * 1024 * 1024)));
    if (data.digest !== key) fail("candidate_artifact_digest_mismatch");
    for (const [name, expected] of Object.entries(data.files)) if (await regularFile(join(directory, name), 4 * 1024 * 1024) !== expected) fail("candidate_artifact_changed");
    const actual: string[] = [];
    const visit = async (path: string, prefix = "") => {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const name = prefix + entry.name;
        if (entry.isDirectory()) await visit(join(path, entry.name), `${name}/`);
        else if (entry.isFile()) actual.push(name);
        else fail("candidate_artifact_symlink");
        if (actual.length > 130) fail("candidate_artifact_changed");
      }
    };
    await visit(directory);
    if (digest(actual.sort()) !== digest([...Object.keys(data.files), "artifact.json"].sort())) fail("candidate_artifact_changed");
    await verifyCode(data.hostCode);
    return data;
  }
}
export async function regularFile(filename: string, limit: number): Promise<string> {
  if (await realpath(dirname(filename)) !== resolve(dirname(filename))) fail("candidate_artifact_symlink");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = await handle.stat(); if (!stats.isFile() || stats.size > limit || stats.nlink !== 1) fail("candidate_file_limit");
    const bytes = await handle.readFile(); if (bytes.byteLength > limit) fail("candidate_file_limit"); return bytes.toString("utf8");
  } finally { await handle.close(); }
}
