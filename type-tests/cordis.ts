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
import type { BasicToolContext } from "../src/tools/support/context.js";
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
} from "../src/core/agent-loop/service.js";
import {
  Config as RuntimeConfigSchema,
  Runtime as RuntimeService,
} from "../src/core/runtime/service.js";
import {
  Agents,
  Config as AgentsConfigSchema,
} from "../src/core/agent/service.js";

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
const dynamicToolRegistry: ToolRegistry<BasicToolContext> = ctx.tools.registry;
const sessionsFiber: Fiber = ctx.plugin(Sessions, { dataDirectory: "state" });
const sessionsConfig = SessionsConfigSchema({ dataDirectory: "state" });
const sessionManager = ctx.sessions.manager;
const contextHistory = ctx.sessions.history.context;
const compactionSessions = ctx.sessions.history.compaction;
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
void consumer;
void pending;
void loader;
void include;
void group;
void timer;
void hmr;
void logger;
void toolsFiber;
void dynamicToolRegistry;
void sessionsFiber;
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
