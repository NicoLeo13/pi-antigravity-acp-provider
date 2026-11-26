# Fork branch unification

Objective: update every local branch of the provider fork to the latest upstream, resolve conflicts, and consolidate `multi-account` + `colon-commands` into `feat/barebones-acp`, dropping the custom isolation now that upstream #112 covers it. Runner: `npm run check` (`tsc --noEmit && vitest run`), `npm pack --dry-run`. No push, PR or publish without explicit user approval.

## Specs

S1. "Para pi-antigravity-acp-provider, quiero que nos queden todas las ramas actualizadas y los conflictos resueltos, asi como tambien en la barepones/acp, tenes tambien lo de multi-accounty los colon-commands. El main llevalo a la ultima version. Respecto a lo del #112, resuelve lo que queriamos hacer con lo de nuestro aislamiento? porque si es asi, deberiamos droppear el nuestro quiza? Con gentle-ai hace como decis." — scope: provider repo branches only; gentle-ai keeps its current `local/combined` pattern.

S2. `main` must be fast-forwarded to the latest `origin/main` (`755259c` at task creation; fetch first). No feature work lands on `main`.

S3. Every local feature branch (`feat/isolated-gemini-home`, `feat/minimal-bridge-tools`, `feat/multi-account`, `feat/colon-commands`, `feat/barebones-acp`) receives the updated `main` by **merge, not rebase**, preserving already-pushed fork history. Conflicts must be resolved by keeping both sides' intent; RED→GREEN where behavior changes.

S4. `feat/barebones-acp` must contain `colon-commands` and keep `toolBridge: "ecosystem"` as the fork default, and **drop** both our custom `isolatedGeminiHome` / `src/acp/isolated-home.ts` implementation and `multi-account` (user decision L6). Upstream `1f43ef0` (#112) already redirects the child to `$PI_CODING_AGENT_DIR/antigravity-acp-provider/gemini` with `AGY_ACP_FORCE_FILE_STORAGE=1` and per-profile credentials, superseding our shared-credential symlink isolation and the separate account list. Acceptance: no `isolatedGeminiHome` config key, no isolated-home command, no custom symlink root, no multi-account merge into barebones; docs and tests updated.

S5. gentle-ai stays as-is: fork `main` mirrors upstream and `local/combined` carries the four PR branches. No branch mutation there.

## Tasks

- T1 — S1: verify #112 semantics and create this document. Route: inline. Risk: none (read-only plus doc). DONE.
- T2 — S2: fetch and `git merge --ff-only origin/main` on `main`. Route: inline. Risk: none (fast-forward of local main). DONE — local main `8a1b0ff` → `755259c`, no feature work on main.
- T3 — S3: merge updated `main` into each feature branch; resolve conflicts. Route: inline. Risk: item 3 (published fork branch history) — merge, never rebase; preserve pushed commits. DONE — all five branches contain `main` (`755259c`) verified by `git merge-base --is-ancestor`; conflicts resolved per branch.
- T4 — S4: keep `ecosystem` and `colon-commands` in `feat/barebones-acp`, drop custom isolation, and **drop `multi-account`** per the user decision in L6 (#112 supersedes it). Route: inline. Risk: item 3 and item 5 (config/default and environment contract). DONE — `barebones-acp` contains `main` + `feat/minimal-bridge-tools` + `feat/colon-commands`; no `isolatedGeminiHome`/`isolated-home` remains; `toolBridge` defaults to `ecosystem`.
- T5 — S1, S5: verify provider branches (`npm run check`, `npm pack --dry-run`, branch containment) and confirm gentle-ai untouched. Route: inline; independent verifier for the named high-risk item. DONE — typecheck exit 0; focused 54/54; pack exit 0 (45 files); full suite 532 pass / 3 fail / 8 skip, all three failures classified (1 pre-existing at main, 2 flaky passing alone); independent verifier launched.

## Log

L1 (user, verbatim): "Para pi-antigravity-acp-provider, quiero que nos queden todas las ramas actualizadas y los conflictos resueltos, asi como tambien en la barepones/acp, tenes tambien lo de multi-accounty los colon-commands. El main llevalo a la ultima version. Respecto a lo del #112, resuelve lo que queriamos hacer con lo de nuestro aislamiento? porque si es asi, deberiamos droppear el nuestro quiza? Con gentle-ai hace como decis."

L2 (evidence, #112): `origin/main:src/acp/credential-storage.ts:16-31` — `fileBackedAcpEnvironment()` pins `GEMINI_HOME=<configRoot>/gemini` and `AGY_ACP_FORCE_FILE_STORAGE=1`; `providerAcpEnvironment()` applied unconditionally in `origin/main:src/runtime.ts:1249-1257`; `origin/main:README.md:71` — server token lives under `$PI_CODING_AGENT_DIR/antigravity-acp-provider/gemini/antigravity-acp/`, each Pi profile has its own login, no shared `GEMINI_HOME`/keychain, re-login required when upgrading from the shared store. This achieves the "agy loads no gentle-ai/engram from `~/.gemini`" goal and additionally isolates accounts.

L3 (decision): drop our `isolatedGeminiHome` implementation instead of carrying a second, weaker isolation that symlinks back to shared `~/.gemini/antigravity-acp`. Consequence to surface to user: after adopting #112, credentials move to the provider home and a fresh `/login antigravity-acp` may be needed; no authenticated login can be performed by the agent.

L4 (baseline state): provider `main`/`fork/main` `8a1b0ff` behind `origin/main` `755259c` by 15; `feat/barebones-acp` `857f131` local-only; `feat/multi-account` `bf7f109` and `feat/colon-commands` `06e50c1` not ancestors of it; gentle-ai `local/combined` `c669e50cd` contains all four PR branches and stays untouched.

L5 (T2–T3 evidence): `main` fast-forwarded `8a1b0ff..755259c`. Branch commits: `0bc3d80` (isolated branch superseded), `2f6b045`/`8ae44a8` (tool bridge synced and tests aligned), `27eac17` (multi-account superseded to main content), `0949da9` (colon aliases synced), `d939b77` (barebones rebased onto #112), `78cf9f8` (ecosystem ported onto new bridge API). All five branches contain main; barebones contains minimal-bridge-tools and colon-commands.

L6 (user decision, 2026-11-26): Asked whether to drop multi-account given #112; user chose "Droppearlo (Recommended)". Implemented: `feat/multi-account` content is now main content, its original commits remain in history via a merge (no rebase, no push), and it is NOT merged into barebones.

L7 (T4 evidence): barebones `src/config.ts` defaults `toolBridge: "ecosystem"` with explicit `all` still round-tripping; `src/mcp/bridge.ts` ports `CORE_PI_TOOLS` omission onto the new single-argument bridge API; `extensions/index.ts` keeps the `tool-bridge` command, doctor line and colon aliases; `README.md` documents ecosystem default; no `isolatedGeminiHome`, `isolated-home` command or `isolated-home.ts` anywhere.

L8 (T5 evidence): `npm run typecheck` exit 0; focused `test/config.test.ts`, `test/extension.test.ts`, `test/command-completions.test.ts` 54/54; `npm pack --dry-run` exit 0, 45 files; `npm run check` 543 tests: 532 passed, 3 failed, 8 skipped. Failure `runtime-safety > commits consumed tool continuation context...` fails identically at base `main` (verified in detached worktree). Two `late-tool-result` failures are flaky under parallel load and pass alone (6/6). No push, PR, publish or install performed. gentle-ai untouched.

L9 (next step): incorporate independent verifier verdict, then hand over. Push/PR remain user decisions.
