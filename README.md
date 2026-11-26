# pi-antigravity-acp-provider

A first-class [Pi](https://github.com/earendil-works/pi) provider for **Google Antigravity** through its official ACP server.

> **Important:** this package no longer uses `@google/gemini-cli`. The Gemini CLI individual Code Assist login path was retired and is not a supported authentication route. Antigravity/`agy` is the target runtime.

## Features

- Registers `antigravity-acp/*` models backed by Google Antigravity.
- Uses ACP protocol v1 and the official TypeScript SDK.
- Collapses Antigravity's effort-qualified IDs into one entry per model; Pi's Shift+Tab reasoning control selects low/medium/high and, where advertised, xhigh dynamically.
- Estimates token costs from known model-family catalog rates; these are reference estimates, not Antigravity subscription charges.
- Supports Pi streaming, cancellation, usage/quota metadata, lifecycle cleanup, and persisted ACP session restoration across Pi restarts.
- Routes compatible Pi tools through an authenticated loopback MCP bridge; doctor/status names omitted tools and their reasons.
- Supports persisted `default`, `auto-edit`, and `yolo` Antigravity permission modes. The requested default is `yolo`; switching to a prompting mode retains the single-use, fail-closed Pi permission broker.
- Advertises no ACP filesystem or terminal client capabilities.
- Provides setup, auth-health, logout/account-switching, qualification, quota, and runtime-update commands.
- Automatically checks for newer managed ACP runtimes once per day, with `automatic`, `notify`, and `manual` update modes.
- Uses an Ed25519-signed runtime catalog with exact Google artifact URLs, archive hashes and sizes, strict two-file extraction, pre-activation ACP identity/version validation, immutable releases, rollback retention, musl rejection, macOS quarantine cleanup, and Windows process-tree handling.

## New-user setup

Install from the official Pi package gallery/npm:

```bash
pi install npm:pi-antigravity-acp-provider
pi
```

To run from source instead:

```bash
git clone https://github.com/zacbemis/pi-antigravity-acp-provider.git
cd pi-antigravity-acp-provider
npm install
pi --no-extensions -e ./extensions/index.ts
```

In Pi:

1. Optionally run `/antigravity-acp setup` for a runtime/auth preflight.
2. Run `/login`.
3. Choose **Sign in with an account**.
4. Choose **Google Antigravity (ACP)**.
5. If needed, wait for the official ACP server download and extraction. Progress is shown; the Linux build observed during development expands to about 1.8 GB.
6. Complete the Google login in the browser.
7. Run `/antigravity-acp setup` again to perform a network auth probe and model discovery.
8. Run `/model` and select one of the `antigravity-acp` models.
9. Press **Shift+Tab** to choose the reasoning effort. Only tiers advertised by Antigravity are exposed. A model with a single tier (for example Argon Medium during rollout) remains a reasoning model with that tier; the provider does not invent Low/High variants.
10. Send a prompt. The default permission mode is `yolo`, so Antigravity-native commands and edits can run without confirmation.

The provider first looks at `AGY_ACP_BIN`, then its verified managed `~/.local/opt/agy-acp/current/` release, `~/.local/bin/agy_acp_server.par`, and `PATH`. Set `AGY_ACP_BIN` to explicitly prefer an externally managed runtime. If absent, it installs the platform build published in the ACP registry. A global `agy` or `gemini` command is not required.

### Intel macOS setup caveat

Google's standalone Intel macOS (`darwin-x86_64`) ACP builds, including 1.5.2, have a reported Hardened Runtime/libffi startup hang: the process never answers `initialize`. The verified 1.5.2 artifact has Hardened Runtime enabled without executable-memory entitlements. See [upstream #1393](https://github.com/google-antigravity/antigravity-cli/issues/1393). An initialize timeout on Intel macOS can match this issue; a `SyntaxWarning` about invalid escape sequences is not the cause of that hang. Longer timeouts and repeated downloads do not repair an affected binary. Failed validation leaves no active release, so retrying setup downloads it again. The provider does not strip or replace Google's code signature.

Use the official `agy` CLI directly while awaiting a corrected standalone build. Advanced users can opt into a trusted `agy acp` wrapper via the existing `AGY_ACP_BIN` override (a bare executable path, not a shell command):

```sh
#!/bin/sh
exec /absolute/path/to/agy acp "$@"
```

Make the wrapper executable, set `AGY_ACP_BIN` to its absolute path before starting Pi, and explicitly select `/antigravity-acp permissions default`. The CLI may reject `yolo` and use different permission IDs. This is a best-effort workaround, **not full host CLI backend support**: its login/account store, quota output, and session behavior differ. Sign into the CLI using its own supported flow; this provider's login/logout, credential preflight, and quota commands are not authoritative for that backend. Do not pass permission-bypass flags to work around a mode error.

Loopback MCP traffic is exempted from proxies in the ACP child environment. Explicit `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` (and lowercase variants) are preserved. On macOS, when none are explicitly set, the provider probes enabled system HTTP proxy settings to avoid automatic SOCKS selection unsupported by the bundled Python runtime. Set `PI_ANTIGRAVITY_ACP_PROXY` to an absolute HTTP/HTTPS proxy URL to explicitly override child proxy settings; the provider does not log the override or change its parent environment. Existing `NO_PROXY` lists and TLS certificate overrides are retained.

Standalone Pi builds also need Node.js to run the ACP supervisor. The provider looks for `node` or `nodejs` on `PATH`; set `NODE` to the executable path if neither is available. On NixOS with Home Manager, `programs.pi-coding-agent.extraPackages = [ pkgs.nodejs ];` adds Node to Pi's `PATH`. An explicit `SSL_CERT_FILE` is preserved; otherwise the provider uses `NIX_SSL_CERT_FILE` or a readable system CA bundle when available.

### SSH and headless Google login

When Pi is running over SSH, or on Linux without `DISPLAY`/`WAYLAND_DISPLAY`, `/login` automatically uses a manual browser relay:

1. Pi prints the Google authorization URL instead of trying to launch a browser on the server.
2. Open that URL in a browser on your local machine and finish Google sign-in.
3. Google redirects to an Antigravity loopback URL. The page may show a connection error because `127.0.0.1` refers to your local machine; copy the **complete final URL** from the browser address bar.
4. Paste that URL into Pi. The provider validates its host, port, path, and OAuth state, then relays it to Antigravity's loopback listener on the server. An SSH port-forward is not required.

Set `PI_ANTIGRAVITY_ACP_OAUTH_MODE=manual` to force this flow, or `PI_ANTIGRAVITY_ACP_OAUTH_MODE=browser` to force normal browser launch. The manual relay is not supported on Windows. OAuth URLs and callback codes are kept in a private temporary directory only for the duration of login and are never logged or persisted by this package.

For API-key authentication, choose **Enter an API key** and then **Antigravity Gemini API key** in `/login`, or set `GEMINI_API_KEY` before starting Pi.

The ACP server manages the Google token in a private file under `$PI_CODING_AGENT_DIR/antigravity-acp-provider/gemini/antigravity-acp/`. Pi's auth store keeps only a non-secret marker. Each Pi profile has its own login; this provider does not use `GEMINI_HOME`, the shared macOS Keychain entry, or credentials from other Antigravity clients. If you upgraded from a version that used the shared store, sign in again with `/login antigravity-acp`. The old store is left untouched: profile-level settings, hooks, skills, and ACP conversations from that store are not carried over. Reconfigure anything you still need in the new profile. Pi chat history is unchanged.

### Model availability

The model catalog comes from the official ACP server. ACP 1.4.x exposes model and thinking level as separate selectors; the provider combines them for discovery and confirms both when applying Pi's reasoning choice. If a model change only partially succeeds, the affected session is discarded before retrying, rather than reusing a stale model selection. The offline catalog keeps Gemini 3.8 Flash first; listing Argon does not establish account eligibility. The last successfully discovered catalog is saved in Pi's model store and restored at the next startup, before Pi resolves `enabledModels` and `--model` patterns, so newly advertised models stay selectable before the network refresh finishes. A successful model listing or selection is not an inference/access probe: newly listed models can still fail because of plan eligibility, staged rollout, or backend availability. As of October 13, 2026, Google's [Argon announcement](https://www.antigravity.google/blog/gemini-4-argon-in-google-antigravity) and [model availability table](https://www.antigravity.google/docs/models/) list Gemini 4 Argon for Google AI Ultra and eligible Enterprise subscriptions, not AI Pro. If it returns `Requested entity was not found`, check access in the official Antigravity app/CLI with the same account; do not guess alternate model IDs or assume the listing proves access. Use another advertised model while investigating.

Pi 1.6.0 can synthesize a model for a CLI ID missing from its startup catalog, copying the thinking map from another model of the same provider. Background discovery updates `get_available_models`, but does not replace that already-selected model in `get_state`; `set_model` does. Neon is in the offline catalog for cold startup. For other IDs, the provider corrects stale thinking maps from an exact catalog match before streaming, and never uses another family's thinking map for an unknown `gemini-4-*` model.

### Switch Google accounts

Close other Pi processes using this profile, then run `/login antigravity-acp` and select the Google account you want. An explicit Google login clears the profile's previous cached token and ACP session bindings before opening Google sign-in. Normal Pi restarts still reuse the saved login. Manual/SSH login asks Google to show the account picker; if the browser flow defaults to the wrong account, use a private browser window with the manual flow.

Pi's `/logout` removes the marker and stops Pi from using the saved OAuth login. Pi does not expose a provider logout callback, so to also delete the token immediately, run `/antigravity-acp logout` (or `account`). That command clears only this profile's Google token and saved ACP bindings. Run Pi's `/logout` as well if you want to remove the marker or a Pi-stored API key.

## Commands

```text
/antigravity-acp setup
/antigravity-acp doctor
/antigravity-acp doctor --verbose
/antigravity-acp status
/antigravity-acp quota
/antigravity-acp update
/antigravity-acp updates [automatic|notify|manual]
/antigravity-acp qualify
/antigravity-acp logout
/antigravity-acp account
/antigravity-acp permissions
/antigravity-acp permissions default
/antigravity-acp permissions auto-edit
/antigravity-acp permissions yolo
/antigravity-acp tool-activity [off|compact|full]
```

Type `/antigravity-acp ` to autocomplete subcommands and their options, including permission modes, tool-activity modes, update policies, and `doctor --verbose`. Completion stays under the existing command rather than adding top-level slash commands for each action.

Permission, runtime-update, and tool-activity modes are saved in `$PI_CODING_AGENT_DIR/antigravity-acp-provider/config.json` (where `PI_CODING_AGENT_DIR` defaults to `~/.pi/agent`). Runtime updates default to `automatic` (only provider-managed installations are replaced), and `toolActivity` defaults to `compact` (one line per Antigravity `tool_call` start; `off` hides them, `full` includes all updates and details). Native Antigravity workflows default to disabled (`"nativeWorkflows": false`): the provider uses Antigravity's session tool filter to disable only `run_workflow`, preventing its generated `skills/system/run-workflow/SKILL.md` from appearing in the workspace. To use that tool, set `"nativeWorkflows": true` in the same config and restart Pi; Antigravity may then create that file. The filter is also reapplied when loading or resuming sessions. Existing skill files are never removed or modified by the provider. Chat sessions keep the project working directory. This requires a runtime that supports Antigravity's `disabledTools` session metadata; older runtimes may ignore the filter (see [upstream issue #1330](https://github.com/google-antigravity/antigravity-cli/issues/1330)).

ACP session bindings are saved beside the config in `sessions.json`. Sessions that only read models, quota, or auth run in `utility-cwd/` beside the config, because Antigravity writes files such as `skills/system/` into the working directory of each session.

On first use of a custom profile without a config, existing permission/update settings are copied from the default agent directory (or the legacy Gemini-provider config). Existing custom configs are never overwritten, and saved sessions and Google credentials are not copied. The managed runtime installation is still shared across Pi profiles.

`update` checks the official registry and installs the latest approved release from the provider's signed runtime catalog. If the registry is newer than the catalog, it reports the pending version and uses the latest signed release without downgrading an already newer managed runtime. See [`docs/RUNTIME-UPDATES.md`](docs/RUNTIME-UPDATES.md).

`quota` shows each Antigravity quota group with the remaining percentage and UTC reset time of each limit, then this Pi process's token totals. The provider reads the quota by sending Antigravity's own `/usage` command to a separate short-lived ACP process, which runs no model turn and removes the short-lived conversation it creates once that process exits; the result is cached for 60 seconds. Other Pi extensions can request the same snapshot:

```ts
pi.events.emit("antigravity-acp:quota:request", { reply: (result) => { /* ... */ } });
```

`reply` is called exactly once per emitted request object, even when several provider instances share the event bus, with `{ ok: true, quota }` or `{ ok: false, error }`. `quota` is an `AntigravityQuotaSnapshot`, exported as a type by the package: `{ at: number; groups: { displayName: string; buckets: { window: string; remainingFraction: number; resetTime?: string }[] }[] }`. `at` is the read time in epoch milliseconds, `window` is `weekly`, `5h`, or the server's label for any other limit, `remainingFraction` has 1% precision, and `resetTime` is ISO 8601 at minute precision.

## Development

```bash
npm run check
npm run test:real-acp  # initializes the installed Antigravity ACP server
npm run test:live      # sends a real authenticated prompt
npm run test:qualify   # live cancel, restore, MCP, model, and permission qualification
npm run test:packed
npm audit --audit-level=moderate

# Maintainer-only runtime catalog refresh/signing
npm run refresh:runtime-manifest
ACP_RUNTIME_MANIFEST_PRIVATE_KEY_PATH=/secure/key.pem npm run sign:runtime-manifest
```

CI checks Node 22.19.0 and 24, including typechecking, unit tests, packed installation and the full dependency audit. Live authenticated tests are opt-in and are not part of PR CI. See [`docs/MAINTENANCE.md`](docs/MAINTENANCE.md) for update and release policy.

### Turn progress and recovery

Valid provider requests emit Pi's `start` lifecycle event before runtime setup, with empty assistant content. It means the request was accepted, not that setup finished or model output began; text/thinking/tool events still reflect actual agent activity. Pre-aborted or invalid requests can fail without a start event.

Set `PI_ANTIGRAVITY_ACP_DEBUG=1` before launching Pi to persist private, bounded JSONL diagnostics under `$PI_CODING_AGENT_DIR/antigravity-acp-provider/debug/`. They record phase timings, recognized runtime identity, classified errors/retries/stderr signals, cancellation, and exit—not raw ACP payloads or stderr. Live status/doctor lists each binding's log path. Files stop at 256 KiB; retention keeps the ten newest owned files on a best-effort basis. See [diagnostic privacy, limits, and interpretation](docs/DIAGNOSTICS.md).

Prompts are bounded by inactivity, not total turn duration: streaming progress resets a 10-minute idle window. An outstanding native tool, parked Pi tool, or permission request gets a **finite 60-minute no-progress window** instead, so long work survives the former two-minute Pi-tool deadline without making stuck tools wait forever. Cancellation still sends `session/cancel`, answers parked requests, and closes an unresponsive agent after its 1.5-second grace period. The interactive permission broker retains its two-minute response limit. Integrations can override `promptIdleTimeoutMs` and `promptWorkIdleTimeoutMs` in connection options with positive finite durations; initialize/auth/session-setup deadlines are unchanged.

Antigravity 1.4.5 also has its own three-minute MCP call deadline, independent of the provider's watchdog. If the ACP prompt ends while Pi is still executing a tool, the provider releases the abandoned ACP requests. A late Pi result is then included in a new prompt instead of leaving Pi waiting on an already-ended continuation; cancellation remains available. This recovery does not extend Antigravity's MCP deadline.

Warm ACP bindings are bounded by a default capacity of four and a five-minute idle expiry. Active prompts and parked tool/permission requests are not evicted; saved session records remain available for later restoration.

System instructions are kept outside truncated conversation history. Instructions larger than 256 KiB UTF-8 fail clearly rather than being silently shortened. ACP has no mid-prompt system-update RPC: an instruction change received with tool/permission results finishes the existing prompt under its original instructions, then forces reconstruction before the next prompt. Such a stale binding is not persisted for restoration.

When Antigravity reports that the account's quota is exhausted, the turn ends with `stopReason: "error"` and `Antigravity quota exceeded for <model>. Resets at <ISO 8601 time>.` (the reset part is omitted when Antigravity gives none). Pi does not retry quota errors automatically. The failed turn is not saved, and the ACP session stays warm for the next prompt.

A user message such as `/plan`, `/usage` or `/logout` reaches the model as text: the provider puts an invisible U+200B before those three commands (and before any slash that starts the message) so the Antigravity server does not run them. Other slashes, such as paths, are left untouched. The marker is removed before the model sees the text.
The model path can also refuse requests with HTTP 429 `RESOURCE_EXHAUSTED` (rate limit or entitlement) while plan usage looks healthy. Antigravity then retries with backoff indefinitely, logging only to stderr. The provider tolerates two such retries per inference and 15 seconds of announced retry delay in total. The third retry, announced delays beyond that budget, or silence lasting 30 seconds past a retry's announced delay without model progress fail the turn with a `quota` error that reports the retry count and next delay and suggests retrying later or switching provider. The message starts with `Antigravity quota exceeded`, so Pi does not retry it automatically. The agent process is then closed, as after an inactivity timeout, so the retry loop stops and the next prompt starts a fresh one.

## Security boundary

This launches a full coding agent with the user's OS privileges. **The default `yolo` mode permits Antigravity-native commands and edits without confirmation.** Use `/antigravity-acp permissions default` for confirmation prompts. Disabling ACP filesystem/terminal **client callbacks is not a sandbox** for Antigravity-native tools. Pi hooks govern tools routed through the `pi_` MCP namespace; Antigravity-native tools remain governed by Antigravity policy and ACP permission requests. New/restored sessions must advertise and confirm the requested permission mode. Unsupported or failed mode changes close affected sessions; an executing turn is stopped before changing its policy. Unexpected mode-change notifications also invalidate the session. Doctor/status distinguishes requested policy from each live binding's confirmed mode. This protocol enforcement is not a sandbox.

## Compatibility

The current development tree is tested with Pi 1.5.2 and requires Node.js 22.19.0 or newer; development is pinned to Pi 1.5.2, ACP SDK 2.8.0, and ACP protocol 1. The provider uses the SDK's `client()` app API and explicitly selects its full-v1 `/unstable` entrypoint for draft prompt usage and session lifecycle features. It supports stable session configuration options and retains compatibility with older Antigravity model-selection metadata; it does not enable experimental ACP v2. See [the SDK migration notes](docs/ACP-SDK-MIGRATION.md). Upgrade Pi before upgrading from provider 0.1.12. Pi supplies the host packages at runtime, so their peer ranges remain `*` as required by Pi's package contract; this is not a promise of compatibility with every Pi version. Transcript system instructions and tool additions/removals are replayed into ACP checkpoints, replacing stale warm sessions when that state changes. The bundled signed catalog approves Antigravity ACP releases through 1.5.2 and can accept newer signed catalog releases without an npm update. ACP session setup allows up to two minutes for slow first-run initialization, while transport shutdown rejects pending requests immediately. The current official registry and signed catalog provide Linux x64/ARM64, Windows x64/ARM64, and macOS Intel/ARM64 artifacts. Intel macOS artifacts exist, but affected builds can hang during initialize because of the upstream signing/libffi issue described in the [setup caveat](#intel-macos-setup-caveat); local re-signing is not enabled or qualified by this package. Alpine/musl is rejected because Google's Linux build targets glibc.

During browser authentication, Chromium may write `Opening in existing browser session.` to the ACP process's inherited stdout. The transport ignores only that exact known compatibility line and reports its count in `doctor`; all other non-JSON stdout remains a fatal protocol error.

Managed installations also repair executable permissions for both the ACP server and its `localharness_external` helper. This repairs installations created by 0.1.3 and earlier, where OAuth could succeed but session creation failed with an opaque ACP `Internal error` because the extracted helper was not executable.

Earlier repository documents analyzing `@google/gemini-cli@0.58.0` describe the superseded implementation and are retained only as historical research. See [`docs/ANTIGRAVITY-MIGRATION.md`](docs/ANTIGRAVITY-MIGRATION.md).

## License

MIT
