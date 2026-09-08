import type { ModelEnvironment } from "../src/models/types.js";
import {
  createWishHostApplication,
  loadWishHostConfiguration,
  type WishHostConfiguration,
} from "../src/apps/config.js";
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

declare const terminal: WishCliTerminal;
declare const environment: ModelEnvironment;
declare const configuration: WishHostConfiguration;

const args = parseWishCliArguments([
  "run",
  "hello",
  "--model",
  "provider/model",
]);
const cli: WishCli = createWishCli({ terminal, environment });
const approval = new CliToolApprovalPort({ terminal });
const application: WishApplication = createWishHostApplication(configuration, {
  approval,
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
void application;
void loaded;
void renderer;
void activeInput;
void controlReceipt;
