import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { inspectAntigravityAuth } from "../src/acp/antigravity.js";
import { describeCredentialStorage } from "../src/acp/credential-storage.js";
import { errorMessage } from "../src/acp/errors.js";
import { resolveAntigravityAcpEntry } from "../src/acp/process.js";
import {
	checkAntigravityAcpUpdate,
	inspectRuntimeSetup,
	updateAntigravityAcpRuntime,
} from "../src/acp/setup.js";
import {
	isPermissionMode,
	isRuntimeUpdateMode,
	isToolActivityMode,
	isToolBridgeMode,
	loadConfig,
	permissionModeLabel,
	saveIsolatedGeminiHome,
	savePermissionMode,
	saveRuntimeUpdateMode,
	saveToolActivityMode,
	saveToolBridgeMode,
	type PermissionMode,
} from "../src/config.js";
import {
	ACP_PROTOCOL_VERSION,
	ACP_SDK_VERSION,
	PACKAGE_VERSION,
	QUOTA_REQUEST_CHANNEL,
} from "../src/constants.js";
import type { AntigravityQuotaSnapshot } from "../src/acp/usage-quota.js";
import {
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
	type AntigravityConnectionFactory,
	type PermissionToolResult,
} from "../src/runtime.js";
import { acquireSharedRuntime, releaseSharedRuntime } from "../src/shared-runtime.js";
import { runSetupWizard } from "../src/wizard.js";

export type { AntigravityQuotaSnapshot } from "../src/acp/usage-quota.js";

// Instances sharing an event bus all hear each request; the first to claim it replies. Pi loads every
// instance without a module cache, so the claims live on globalThis.
const CLAIMED_QUOTA_REQUESTS = Symbol.for("pi-antigravity-acp:quota-requests");
const claimSlots = globalThis as unknown as Record<symbol, WeakSet<object> | undefined>;
const claimedQuotaRequests = (claimSlots[CLAIMED_QUOTA_REQUESTS] ??= new WeakSet());

export default function antigravityAcpExtension(pi: ExtensionAPI): void {
	registerAntigravityAcp(pi);
}

