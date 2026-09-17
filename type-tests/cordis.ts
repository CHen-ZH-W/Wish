import { Context, FiberState, Service, type Fiber } from "@deepseek-ai/cordis";
import Group from "@deepseek-ai/cordis-plugin-group";
import Hmr from "@deepseek-ai/cordis-plugin-hmr";
import Include from "@deepseek-ai/cordis-plugin-include";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import ConsoleExporter from "@deepseek-ai/cordis-plugin-logger-console";
import Timer from "@deepseek-ai/cordis-plugin-timer";
import Schema from "@deepseek-ai/schemastery";

import {
  bootstrap,
  type BootstrappedProcess,
  type BootstrapOptions,
} from "../src/boot/bootstrap.js";
import type {
  ConfigurationSource,
  Launch,
  ProcessSignal,
  Surface,
} from "../src/boot/launch.js";
import {
  Config as WebUiConfigSchema,
  type Config as WebUiPluginConfig,
} from "../src/apps/webui/plugin.js";
import {
  Application,
  Config as ApplicationConfigSchema,
  type Config as ApplicationPluginConfig,
} from "../src/apps/service.js";
import type { ToolRegistry } from "../src/core/tools/scheduler.js";
import { Tools } from "../src/tools/service.js";
import type { WishToolExecutionContext } from "../src/composition/tool-context.js";
import LocalFilesystem from "../src/filesystem/providers/local.js";
import LocalFilesystemSearch, {
  Config as FilesystemSearchConfigSchema,
} from "../src/filesystem/search/providers/local.js";
import {
  Config as SessionsConfigSchema,
  Sessions,
} from "../src/sessions/service.js";
import {
  Config as ModelsConfigSchema,
  Models,
} from "../src/models/service.js";
import {
  Config as ContextEngineConfigSchema,
  ContextEngine,
} from "../src/context/service.js";
import {
  Compaction,
  Config as CompactionConfigSchema,
} from "../src/compaction/service.js";
import {
  AgentLoop,
  Config as AgentLoopConfigSchema,
} from "../src/composition/agent-loop-service.js";
import {
  Config as RuntimeConfigSchema,
  Runtime as RuntimeService,
} from "../src/composition/runtime-service.js";
import {
  Agents,
  Config as AgentsConfigSchema,
} from "../src/composition/agent-service.js";
import {
  Config as WorkspaceConfigSchema,
  LocalWorkspace,
} from "../src/workspace/providers/local.js";
import { StorageHub } from "../src/storage/service.js";
import FileStoragePlugin from "../src/storage/providers/file/plugin.js";
import JournalRuntimeLifecycleProvider, {
  Config as RuntimeLifecycleConfigSchema,
} from "../src/core/runtime/durability/providers/journal.js";
import type { RuntimeLifecycleRecoveryReport } from
  "../src/core/runtime/durability/index.js";
import BlobToolResultArchiveProvider from
  "../src/tools/results/providers/blob.js";
import BlobToolOutputArtifacts from
  "../src/tools/results/artifacts/providers/blob.js";
import FileSessionPersistence from
  "../src/sessions/providers/file/plugin.js";
import { ApprovalHub } from "../src/approval/service.js";
import StorageApprovalRules from
  "../src/permissions/rules/providers/storage.js";
import {
  Config as PermissionsConfigSchema,
  DefaultPermissions,
} from "../src/permissions/providers/default.js";
import LinuxNativeShell from "../src/shell/providers/linux-native.js";
import DefaultSandboxPolicy from "../src/sandbox/providers/default.js";
import StoragePlan, {
  Config as PlanConfigSchema,
} from "../src/plan/providers/storage.js";
import StorageCoordinator, {
  Config as CoordinatorConfigSchema,
} from "../src/coordinator/providers/storage.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    testService: TestService;
  }
}

interface ProbeConfig {
  readonly label: string;
}

class TestService extends Service {
  static Config = Schema.object({
    label: Schema.string().default("test"),
  });

