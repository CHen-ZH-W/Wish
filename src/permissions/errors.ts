import type { PermissionProfile } from "./types.js";

export class PermissionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermissionError";
  }
}

export class PermissionProfileUnavailableError extends PermissionError {
  readonly profile: PermissionProfile;

  constructor(profile: PermissionProfile, reason: string) {
    super(`Permission profile "${profile}" is unavailable: ${reason}`);
    this.name = "PermissionProfileUnavailableError";
    this.profile = profile;
  }
}

export class PermissionConfigurationError extends PermissionError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermissionConfigurationError";
  }
}
