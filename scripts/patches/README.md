# Cordis HMR coordination patch

Wish applies this patch to `@deepseek-ai/cordis-plugin-hmr@1.0.17` (MIT).
The installed package retains its license.

Cordis owns module resolution, dependency analysis, ESM/CJS cache invalidation and
Loader ownership. The patch provides an awaitable `hmr/reload-prepare` middleware before disposal,
structured failure/restart notifications, serialized change batches, awaited cleanup/activation,
and a post-drain deadline. `hmr/reload` remains a success notification after activation.
`hmr/reload-batch` wraps analysis/cache/import/prepare/apply so a Host can serialize the entire
batch with configuration writes. It is distinct from the inner Step-safety prepare middleware.
`watchConfig: false` disables only automatic Loader Include refresh, not explicit `registerConfig()`.

Registry deletion must happen before waiting on captured `Fiber.await()` calls. Direct Fiber
disposal can be interpreted as a user disable by Loader; calling a public effect disposer twice
does not join the first call's cleanup. On a deterministic candidate activation failure, HMR
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
when dependencies were installed with lifecycle scripts disabled. Package versions and target
hashes are pinned; an unknown version or modified target is rejected. Source, runtime and type
patches form one artifact. The installer also recognizes the exact hashes of the supported
older patch and upgrades them to the current artifact.

HMR compares loaded-module content snapshots before classifying full or partial reloads and
ignores unchanged compiler output. Actual add/unlink changes reach normal import/error handling.

`npm run test:code-reload` covers a reconstructed clean dependency install,
idempotence/drift checks, native watcher races/failures and real Wish bootstrap/Run integration.
Managed WebUI uses the batch hook for its existing configuration/persistence transaction and
forces automatic config watching off; its Root exact-config watcher remains independent. Run
`npm run test:managed-code-reload` for real HTTP, Run continuity, disabled preferences and recovery.
