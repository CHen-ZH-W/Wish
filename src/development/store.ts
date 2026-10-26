import type { StorageBackendResolver } from "../storage/backend.js";
import { DOMAIN_ABSENT, StorageDomain, type DomainSpec } from "../storage/domain.js";
import type { DevelopmentProject, DevelopmentStore } from "./types.js";
import { canonical, requireDevelopment, validateProject } from "./validation.js";

export const DEVELOPMENT_DOMAIN_ID = "development/projects";
export class MemoryDevelopmentStore implements DevelopmentStore {
  private readonly projects = new Map<string, DevelopmentProject>();
  async get(id: string) { return this.projects.get(id); }
  async list() { return Object.freeze([...this.projects.values()]); }
  async put(project: DevelopmentProject, expectedRevision: number) {
    requireDevelopment((this.projects.get(project.id)?.revision ?? 0) === expectedRevision && project.revision === expectedRevision + 1, "development_conflict");
    this.projects.set(project.id, validateProject(project));
  }
  async close() {}
}
export class DomainDevelopmentStore implements DevelopmentStore {
  private readonly domain: StorageDomain<string, DevelopmentProject>;
  constructor(private readonly storage: StorageBackendResolver, private readonly backendId: string) {
    const spec: DomainSpec<string, DevelopmentProject> = { id: DEVELOPMENT_DOMAIN_ID, schemaVersion: 1, shape: "keyed", requirements: { writerConcurrency: "process-local", kv: { list: true } },
      resolve: key => ({ key, default: DOMAIN_ABSENT }), encode: value => new TextEncoder().encode(canonical(value)),
      decode: bytes => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), validate: validateProject };
    this.domain = new StorageDomain({ storage, backendId, spec });
  }
  async get(id: string) { return (await this.domain.resolve(id).load())?.value; }
  async list(): Promise<readonly DevelopmentProject[]> {
    const keys = await this.storage.resolve(this.backendId, "kv").list!({ namespace: DEVELOPMENT_DOMAIN_ID });
    const projects = await Promise.all(keys.map(key => this.get(key.key)));
    return Object.freeze(projects.filter((project): project is DevelopmentProject => project !== undefined));
  }
  async put(project: DevelopmentProject, expectedRevision: number): Promise<void> {
    const target = this.domain.resolve(project.id), current = await target.load();
    requireDevelopment((current?.value.revision ?? 0) === expectedRevision && project.revision === expectedRevision + 1, "development_conflict");
    await target.save(validateProject(project), current ? { kind: "revision", revision: current.revision! } : { kind: "absent" });
  }
  async close() {}
}