  constructor(ctx: Context, readonly config: ProbeConfig) {
    super(ctx, "testService");
  }
}

const ctx = new Context();
const provider: Fiber = ctx.plugin(TestService, { label: "test" });
const consumer: Fiber = ctx.inject(["testService"], (injected) => {
  const label: string = injected.testService.config.label;
  void label;
});
const pending: FiberState = FiberState.PENDING;

const loader: Fiber = ctx.plugin(Loader, { baseUrl: import.meta.url });
const include: Fiber = ctx.plugin(Include, { path: "./cordis.yml" });
const group: Fiber = ctx.plugin(Group, []);
const timer: Fiber = ctx.plugin(Timer);
const hmr: Fiber = ctx.plugin(Hmr, {
  root: ["."],
  ignored: [],
  debounce: 25,
});
const logger: Fiber = ctx.plugin(ConsoleExporter, {});
const toolsFiber: Fiber = ctx.plugin(Tools);
const approvalFiber: Fiber = ctx.plugin(ApprovalHub);
const filesystemFiber: Fiber = ctx.plugin(LocalFilesystem, {
  maxFileBytes: 64_000_000,
});
const filesystemSearchFiber: Fiber = ctx.plugin(LocalFilesystemSearch, {
  maxFiles: 50_000,
  maxDirectories: 10_000,
});
const filesystemSearchConfig = FilesystemSearchConfigSchema({
  maxFiles: 50_000,
  maxDirectories: 10_000,
});
const shellFiber: Fiber = ctx.plugin(LinuxNativeShell);
const approvalRulesFiber: Fiber = ctx.plugin(StorageApprovalRules, {
  backendId: "file",
});
const sandboxPolicyFiber: Fiber = ctx.plugin(DefaultSandboxPolicy);
const permissionsFiber: Fiber = ctx.plugin(DefaultPermissions, {
  defaultProfile: "approval-required",
});
const permissionsConfig = PermissionsConfigSchema({
  defaultProfile: "read-only",
});
const planFiber: Fiber = ctx.plugin(StoragePlan, { backendId: "file" });
const planConfig = PlanConfigSchema({ backendId: "file" });
const coordinatorFiber: Fiber = ctx.plugin(StorageCoordinator, { backendId: "file" });
const coordinatorConfig = CoordinatorConfigSchema({ backendId: "file" });
const dynamicToolRegistry: ToolRegistry<WishToolExecutionContext> = ctx.tools.registry;
const sessionsFiber: Fiber = ctx.plugin(Sessions, { dataDirectory: "state" });
const storageFiber: Fiber = ctx.plugin(StorageHub);
const storageFileFiber: Fiber = ctx.plugin(FileStoragePlugin, {
  id: "file",
  rootDirectory: "state/storage",
});
const runtimeLifecycleFiber: Fiber = ctx.plugin(
  JournalRuntimeLifecycleProvider,
  { backendId: "file" },
);
const runtimeLifecycleConfig = RuntimeLifecycleConfigSchema({
  backendId: "file",
});
const runtimeRecovery: Promise<RuntimeLifecycleRecoveryReport> =
  ctx.runtimeLifecycle.recoverInterrupted();
