import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "@deepseek-ai/cordis";

import { createWishCli } from "../dist/apps/cli/index.js";
import Application from "../dist/apps/service.js";
import Agents from "../dist/composition/agent-service.js";
import AgentLoop from "../dist/composition/agent-loop-service.js";
import { bootstrap, BootstrapError } from "../dist/boot/bootstrap.js";
import Compaction from "../dist/compaction/service.js";
import ContextEngine from "../dist/context/service.js";
import Models from "../dist/models/service.js";
import Runtime from "../dist/composition/runtime-service.js";
import Sessions from "../dist/sessions/service.js";
import { StorageHub } from "../dist/storage/index.js";
import FileStorage from "../dist/storage/providers/file/plugin.js";
import JournalRuntimeLifecycleProvider from
  "../dist/core/runtime/durability/providers/journal.js";
import FileSessionPersistence from
  "../dist/sessions/providers/file/plugin.js";
import BlobToolResultArchiveProvider from
  "../dist/tools/results/providers/blob.js";
import Tools from "../dist/tools/service.js";
import LocalWorkspace from "../dist/workspace/providers/local.js";
import ApprovalHub from "../dist/approval/service.js";
import StorageApprovalRules from
  "../dist/permissions/rules/providers/storage.js";
import DefaultPermissions from "../dist/permissions/providers/default.js";
import LocalFilesystem from "../dist/filesystem/providers/local.js";
import LinuxNativeShell from "../dist/shell/providers/linux-native.js";
import DefaultSandboxPolicy from "../dist/sandbox/providers/default.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const fiberState = Object.freeze({ pending: 0, active: 2, disposed: 4 });

test("Application service is the only production composition boundary", async () => {
  const [facade, service, cliPlugin, webUiPlugin, bootstrapSource, catalogSource, profile] =
    await Promise.all([
      readFile(join(repositoryRoot, "src/apps/application.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/service.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/cli/plugin.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/apps/webui/plugin.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/boot/bootstrap.ts"), "utf8"),
      readFile(join(repositoryRoot, "src/boot/plugin-catalog.ts"), "utf8"),
      readFile(join(repositoryRoot, "config/cordis.yml"), "utf8"),
    ]);

  for (const source of [facade, service, cliPlugin, webUiPlugin, bootstrapSource]) {
    assert.doesNotMatch(
      source,
      /createWishApplication|createWishHostApplication|legacyApplication/u,
    );
  }
  await assert.rejects(access(join(repositoryRoot, "src/apps/legacy/plugin.ts")));
  assert.match(service, /export class Application extends Service/u);
  assert.match(service, /return new ApplicationFacade\(/u);
  assert.match(cliPlugin, /inject = \["launch", "approval", "application"\]/u);
  assert.match(
    webUiPlugin,
    /inject = \["launch", "approval", "approvalRules", "application"\]/u,
  );
  assert.match(
    service,
    /"launch",\s+"sessions",\s+"models",\s+"contextEngine",\s+"compaction",\s+"runtimeLifecycle",\s+"agents"/u,
  );
  assert.match(bootstrapSource, /installWishPluginCatalog/u);
  assert.match(catalogSource, /"application": "\.\.\/apps\/service\.js"/u);
  assert.match(profile, /id: application\s+name: 'cordis:application'/u);
  assert.ok(profile.indexOf("id: agents") < profile.indexOf("id: application"));
  assert.ok(profile.indexOf("id: application") < profile.indexOf("id: cli"));
  assert.ok(profile.indexOf("id: application") < profile.indexOf("id: webui"));
});

test("Application availability drives consumer PENDING, disposal, and reactivation", async () => {
  const events = [];
  const consumer = Object.assign(
    (ctx) => {
      assert.equal(typeof ctx.application.open, "function");
      events.push("activate");
      return () => {
        events.push("dispose");
      };
    },
    { inject: ["application"] },
  );
  const root = new Context();
  root.provide("launch", {
    cwd: process.cwd(),
    homeDirectory: process.cwd(),
    environment: {},
  });
  await root.plugin(Tools);
  await root.plugin(StorageHub);
  await root.plugin(FileStorage, {
    id: "file",
    rootDirectory: ".wish/storage",
  });
  await root.plugin(JournalRuntimeLifecycleProvider, { backendId: "file" });
  await root.plugin(BlobToolResultArchiveProvider, { backendId: "file" });
  await root.plugin(FileSessionPersistence);
  await root.plugin(Sessions, { dataDirectory: ".wish" });
  await root.plugin(LocalWorkspace);
  await root.plugin(ApprovalHub);
  await root.plugin(StorageApprovalRules, { backendId: "file" });
  await root.plugin(LocalFilesystem);
  await root.plugin(LinuxNativeShell);
  await root.plugin(DefaultSandboxPolicy);
  await root.plugin(DefaultPermissions);
  await root.plugin(Models);
  await root.plugin(ContextEngine);
  await root.plugin(Compaction);
  await root.plugin(AgentLoop);
  await root.plugin(Runtime);
  await root.plugin(Agents);
  const consumerFiber = root.plugin(consumer);

  try {
    assert.equal(consumerFiber.state, fiberState.pending);
    assert.deepEqual(events, []);

    const firstProvider = await root.plugin(Application);
    await consumerFiber.await();
    assert.equal(consumerFiber.state, fiberState.active);
    assert.deepEqual(events, ["activate"]);

    await firstProvider.dispose();
    assert.equal(root.get("application"), undefined);
    assert.equal(consumerFiber.state, fiberState.pending);
    assert.deepEqual(events, ["activate", "dispose"]);

    await root.plugin(Application);
    await consumerFiber.await();
    assert.equal(consumerFiber.state, fiberState.active);
    assert.deepEqual(events, ["activate", "dispose", "activate"]);
  } finally {
    await root.fiber.dispose();
  }

  assert.equal(consumerFiber.state, fiberState.disposed);
  assert.deepEqual(consumerFiber.getEffects(), []);
  assert.deepEqual(events, ["activate", "dispose", "activate", "dispose"]);
});

test("the real CLI surface cannot boot without the Application service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wish-application-pending-"));

  try {
    await writeFile(
      join(directory, "cordis.yml"),
      `- id: cli
  name: 'cordis:cli'
`,
    );
    await assert.rejects(
      bootstrap({
        surface: "cli",
        argv: ["--version"],
        cwd: directory,
        homeDirectory: directory,
        environment: {},
        configurationFile: join(directory, "cordis.yml"),
      }),
      (error) =>
        error instanceof BootstrapError &&
        /pending \(waiting for approval, application\)/u.test(error.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI help and version keep Application opening lazy", async () => {
  let applicationOpens = 0;

  const run = async (argv) => {
    let output = "";
    let error = "";
    const terminal = {
      interactive: false,
      async readLine() {
        throw new Error("help/version must not read a line");
      },
      async readAll() {
        throw new Error("help/version must not read stdin");
      },
      async writeOutput(text) {
        output += text;
      },
      async writeError(text) {
        error += text;
      },
      close() {},
    };
    const cli = createWishCli({
      terminal,
      async openApplication() {
        applicationOpens += 1;
        throw new Error("help/version must not open an Application");
      },
    });
    assert.equal(await cli.run(argv), 0);
    assert.equal(error, "");
    return output;
  };

  assert.match(await run(["--help"]), /Usage:\n  wish/u);
  assert.equal(await run(["--version"]), "wish 0.1.0\n");
  assert.equal(applicationOpens, 0);
});
