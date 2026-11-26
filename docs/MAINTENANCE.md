# Maintenance policy

## Supported versions

- Pi 1.5.x+; development packages (`@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`) are pinned together.
- Node.js 22.19.0 and 24 are checked in CI; `@types/node` tracks the 24.x line.
- ACP SDK 2.8.0 / protocol 1 (not experimental ACP v2), using the full-v1 `/unstable` entrypoint for draft usage and session lifecycle fields. Both stable configuration selectors and legacy Antigravity model APIs are supported and validated.
- Host-provided Pi packages remain `*` peer dependencies per Pi's package contract.

## Dependency updates

Dependabot runs weekly for npm and GitHub Actions. Pi packages are grouped so `pi-ai` and `pi-coding-agent` stay matched. Minor/patch updates are grouped; major updates require individual review.

Before merging, require Node 22.19.0 and 24 checks: typecheck, unit tests, pack dry run, isolated packed-install smoke test, and `npm audit --audit-level=moderate`. Do not use `npm audit fix --force` as a substitute for compatibility work.

Pin ACP SDK updates and keep model-selection, usage, cancellation, permission, and transport regression coverage passing.

## Profiles

`PI_CODING_AGENT_DIR` isolates provider configuration, saved ACP bindings, and per-profile Google credentials (`$PI_CODING_AGENT_DIR/antigravity-acp-provider/gemini/antigravity-acp/`). Initial configuration migration copies only permission/update settings, preserves the source, and never overwrites an existing target. Sessions and credentials are not copied. The managed ACP runtime installation under `~/.local/opt/agy-acp/` is shared across Pi profiles.

## Release checklist

1. Merge changes only after both CI checks pass on the current `main` base.
2. Bump `package.json` and `package-lock.json` together and merge the release PR.
3. Re-run `npm run check`, `npm run test:packed`, and `npm audit --audit-level=moderate` from a clean install.
4. Create an annotated `v<version>` tag on that exact `main` commit and push it. The publish workflow uses npm trusted publishing (OIDC); do not introduce a long-lived npm token.
5. Verify the publish workflow, npm version, and GitHub release notes. Live authenticated tests are opt-in and never run in PR CI.

## Protected runtime publication

The `main` ruleset requires PRs, an up-to-date base, passing `Check (22.19.0)` and `Check (24)` jobs, linear history, resolved review threads, and no force pushes or deletion.

The daily updater (`update-runtime-manifest.yml`) updates only `runtime-manifest.json` on an automation branch, opens a PR, explicitly dispatches `ci.yml`, verifies both CI jobs on that exact head, and squash-merges through normal protection. Because bot-token PR workflows are held for approval, a dispatch-only reporting job records each validation job's real result and URL on the tested commit. Signing keys are removed from runner temporary storage immediately after signing.

Validate the bot publication path without downloading artifacts or using a signing key:

```bash
gh workflow run update-runtime-manifest.yml -f publication_test=true
```

Pass `-f merge_publication_test=true` to also exercise the protected merge path (whitespace-only change; signature payload and approved releases stay identical).
