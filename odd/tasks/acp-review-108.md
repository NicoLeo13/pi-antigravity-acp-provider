# ACP provider: address PR #108 review and split bridge policy from home isolation

Feature: review-driven corrections to `feat/minimal-bridge-tools` (PR #108) and a new independent PR for isolated `GEMINI_HOME`.

## Specs

S1. Bridge policy must not change shipped defaults. `toolBridge` defaults to `"all"` for existing and new installations; `"ecosystem"` (omitting `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` from the `pi-bridge` projection) is an explicit, documented opt-in.

S2. The opt-in must be documented with its implication, quoting the review: "Those names can have custom Pi implementations and hooks; native Antigravity tools are not interchangeable with those implementations or their security/audit hooks."

S3. Home isolation must fail clearly instead of succeeding silently: "src/acp/isolated-home.ts:22-30 silently accepts an existing non-symlink directory at <isolatedRoot>/antigravity-acp and returns success. Reproduced with a token in the real home and an empty ordinary directory at the isolated location: prepareIsolatedGeminiHome succeeds, but the child cannot see the saved token. Fail clearly without modifying unexpected user data, and test this case. Also handle concurrent link creation without treating every filesystem failure as a missing link."

S4. Link creation must be directory-appropriate and Windows-safe: "bare fs.symlinkSync(target, path) does not specify a directory/junction type and can require Windows symlink privileges." Use `type: "junction"` on `win32` and handle `EEXIST` as a concurrent-creation race, not as "missing link".

S5. `isolatedGeminiHome` defaults to `false` (opt-in), so neither new behavior is enabled by default before documentation and integration coverage exist.

S6. Both changes are independently reviewable: branch `feat/minimal-bridge-tools` (ex PR #108) carries only the opt-in `toolBridge` policy; branch `feat/isolated-gemini-home` carries only home isolation and targets `main`. Colon subcommands were reverted per L5.

## Tasks

- T1 — S1, S2: trim branch `feat/minimal-bridge-tools` to bridge policy only (`src/config.ts`, `src/mcp/bridge.ts`, `src/runtime.ts`, `src/shared-runtime.ts`, `README.md`, `test/config.test.ts`, `test/mcp-bridge.test.ts`).
- T2 — S3, S4, S5: new branch `feat/isolated-gemini-home` from `main` with hardened `src/acp/isolated-home.ts`, opt-in config/runtime wiring, `README.md`, `test/isolated-home.test.ts`, `test/config.test.ts`.
- T3 — `npm run check` green on both branches, except the known `runtime-safety` continuation failure inherited from base `8a1b0ff` (fixed upstream by #109).

## Log

L1 (user, verbatim): "En una de nuestras pr "feat(runtime): isolate GEMINI_HOME and add ecosystem toolBridgeMode - #108" tenemos nuevos comentarios. Corregilos y verifica tambien de que esten los cambios segun lo nuevo de "feat(extension): register direct colon subcommands - #110", comentando que tambien se considero eso en esta nueva revision"

L2 (user decision): split into two PRs (bridge policy / home isolation); `isolatedGeminiHome` defaults to `false`.

L3 (evidence): review `5988627999` by `zacbemis`, `CHANGES_REQUESTED` on `37163e05bf8acbc72fb2f80c1dc4b048f8f072e2`, three numbered points (S1, S3, S4 above) plus "Suggest splitting home isolation and bridge policy into independently reviewable changes; add user-facing documentation and integration tests before enabling either new default."

L4 (evidence): `feat/colon-commands` (PR #110) content is already commit `dd922f8` in `feat/minimal-bridge-tools`; at that time the rewrite had to preserve it.

L5 (user, 2026-11-26): chose "Corregir ramas y pushear" after both PRs were closed. The maintainer closed #110 in favor of Pi's `getArgumentCompletions` (upstream #123, merged) and #108 in favor of upstream #112. The colon-subcommand aliases are therefore reverted on this branch (commit `c680017`) and on `feat/multi-account`; no new PRs are opened. S6 now means this branch carries only the opt-in bridge policy.