export function registerAntigravityAcp(pi: ExtensionAPI, connectionFactory?: AntigravityConnectionFactory): void {
	const shared = acquireSharedRuntime(connectionFactory);
	const runtime = shared.accounts[0]!.runtime;
	for (const { provider } of shared.accounts) pi.registerProvider(provider);

	// Other extensions ask for quota with `{ reply }` and get exactly one `{ ok, quota | error }`.
	const unsubscribeQuota = pi.events.on(QUOTA_REQUEST_CHANNEL, (data) => {
		const reply = (data as { reply?: unknown } | undefined)?.reply;
		if (typeof reply !== "function" || claimedQuotaRequests.has(data as object)) return;
		claimedQuotaRequests.add(data as object);
		void runtime.quota(undefined).then(
			(quota) => ({ ok: true as const, quota }),
			(error: unknown) => ({ ok: false as const, error: errorMessage(error) }),
		).then((result) => {
			try {
				reply(result);
			} catch {
				// A failing listener must not get a second reply.
			}
		});
	});

	pi.registerTool({
		name: PERMISSION_TOOL_NAME,
		label: "Antigravity ACP Permission",
		description: "Presents an Antigravity ACP permission request to the user. Only call IDs emitted by the provider are valid.",
		parameters: Type.Object({ requestId: Type.String({ minLength: 1, maxLength: 128 }) }),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// A request can come from any account's runtime; ids are unique.
			const request = shared.accounts
				.map(({ runtime: candidate }) => candidate.getPermission(params.requestId))
				.find((candidate) => candidate !== undefined);
			if (!request) throw new Error("This Antigravity permission request is missing, expired, or already used");
			const labels = request.options.map(
				(option, index) => `${index + 1}. ${option.label} [${option.kind.replaceAll("_", " ")}]`,
			);
			let selected: string | undefined;
			try {
				selected = await ctx.ui.select(request.title, labels);
			} catch {
				// Print/RPC/headless modes deny when no interactive selector is available.
			}
			const selectedIndex = selected === undefined ? -1 : labels.indexOf(selected);
			const optionId = selectedIndex < 0 ? undefined : request.options[selectedIndex]?.id;
			const details: PermissionToolResult = {
				kind: PERMISSION_RESULT_KIND,
				requestId: request.id,
				...(optionId === undefined ? {} : { optionId }),
				cancelled: optionId === undefined,
			};
			return {
				content: [
					{
						type: "text",
						text: optionId === undefined ? "Permission denied." : `Permission decision recorded: ${selected}`,
					},
				],
				details,
			};
		},
	});

	const commandDefinition = {
		description: "Set up, inspect, update, or configure Google Antigravity ACP",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const command = args.trim() || "doctor";
			if (command === "setup") {
				await runSetupWizard(ctx.ui, runtime);
				return;
			}
			if (command === "update" || command === "update-runtime") {
				const result = await updateAntigravityAcpRuntime((message) => ctx.ui.notify(message, "info"));
				ctx.ui.notify(
					result.changed
						? `Installed verified Antigravity ACP ${result.version}. Restart Pi to move active sessions to it.`
						: `Antigravity ACP ${result.version} is already the latest signed release.`,
					"info",
				);
				return;
			}
			if (command === "updates" || command.startsWith("updates ")) {
				const requested = command.slice("updates".length).trim();
				if (!requested) {
					ctx.ui.notify(`Antigravity runtime updates: ${loadConfig().runtimeUpdates}`, "info");
					return;
				}
				if (!isRuntimeUpdateMode(requested)) {
					ctx.ui.notify(
						"Usage: /antigravity-acp updates [automatic|notify|manual]",
						"warning",
					);
					return;
				}
				saveRuntimeUpdateMode(requested);
				ctx.ui.notify(`Antigravity runtime updates: ${requested}`, "info");
				return;
			}
			if (command === "logout" || command === "account" || command === "switch-account") {
				await runtime.logout();
				ctx.ui.notify(
					shared.accounts.length === 1
						? "Local Antigravity credentials and saved ACP sessions were cleared. Run /logout for the old Pi marker, then /login to choose the next account."
						: `Credentials and saved ACP sessions for ${shared.accounts[0]!.account.name} were cleared. Select that provider in /login to sign in again; other accounts are untouched.`,
					"info",
				);
				return;
			}
			if (command === "quota") {
				// Quota is per runtime because credentials are per account. Keep
				// the one-account output unchanged; label it only when it matters.
				const reports = await Promise.all(shared.accounts.map(async ({ account, runtime: owner }) => {
					const quota = await owner.quota(undefined).then(
						formatQuota,
						(error: unknown) => `Antigravity quota: unavailable (${errorMessage(error)})`,
					);
					return { name: account.name, text: [quota, formatMetrics((await owner.snapshot()).metrics)].join("\n") };
				}));
				ctx.ui.notify(
					reports.length === 1
						? reports[0]!.text
						: reports.map((report) => `[${report.name}]\n${report.text}`).join("\n\n"),
					"info",
				);
				return;
			}
			if (command === "qualify") {
				await runSetupWizard(ctx.ui, runtime);
				return;
			}
			if (command === "permissions" || command.startsWith("permissions ")) {
				let requested = command.slice("permissions".length).trim().replaceAll("-", "_");
				if (!requested) {
					const choices = [
						"yolo — allow commands and edits automatically (default)",
						"auto-edit — allow edits automatically; commands may ask",
						"default — ask before sensitive operations",
					];
					const selected = await ctx.ui.select("Antigravity permission mode", choices);
					if (!selected) return;
					requested = selected.split(" ", 1)[0]!.replaceAll("-", "_");
				}
				if (!isPermissionMode(requested)) {
					ctx.ui.notify(
						"Usage: /antigravity-acp permissions [default|auto-edit|yolo]",
						"warning",
					);
					return;
				}
				const mode: PermissionMode = requested;
				// Permission mode is a single global config value, so every
				// account's live bindings must follow it.
				await Promise.all(shared.accounts.map(({ runtime: owner }) => owner.setPermissionMode(mode)));
				savePermissionMode(mode);
				ctx.ui.notify(
					mode === "yolo"
						? "Antigravity permission mode: yolo. Commands and edits may run without confirmation."
						: `Antigravity permission mode: ${permissionModeLabel(mode)}.`,
					mode === "yolo" ? "warning" : "info",
				);
				return;
			}
			if (command === "tool-activity" || command.startsWith("tool-activity ")) {
				let requested = command.slice("tool-activity".length).trim().toLowerCase();
				if (!requested) {
					const choices = [
						"compact — show one line when an Antigravity tool starts (default)",
						"off — hide Antigravity tool activity in thinking blocks",
						"full — show all Antigravity tool calls, updates, and output details",
					];
					const selected = await ctx.ui.select("Antigravity tool activity", choices);
					if (!selected) return;
					requested = selected.split(" ", 1)[0]!;
				}
				if (!isToolActivityMode(requested)) {
					ctx.ui.notify(
						"Usage: /antigravity-acp tool-activity [off|compact|full]",
						"warning",
					);
					return;
				}
				runtime.setToolActivityMode(requested);
				saveToolActivityMode(requested);
				ctx.ui.notify(`Antigravity tool activity: ${requested}`, "info");
				return;
			}
			if (command === "tool-bridge" || command.startsWith("tool-bridge ")) {
				let requested = command.slice("tool-bridge".length).trim().toLowerCase();
				if (!requested) {
					const choices = [
						"ecosystem — bridge only ecosystem tools (engram, codegraph, subagents) and let Antigravity use its native core tools (default)",
						"all — bridge all active Pi tools via MCP",
					];
					const selected = await ctx.ui.select("Antigravity Pi MCP tool bridge", choices);
					if (!selected) return;
					requested = selected.split(" ", 1)[0]!;
				}
				if (!isToolBridgeMode(requested)) {
					ctx.ui.notify("Usage: /antigravity-acp tool-bridge [ecosystem|all]", "warning");
					return;
				}
				runtime.setToolBridgeMode(requested);
				saveToolBridgeMode(requested);
				ctx.ui.notify(`Antigravity Pi MCP tool bridge: ${requested}`, "info");
				return;
			}
			if (command === "isolated-home" || command.startsWith("isolated-home ")) {
				let requested = command.slice("isolated-home".length).trim().toLowerCase();
				if (!requested) {
					const choices = [
						"on — isolate GEMINI_HOME so ~/.gemini/GEMINI.md and skills are not loaded twice (default)",
						"off — inherit ~/.gemini directly",
					];
					const selected = await ctx.ui.select("Antigravity isolated GEMINI_HOME", choices);
					if (!selected) return;
					requested = selected.split(" ", 1)[0]!;
				}
				if (requested !== "on" && requested !== "off") {
					ctx.ui.notify("Usage: /antigravity-acp isolated-home [on|off]", "warning");
					return;
				}
				const enabled = requested === "on";
				runtime.setIsolatedGeminiHome(enabled);
				saveIsolatedGeminiHome(enabled);
				ctx.ui.notify(`Antigravity isolated GEMINI_HOME: ${requested} (applies to new connections)`, "info");
				return;
			}
			const verbose = command === "doctor --verbose";
			if (command !== "doctor" && command !== "status" && !verbose) {
				ctx.ui.notify(
					"Usage: /antigravity-acp [setup|doctor|status|quota|update|updates|logout|account|qualify|permissions|tool-activity|tool-bridge|isolated-home]",
					"warning",
				);
				return;
			}
			let entry: string;
			try {
				entry = resolveAntigravityAcpEntry();
			} catch (error) {
				entry = error instanceof Error ? error.message : String(error);
			}
			const snapshot = await runtime.snapshot(verbose);
			const auth = inspectAntigravityAuth();
			const setup = inspectRuntimeSetup();
			const update = await checkAntigravityAcpUpdate().catch(() => undefined);
			ctx.ui.notify(
				[
					`Antigravity ACP provider ${PACKAGE_VERSION}`,
					`Runtime: installed=${setup.installedVersion ?? "external/unknown"} approved=${update?.approvedVersion ?? setup.approvedVersion} registry=${update?.latestVersion ?? "unavailable"} updates=${setup.updateMode}; ACP SDK ${ACP_SDK_VERSION}, protocol ${ACP_PROTOCOL_VERSION}`,
					`Antigravity server: ${entry}`,
					`Authentication: ${auth.status}${auth.authType ? ` (${auth.authType})` : ""}`,
					`Credential storage (preflight): ${describeCredentialStorage()}`,
					`Requested permission mode: ${permissionModeLabel(snapshot.permissionMode)}`,
					`Tool activity mode: ${snapshot.toolActivityMode}`,
					`Tool bridge mode: ${snapshot.toolBridgeMode}`,
					`Isolated GEMINI_HOME: ${snapshot.isolatedGeminiHome ? "on" : "off"}`,
					`Active bindings: ${snapshot.bindings}`,
					formatMetrics(snapshot.metrics),
					...snapshot.processes.flatMap((item) => [
						`• pid=${item.pid ?? "?"} generation=${item.generation} model=${item.modelId} confirmedMode=${item.confirmedPermissionMode} alive=${item.alive} restored=${item.restored} agent=${item.agentVersion ?? "?"} mcpHttp=${item.mcpHttp} permission=${item.waitingForPermission} tools=${item.waitingForTools} ignoredStdoutNoise=${item.ignoredStdoutNoiseLines}`,
						`  omitted Pi tools: ${item.omittedTools.length ? item.omittedTools.map((tool) => `${tool.name} (${tool.reason})`).join("; ") : "none"}`,
						...(verbose && item.stderrTail ? [`  stderr (redacted): ${item.stderrTail}`] : []),
					]),
				].join("\n"),
				"info",
			);
		},
	};
	pi.registerCommand("antigravity-acp", commandDefinition);
	pi.registerCommand("gemini-acp", {
		...commandDefinition,
		description: "Deprecated alias for /antigravity-acp",
	});

	pi.on("session_start", async (_event, ctx) => {
		if (shared.problems.length) {
			ctx.ui.notify(`Antigravity accounts: ${shared.problems.join("; ")}`, "warning");
		}
		if (loadConfig().runtimeUpdates !== "notify") return;
		try {
			const update = await checkAntigravityAcpUpdate();
			if (update.approvalPending) {
				ctx.ui.notify(
					`Antigravity ACP ${update.latestVersion} is published but is still awaiting a signed runtime manifest.`,
					"warning",
				);
			} else if (update.updateAvailable) {
				ctx.ui.notify(
					update.managed
						? `Antigravity ACP ${update.approvedVersion} is available. Run /antigravity-acp update.`
						: `Antigravity ACP ${update.approvedVersion} is available, but the selected external runtime must be updated manually.`,
					"info",
				);
			}
		} catch {
			// Update checks are advisory and must not interrupt Pi startup.
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		unsubscribeQuota();
		await Promise.all(shared.accounts.map(({ runtime: owner }) => owner.closeSession(ctx.sessionManager.getSessionId())));
		await releaseSharedRuntime(shared, event.reason);
	});
}

