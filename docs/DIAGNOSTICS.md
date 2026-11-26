# ACP progress and private diagnostics

## Lifecycle events

Each valid, non-pre-aborted provider request emits Pi's standard `start` event before runtime setup or model output. Its assistant message has empty content and a pending stop reason. Text, thinking, and tool events still represent actual agent activity; no synthetic content is inserted to satisfy a watchdog.

`start` means the provider accepted the request, not that session setup finished or the model produced a token. Callers should distinguish request-start, first-content, and inactivity budgets. Cancellation during initialize/session setup closes the affected connection; cancellation during a prompt retains the existing cancel/grace handling. Invalid inputs and requests already aborted before acceptance can fail without `start`.

## Enable persistent diagnostics

Start Pi with:

```sh
PI_ANTIGRAVITY_ACP_DEBUG=1 pi
```

Files are written under `$PI_CODING_AGENT_DIR/antigravity-acp-provider/debug/` (normally `~/.pi/agent/antigravity-acp-provider/debug/`). `/antigravity-acp status` and `doctor` show the path for live bindings. The directory also contains diagnostics for setup/discovery connections that failed before a binding existed.

Each ACP connection has a separate JSONL file with UTC timestamps and monotonic elapsed/duration measurements. It records:

- process spawn and exit;
- recognized runtime identity and a bounded numeric release version;
- initialize, authenticate, session creation/restoration, selector changes, and prompt operation start/end, including classified error codes;
- prompt cancellation;
- classified stderr signals for rate limits, retries (and recognized numeric retry delays), and startup warnings.

Operation IDs correlate each start/end within that file. An exit can interrupt an operation before an end record is written. To locate a delay, compare the initialize/session operation durations with the prompt duration. A long prompt without other signals does not establish throttling, a local setup bug, or an extension concurrency problem.

## Privacy and limits

This is a metadata log, **not a raw ACP or stderr trace**. No prompts, model responses, tool arguments/results, file content, credentials, URLs, working directories, session IDs, or free-form error messages are deliberately serialized. Unrecognized identity text is replaced with `other`/`unknown`. Stderr is classified rather than copied: unknown lines are omitted, and recognized lines contribute only fixed categories and numeric delay fields. This avoids relying on regex redaction to make arbitrary subprocess output safe to persist.

Files are created with mode 0600 in a 0700 directory on POSIX. Each file stops accepting records at 256 KiB. Creation/close performs best-effort retention of the ten newest owned log files; concurrent processes can briefly exceed that count, and older files may be pruned while a connection is still active. Diagnostic write/retention failures never fail an ACP operation. Disabling the environment variable stops new diagnostic files; it does not delete existing files.

`doctor --verbose` still exposes the existing bounded, redacted **in-memory** stderr tail for live processes. That tail is not copied into these logs. Review any diagnostics before sharing them, particularly verbose stderr, and never publish credential files or raw ACP traffic.

Diagnostics do not change retry limits, permission policy, runtime selection, concurrency, or prompt deadlines. They make future stalls observable; they do not claim to fix the platform/account-specific latency reported in issue #118.
