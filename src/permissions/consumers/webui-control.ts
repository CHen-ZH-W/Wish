import type { Context } from "@deepseek-ai/cordis";

import {
  registerManagedWebUiControl,
  WebUiControlError,
  type WebUiControl,
} from "../../apps/webui/controls.js";
import { StorageConflictError } from "../../storage/errors.js";
import {
  PERMISSION_PROFILES,
  type PermissionProfile,
} from "../types.js";
import {
  SessionPermissionProfileUnavailableError,
  type SessionPermissionProfilesPort,
} from "../session-profiles.js";

export const PERMISSION_PROFILE_WEBUI_CONTROL = "permission-profile";

/** Permissions owns its browser-safe transport contract; WebUI only dispatches it. */
export function createPermissionProfileWebUiControl(): WebUiControl {
  const control: WebUiControl = {
    inspectDefault(application) {
      return translate(() => requireProfiles(application.sessionPermissions).inspectDefault());
    },
    inspectSession(application, sessionId, signal) {
      return translate(() => requireProfiles(application.sessionPermissions).inspect(sessionId, signal));
    },
    updateSession(application, sessionId, body, signal) {
      return translate(() => {
        requireOnlyProfile(body);
        return requireProfiles(application.sessionPermissions).select(
          sessionId,
          permissionProfile(body.profile),
          signal,
        );
      });
    },
  };
  return Object.freeze(control);
}

function requireProfiles(value: SessionPermissionProfilesPort | undefined): SessionPermissionProfilesPort {
  if (value === undefined) {
    throw new WebUiControlError(503, "permission_profile_unavailable", "Session permission profiles are unavailable");
  }
  return value;
}

async function translate<T>(action: () => Promise<T> | T): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof WebUiControlError) throw error;
    if (error instanceof SessionPermissionProfileUnavailableError) {
      throw new WebUiControlError(409, "permission_profile_unavailable", error.message);
    }
    if (error instanceof StorageConflictError) {
      throw new WebUiControlError(409, "permission_profile_conflict", "Permission profile changed concurrently; reload and try again");
    }
    throw error;
  }
}

function requireOnlyProfile(body: Readonly<Record<string, unknown>>): void {
  if (Object.keys(body).length !== 1 || !("profile" in body)) {
    throw new WebUiControlError(400, "invalid_request", "Expected only profile");
  }
}

function permissionProfile(value: unknown): PermissionProfile {
  if (typeof value === "string" && (PERMISSION_PROFILES as readonly string[]).includes(value)) {
    return value as PermissionProfile;
  }
  throw new WebUiControlError(400, "invalid_permission_profile", "Unknown permission profile");
}

export default {
  name: "permissions-webui-control",
  inject: ["application", "webUiControls"],
  apply(ctx: Context): void {
    registerManagedWebUiControl(ctx, PERMISSION_PROFILE_WEBUI_CONTROL, createPermissionProfileWebUiControl());
  },
};
