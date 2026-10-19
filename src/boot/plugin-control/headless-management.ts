import type { BootstrapOptions } from "../bootstrap.js";

/** Explicit single-writer CLI Host. It shares the durable Root manager, not HTTP. */
export function headlessManagement(directory: string): NonNullable<BootstrapOptions["management"]> {
  return { directory, async start(_root, control) {
    control.setRecoveryAvailable(true);
    return async () => { control.setRecoveryAvailable(false); };
  } };
}