const archiveProviderFiber: Fiber = ctx.plugin(BlobToolResultArchiveProvider, {
  backendId: "file",
});
const outputArtifactsFiber: Fiber = ctx.plugin(BlobToolOutputArtifacts, {
  backendId: "file",
});
const sessionPersistenceFiber: Fiber = ctx.plugin(FileSessionPersistence);
const storageKv = ctx.storage.resolve("file", "kv");
const storageFileConfig = FileStoragePlugin.Config({
  id: "file",
  rootDirectory: "state/storage",
});
const sessionsConfig = SessionsConfigSchema({ dataDirectory: "state" });
const sessionManager = ctx.sessions.manager;
const contextHistory = ctx.sessions.history.context;
const compactionSessions = ctx.sessions.history.compaction;
const workspaceFiber: Fiber = ctx.plugin(LocalWorkspace, {
  instructionFiles: ["AGENTS.md"],
  maxInstructionBytes: 131_072,
});
const workspaceConfig = WorkspaceConfigSchema({
  instructionFiles: ["AGENTS.md"],
  maxInstructionBytes: 131_072,
});
const workspaceResolution = ctx.workspace.resolve({ root: "." });
const modelsFiber: Fiber = ctx.plugin(Models, { maxRetries: 2 });
const modelsConfig = ModelsConfigSchema({ maxRetries: 2 });
const modelProtocols: readonly string[] = ctx.models.registry.protocols();
const contextEngineFiber: Fiber = ctx.plugin(ContextEngine, {
  reservedOutputTokens: 1_024,
});
const contextEngineConfig = ContextEngineConfigSchema({
  reservedOutputTokens: 1_024,
});
const compactionFiber: Fiber = ctx.plugin(Compaction, {
  keepRecentTokens: 2_048,
  summaryMaxOutputTokens: 512,
});
const compactionConfig = CompactionConfigSchema({
  keepRecentTokens: 2_048,
  summaryMaxOutputTokens: 512,
});
const agentLoopFiber: Fiber = ctx.plugin(AgentLoop, { maxParallelCalls: 4 });
const agentLoopConfig = AgentLoopConfigSchema({ maxParallelCalls: 4 });
const runtimeFiber: Fiber = ctx.plugin(RuntimeService, {
  maxSteps: 32,
  generationDrainTimeoutMs: 30_000,
});
const runtimeConfig = RuntimeConfigSchema({
  maxSteps: 32,
  generationDrainTimeoutMs: 30_000,
});
const agentsFiber: Fiber = ctx.plugin(Agents, {
  agentId: "wish",
  agentInstructions: "Use the configured instructions.",
});
const agentsConfig = AgentsConfigSchema({ agentId: "wish" });
const agentId: string = ctx.agents.agentId;
const applicationFiber: Fiber = ctx.plugin(Application);
const surface: Surface = "cli";
const signal: ProcessSignal = "SIGTERM";
const source: ConfigurationSource = "built-in";
const options: BootstrapOptions = { surface };
const booted: Promise<BootstrappedProcess> = bootstrap(options);
const surfaceContext: Context = (await booted).surfaceContext;
const launch: Launch | undefined = ctx.get("launch");
const application: Application | undefined = ctx.get("application");
const applicationConfig: ApplicationPluginConfig = ApplicationConfigSchema({});
const webUiConfig: WebUiPluginConfig = WebUiConfigSchema({
  host: "127.0.0.1",
  port: 8790,
});

void provider;
void approvalFiber;
void filesystemFiber;
void filesystemSearchFiber;
void filesystemSearchConfig;
void shellFiber;
void approvalRulesFiber;
void sandboxPolicyFiber;
void permissionsFiber;
void permissionsConfig;
void planFiber;
void planConfig;
void coordinatorFiber;
void coordinatorConfig;
void consumer;
void pending;
void loader;
void include;
void group;
void timer;
void hmr;
void logger;
void toolsFiber;
void storageFiber;
void storageFileFiber;
void runtimeLifecycleFiber;
void runtimeLifecycleConfig;
void runtimeRecovery;
void archiveProviderFiber;
void outputArtifactsFiber;
void sessionPersistenceFiber;
void storageKv;
void storageFileConfig;
void dynamicToolRegistry;
void sessionsFiber;
void workspaceFiber;
void workspaceConfig;
void workspaceResolution;
void sessionsConfig;
void sessionManager;
void contextHistory;
void compactionSessions;
void modelsFiber;
void modelsConfig;
void modelProtocols;
void contextEngineFiber;
void contextEngineConfig;
void compactionFiber;
void compactionConfig;
void agentLoopFiber;
void agentLoopConfig;
void runtimeFiber;
void runtimeConfig;
void agentsFiber;
void agentsConfig;
void agentId;
void applicationFiber;
void signal;
void source;
void booted;
void surfaceContext;
void launch;
void application;
void applicationConfig;
void webUiConfig;
