# Cordis HMR coordination patch

Upstream: DeepSeek Harness `vendor/hmr`, published as
`@deepseek-ai/cordis-plugin-hmr@1.0.17` (MIT). The installed package retains its upstream license.

Wish keeps upstream module resolution, dependency analysis, ESM/CJS cache invalidation and
Loader ownership. This patch adds an awaitable `hmr/reload-prepare` middleware before disposal,
structured failure/restart notifications, serialized change batches, awaited cleanup/activation,
and a post-drain deadline. `hmr/reload` remains a success notification after activation.
`hmr/reload-batch` wraps analysis/cache/import/prepare/apply so a Host can serialize the entire
batch with configuration writes. It is distinct from the inner Step-safety prepare middleware.
`watchConfig: false` disables only automatic Loader Include refresh, not explicit `registerConfig()`.

Registry deletion must happen before waiting on captured `Fiber.await()` calls. Direct Fiber
disposal can be interpreted as a user disable by Loader; calling a public effect disposer twice
does not join the first call's cleanup. On a deterministic candidate activation failure, version 5
disposes and joins candidate Fibers, restores the retained ESM/CJS namespace and plugin callback,
then verifies a newly instantiated old generation before reporting `restored`. A deadline, unknown
cleanup result, or failed restoration still halts subsequent batches and requires explicit recovery.

The Host middleware must honor the provided shutdown signal. Middleware must await `next()`
exactly once or throw to veto. Replacement modules must keep top-level imports free of domain
side effects: imports happen before preparation. A deadline cannot undo an initializer's external
effects; uncertain results require explicit recovery. Cordis 4.0.2 logs disposer exceptions
internally rather than rethrowing them from `Fiber.await()`. Consequently this adapter only admits
explicitly reviewed Step-local owners; it is not a general resource/state migration guarantee.

`apply-cordis-hmr-patch.mjs` uses the existing `diff` dependency, validates all target hashes before
writing, and is idempotent across clean or partially applied installs. No network or Git executable
is needed at install time. `postinstall`, `prebuild`, and `pretypecheck` invoke it. Keep the patch's
coordination marker intact: Boot refuses to start without `Hmr.coordinationVersion === 5`, even
when dependencies were installed with lifecycle scripts disabled. Keep the upstream
version pinned; do not update hashes to bypass a mismatch. Review source changes and regenerate
runtime/types patches together when rebasing. Keep the bundled runtime artifact consistent with
the source; `FiberState` is a type-only const enum in the upstream package.

Run `npm run test:code-reload` after rebasing. It includes a reconstructed clean dependency install,
idempotence/drift checks, native watcher races/failures and real Wish bootstrap/Run integration.
Managed WebUI uses the batch hook for its existing configuration/persistence transaction and
forces automatic config watching off; its Root exact-config watcher remains independent. Run
`npm run test:managed-code-reload` for real HTTP, Run continuity, disabled preferences and recovery.

Version 5 adds verified retained-generation restoration after deterministic candidate activation
failure. It preserves version 4's loaded-module content snapshots and ignores unchanged
compiler output before classifying full or partial reloads. Actual add/unlink changes
still reach normal import/error handling. The upgrade path accepts the previous
reviewed version 4 patch, and clean installation still validates upstream hashes.
