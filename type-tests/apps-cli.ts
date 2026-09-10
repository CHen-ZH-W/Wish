import type { ModelEnvironment } from "../src/models/types.js";
import {
  loadWishHostConfiguration,
  type WishHostConfiguration,
} from "../src/apps/config.js";
import type { ApplicationOpenInput } from "../src/apps/service.js";
import {
  CliToolApprovalPort,
  createWishCli,
  formatWishCliControlReceipt,
  parseWishCliArguments,
  parseWishCliActiveInput,
  WishCliEventRenderer,
  type WishCli,
  type WishCliTerminal,
} from "../src/apps/cli/index.js";
import type { WishApplication } from "../src/apps/types.js";
import {
  ApplicationFacade,
  type ModelDependencies,
} from "../src/apps/application.js";
import type { AgentDependencies } from "../src/core/agent/service.js";
import { createFileSessionResources } from "../src/sessions/service.js";

declare const terminal: WishCliTerminal;
declare const environment: ModelEnvironment;
declare const configuration: WishHostConfiguration;
declare const models: ModelDependencies;
declare const agent: AgentDependencies;

const args = parseWishCliArguments([
  "run",
  "hello",
  "--model",
  "provider/model",
]);
const cli: WishCli = createWishCli({
  terminal,
  async openApplication(input) {
    const host = await loadWishHostConfiguration({ ...input, environment });
    return new ApplicationFacade({
      sessions: createFileSessionResources(host.dataDirectory),
      models,
      agent: agent.agent,
      ...(agent.generation === undefined
        ? {}
        : { runGeneration: agent.generation }),
    });
  },
});
const approval = new CliToolApprovalPort({ terminal });
const surfaceInput: ApplicationOpenInput = { approval };
const application: WishApplication = new ApplicationFacade({
  sessions: createFileSessionResources(configuration.dataDirectory),
  models,
  agent: agent.agent,
  ...(agent.generation === undefined
    ? {}
    : { runGeneration: agent.generation }),
});
const loaded: Promise<WishHostConfiguration> = loadWishHostConfiguration({
  modelsConfigurationPath: "models.json",
  environment,
});
const renderer = new WishCliEventRenderer(terminal);
const activeInput = parseWishCliActiveInput("keep the answer concise");
const controlReceipt: string = formatWishCliControlReceipt({
  accepted: true,
  kind: "steer",
  runId: "run-1",
  controlId: "control-1",
  position: 1,
});

void args;
void cli;
void surfaceInput;
void application;
void loaded;
void renderer;
void activeInput;
void controlReceipt;
