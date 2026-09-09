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
  Config as CliConfigSchema,
  type Config as CliPluginConfig,
} from "../src/apps/cli/plugin.js";
import {
  Config as WebUiConfigSchema,
  type Config as WebUiPluginConfig,
} from "../src/apps/webui/plugin.js";

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
const surface: Surface = "cli";
const signal: ProcessSignal = "SIGTERM";
const source: ConfigurationSource = "built-in";
const options: BootstrapOptions = { surface };
const booted: Promise<BootstrappedProcess> = bootstrap(options);
const launch: Launch | undefined = ctx.get("launch");
const cliConfig: CliPluginConfig = CliConfigSchema({
  dataDirectory: "state",
});
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
void signal;
void source;
void booted;
void launch;
void cliConfig;
void webUiConfig;