function formatMetrics(metrics: {
	totals: {
		turns: number;
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
	};
	latestQuota?: { remaining?: number; limit?: number; resetAt?: string; tier?: string; model?: string };
}): string {
	const totalTokens =
		metrics.totals.input +
		metrics.totals.output +
		metrics.totals.cacheRead +
		metrics.totals.cacheWrite;
	const quota = metrics.latestQuota;
	return [
		`Usage this process: turns=${metrics.totals.turns} tokens=${totalTokens} input=${metrics.totals.input} output=${metrics.totals.output} reasoning=${metrics.totals.reasoning} cacheRead=${metrics.totals.cacheRead}`,
		...(quota
			? [`Latest quota: remaining=${quota.remaining ?? "unknown"}/${quota.limit ?? "unknown"} reset=${quota.resetAt ?? "unknown"} tier=${quota.tier ?? "unknown"} model=${quota.model ?? "unknown"}`]
			: []),
	].join("\n");
}

function formatQuota(snapshot: AntigravityQuotaSnapshot): string {
	return [
		"Antigravity quota:",
		...snapshot.groups.map((group) => `  ${group.displayName}: ${group.buckets.length
			? group.buckets.map((bucket) => `${bucket.window} ${Math.round(bucket.remainingFraction * 100)}%${bucket.resetTime ? ` (resets ${bucket.resetTime})` : ""}`).join(", ")
			: "no percentage limits reported"}`),
	].join("\n");
}
