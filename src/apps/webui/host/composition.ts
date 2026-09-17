import { resolve } from "node:path";
import type { BootstrapOptions } from "../../../boot/bootstrap.js";
import { FileCredentialStore } from "../../../credentials/providers/file.js";
import { CredentialsService } from "../../../credentials/service.js";
import { FileSettingsStore } from "../../../settings/providers/file.js";
import { SettingsService } from "../../../settings/service.js";
import { startWebManagementHost, type WebRequestHandler } from "./management.js";
import { serveWishWebUiAsset } from "../server.js";
import { ComposerPreferences } from "./preferences.js";

/** Process composition only. Neither Settings nor Boot imports WebUI feature modules. */
export function managedWebUi(options: { readonly directory: string; readonly port: number; readonly assets?: WebRequestHandler }): NonNullable<BootstrapOptions["management"]> {
  return {
    directory: options.directory,
    async start(root, control, lifecycle) {
      const store = await FileSettingsStore.open(resolve(options.directory, "settings.json"));
      const settings = new SettingsService(root, store);
      const credentialStore = await FileCredentialStore.open(resolve(options.directory, "credentials.json"));
      const credentials = new CredentialsService(root, credentialStore, root.launch.environment);
      await root.plugin(ComposerPreferences);
      const host = await startWebManagementHost({ root, control, lifecycle, settings: settings.port,
        credentials: credentials.port, port: options.port, assets: options.assets ?? serveWishWebUiAsset });
      root.provide("webManagementHost", host);
      const stopSignals = root.launch.onSignal(signal => root.launch.complete(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143));
      process.stderr.write(`Wish management listening at ${host.url}\n`);
      return async () => { stopSignals(); await host.close(); };
    },
  };
}
