# Barebones ACP isolation

Objective: one branch carrying all fork changes so Pi/gentle-shell owns the ODD and the agy ACP process loads no gentle-ai or engram guidance. Branch: `feat/barebones-acp` (from `feat/minimal-bridge-tools`). Delivery: local work-unit commits; no push, PR or publish without explicit user approval. Runner: `npm run check` (`tsc --noEmit && vitest run`), `npm pack --dry-run`.

## Specs

S1. "Entonces como lo arreglamos/parcheamos? Juntamos todo en una misma rama con todos nuestros cambios para que quede aislado y gaste poco? Es decir, que mande pi/gentle-shell y agy no cargue nada de gentle-ai, engram y todo eso cuando se usa via acp. No habiamos implementado ya algo asi?" — authorized scope: the fork provider repo only; produce one branch with isolation + ecosystem tool bridge, safe defaults, docs and tests. Acceptance: ACP child runs with an isolated `GEMINI_HOME`, Pi's composed system prompt is still forwarded, and no published/pushed artifact is created.

S2. "que mande pi/gentle-shell y agy no cargue nada de gentle-ai, engram y todo eso cuando se usa via acp" — acceptance: the child environment points `GEMINI_HOME` at a clean root that shares only `antigravity-acp` credentials via symlink; `~/.gemini/config/AGENTS.md` and `~/.gemini/antigravity-cli/` are not visible to agy; Pi's prompt still reaches agy as a reconstruction resource (`docs/REQUIREMENTS.md:55-59`, `src/stream/context.ts:46-47,91-94,130`).

S3. "Juntamos todo en una misma rama con todos nuestros cambios" — acceptance: a single branch contains hardened isolation from `5de4cf8` (`src/acp/isolated-home.ts`, Windows junction, non-symlink guard) plus `toolBridge: "ecosystem"` from `52b2c19`; do not resurrect the older, less safe `37163e0` implementation; preserve untracked `skills/`.

S4. Defaults on this fork branch make the isolated, low-overhead path automatic: `isolatedGeminiHome: true` and `toolBridge: "ecosystem"`; explicit user config still overrides. Acceptance: `loadConfig()` returns these defaults; existing tests pinning `all`/`false` are updated deliberately; `save*` helpers still round-trip explicit values.

## Tasks

- T1 — S3: create `feat/barebones-acp` from `feat/minimal-bridge-tools` and bring `5de4cf8` isolation onto it; resolve conflicts in the seven overlapping files, keep both features. Route: inline. Risk: none (branch-local git, no remote). DONE in `32d867b` — 9 files, 383 insertions, 4 deletions; typecheck green; focused tests 44/44.
- T2 — S1, S4: RED test for the new defaults, then flip `src/config.ts` defaults and update `README.md` and the extension selector text; GREEN focused tests. Route: inline. Risk: item 3 (config defaults others consume) and item 5 (installed package behavior) → independent verifier at T3.
- T3 — S1-S4: run `npm run check` and `npm pack --dry-run`; verify the child env/resource contract and that no published/pushed artifact exists; independent verifier for the named high-risk items. Route: inline + independent verifier.
- T4 — S2: activate the built branch in the local Pi installation and set the user config explicitly; verify the local install no longer inherits ambient `HOME`/`GEMINI_HOME`. Route: inline. Risk: item 5 (local environment) → re-run the focused check after activation.

## Log

L1 (user, verbatim): "Entonces como lo arreglamos/parcheamos? Juntamos todo en una misma rama con todos nuestros cambios para que quede aislado y gaste poco? Es decir, que mande pi/gentle-shell y agy no cargue nada de gentle-ai, engram y todo eso cuando se usa via acp. No habiamos implementado ya algo asi?"

L2 (user, previous turn, verbatim): "No habiamos implementado ya algo asi?" — answer: yes. `37163e0` added isolation + ecosystem on an earlier stack; `4524d8c` removed isolation from the current `feat/minimal-bridge-tools` branch; the hardened reimplementation is `5de4cf8` on `feat/isolated-gemini-home` (PR #108 closed in favor of upstream #112 per `odd/tasks/acp-review-108.md` L5). Upstream `origin/main` has `1f43ef0` (#112) which redirects `GEMINI_HOME` via `providerAcpEnvironment()` but is not in the fork branch or installed npm 0.1.19.

L3 (evidence): `git branch -a --contains` — `5de4cf8` only in `feat/isolated-gemini-home`; current branch `52b2c19` contains `37163e0` then removal `4524d8c`; `merge-base(52b2c19,5de4cf8)=8a1b0ff`. `src/config.ts` on current branch: `toolBridge` default `all`, no isolation key. `5de4cf8:src/config.ts` has `isolatedGeminiHome` default `false`; `5de4cf8:src/acp/isolated-home.ts` has `prepareIsolatedGeminiHome`/`applyIsolatedGeminiEnvironment` with junction and non-symlink guards.

L4 (decision): use the hardened `5de4cf8` implementation, not `37163e0`; flip both defaults on this fork branch because the user asked for isolated and cheap by default; keep explicit config override. Ecosystem omits core Pi tool names from the bridge (native agy tools then handle them), which reduces token overhead but reduces Pi-side hook control; this tradeoff is accepted to match the measured `4_gentle_shell_optimized` scenario.

L5 (evidence, user measurements in `~/.gemini/antigravity-cli/brain/d8cf642a-.../scratch/measure_real_task.ts`): `1_agy_bare` 16,115 input + 13,682 cacheRead; `2_agy_gentle_ai_engram` 20,304 + 17,866; `3_gentle_shell_unoptimized` 37,238 input; `4_gentle_shell_optimized` (isolated home + ecosystem) 33,730 input.

L6 (T1 evidence): `feat/barebones-acp` created from `52b2c19`; cherry-pick of `5de4cf8` resolved by keeping BOTH `toolBridge` and `isolatedGeminiHome` fields, setters, options, command handlers, doctor lines and tests; the two shared closing braces (`config.ts` save helper, `runtime.ts` setter) were restored after mechanical conflict concatenation. Hardened files `src/acp/isolated-home.ts` and `test/isolated-home.test.ts` added unchanged. No remote operation.

L7 (next step): T2 — RED test for isolated/ecosystem defaults, then flip both defaults and update docs/selector.
