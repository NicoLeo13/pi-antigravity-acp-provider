import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { inspectAntigravityAuth, resolveAntigravityAcpDirectory } from "../src/acp/antigravity.js";
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
	saveAccounts,
	saveIsolatedGeminiHome,
	savePermissionMode,
	saveRuntimeUpdateMode,
	saveToolActivityMode,
	saveToolBridgeMode,
	type AntigravityAccountConfig,
	type AntigravityAcpConfig,
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
import {
	acquireSharedRuntime,
	addSharedAccount,
	releaseSharedRuntime,
	removeSharedAccount,
	type SharedAccount,
	type SharedRuntime,
} from "../src/shared-runtime.js";
import { DEFAULT_ACCOUNT_ID, resolveAccounts } from "../src/accounts.js";
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

async function chooseAccount(
	ctx: ExtensionCommandContext,
	shared: SharedRuntime,
	argument?: string,
): Promise<SharedAccount | undefined> {
	const matches = (candidate: SharedAccount, value: string) =>
		candidate.account.id === value ||
		candidate.account.providerId === value ||
		candidate.account.name === value;
	if (argument) {
		const found = shared.accounts.find((candidate) => matches(candidate, argument));
		if (!found) ctx.ui.notify(`Unknown Antigravity account "${argument}"`, "warning");
		return found;
	}
	if (shared.accounts.length === 1) return shared.accounts[0];
	const labels = shared.accounts.map(({ account }) => `${account.name} (${account.providerId})`);
	const selected = await ctx.ui.select("Antigravity account", labels);
	if (!selected) return undefined;
	return shared.accounts.find((candidate, index) => labels[index] === selected);
}

function describeAccounts(shared: SharedRuntime): string {
	return shared.accounts.map(({ account }) =>
		`${account.name} (${account.providerId}) → ${resolveAntigravityAcpDirectory(account.env ?? process.env)}`,
	).join("\n");
}

async function addAccount(pi: ExtensionAPI, ctx: ExtensionCommandContext, shared: SharedRuntime): Promise<void> {
	const config = loadConfig();
	const id = (await ctx.ui.input("Antigravity account id", "work"))?.trim();
	if (!id) return;
	const label = (await ctx.ui.input("Picker label", id))?.trim();
	const home = (await ctx.ui.input("Gemini home directory", "~/.gemini-work"))?.trim();
	if (!home) return;
	const entry: AntigravityAccountConfig = { id, geminiHome: home, ...(label ? { label } : {}) };
	const candidate: AntigravityAcpConfig = { ...config, accounts: [...config.accounts, entry] };
	// Only the new entry's errors matter: an existing broken account must not
	// block adding a good one, and the warning still comes from resolveAccounts.
	const problems = resolveAccounts(candidate).problems.slice(resolveAccounts(config).problems.length);
	if (problems.length > 0) {
		ctx.ui.notify(problems.join("; "), "warning");
		return;
	}
	saveAccounts(candidate.accounts);
	const resolved = resolveAccounts(candidate).accounts.find((account) => account.id === id);
	if (!resolved) return;
	const created = addSharedAccount(shared, resolved, candidate);
	pi.registerProvider(created.provider);
	ctx.ui.notify(
		`Added ${resolved.name} (${resolved.providerId}). Run /login and choose that provider to sign in. Other open Pi sessions load it on restart.`,
		"info",
	);
}

async function removeAccount(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	shared: SharedRuntime,
	argument?: string,
): Promise<void> {
	const target = await chooseAccount(ctx, shared, argument);
	if (!target) return;
	if (target.account.id === DEFAULT_ACCOUNT_ID) {
		ctx.ui.notify("The default account cannot be removed.", "warning");
		return;
	}
	const { bindings } = await target.runtime.snapshot();
	if (bindings > 0) {
		ctx.ui.notify(
			`${target.account.name} has ${bindings} active binding(s). Close them before removing the account.`,
			"warning",
		);
		return;
	}
	const confirmed = await ctx.ui.confirm(
		"Remove Antigravity account",
		`Remove ${target.account.name} from the picker? Local credentials in ${resolveAntigravityAcpDirectory(target.account.env ?? process.env)} are NOT deleted.`,
	);
	if (!confirmed) return;
	const removed = removeSharedAccount(shared, target.account.id);
	if (!removed) return;
	// Persist first: if unregistration throws, the account is still removed on
	// restart and the detached runtime must not leak.
	saveAccounts(loadConfig().accounts.filter((account) => account.id !== target.account.id));
	try {
		pi.unregisterProvider(removed.provider.id);
	} finally {
		await removed.runtime.close();
	}
	ctx.ui.notify(
		`Removed ${target.account.name}. Choose another model if it was selected. Local credentials were not deleted.`,
		"info",
	);
}

export function registerAntigravityAcp(pi: ExtensionAPI, connectionFactory?: AntigravityConnectionFactory): void {
	const shared = acquireSharedRuntime(connectionFactory);
	const runtime = shared.accounts[0]!.runtime;
	for (const { provider } of shared.accounts) pi.registerProvider(provider);

	// Other extensions ask for quota with `{ reply }` and get exactly one
	// `{ ok, quota | error }`. An optional account id (or Pi provider id)
	// selects which Google account is read; without it the default one answers.
	const unsubscribeQuota = pi.events.on(QUOTA_REQUEST_CHANNEL, (data) => {
		const request = data as { reply?: unknown; account?: unknown; providerId?: unknown } | undefined;
		const reply = request?.reply;
		if (typeof reply !== "function" || claimedQuotaRequests.has(data as object)) return;
		claimedQuotaRequests.add(data as object);
		const target = typeof request?.providerId === "string"
			? request.providerId
			: typeof request?.account === "string" ? request.account : undefined;
		const owner = target === undefined
			? shared.accounts[0]!
			: shared.accounts.find(({ account }) => account.id === target || account.providerId === target);
		const snapshot = owner
			? owner.runtime.quota(undefined)
			: Promise.reject(new Error(`Unknown Antigravity account "${target}"`));
		void snapshot.then(
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
			if (command === "setup" || command.startsWith("setup ")) {
				const target = await chooseAccount(ctx, shared, command.slice("setup".length).trim() || undefined);
				if (!target) return;
				await runSetupWizard(
					ctx.ui,
					target.runtime,
					target.account.env
						? { name: target.account.name, env: target.account.env }
						: { name: target.account.name },
				);
				return;
			}
			if (command === "accounts" || command.startsWith("accounts ")) {
				const action = command.slice("accounts".length).trim();
				if (action === "list") {
					ctx.ui.notify(describeAccounts(shared), "info");
					return;
				}
				if (action === "add") {
					await addAccount(pi, ctx, shared);
					return;
				}
				if (action === "remove" || action.startsWith("remove ")) {
					await removeAccount(pi, ctx, shared, action.slice("remove".length).trim() || undefined);
					return;
				}
				const choice = await ctx.ui.select("Antigravity accounts", [
					"List accounts",
					"Add an account",
					"Remove an account",
				]);
				if (choice === "List accounts") ctx.ui.notify(describeAccounts(shared), "info");
				else if (choice === "Add an account") await addAccount(pi, ctx, shared);
				else if (choice === "Remove an account") await removeAccount(pi, ctx, shared);
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
			if (
				command === "logout" || command.startsWith("logout ") ||
				command === "account" || command.startsWith("account ") ||
				command === "switch-account" || command.startsWith("switch-account ")
			) {
				const verb = command.split(" ", 1)[0]!;
				const target = await chooseAccount(ctx, shared, command.slice(verb.length).trim() || undefined);
				if (!target) return;
				await target.runtime.logout();
				ctx.ui.notify(
					shared.accounts.length === 1
						? "Local Antigravity credentials and saved ACP sessions were cleared. Run /logout for the old Pi marker, then /login to choose the next account."
						: `Credentials and saved ACP sessions for ${target.account.name} were cleared. Select that provider in /login to sign in again; other accounts are untouched.`,
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
				for (const { runtime: owner } of shared.accounts) owner.setToolActivityMode(requested);
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
				for (const { runtime: owner } of shared.accounts) owner.setToolBridgeMode(requested);
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
				for (const { runtime: owner } of shared.accounts) owner.setIsolatedGeminiHome(enabled);
				saveIsolatedGeminiHome(enabled);
				ctx.ui.notify(`Antigravity isolated GEMINI_HOME: ${requested} (applies to new connections)`, "info");
				return;
			}
			const verbose = command === "doctor --verbose";
			if (command !== "doctor" && command !== "status" && !verbose) {
				ctx.ui.notify(
					"Usage: /antigravity-acp [setup|accounts|doctor|status|quota|update|updates|logout|account|qualify|permissions|tool-activity|tool-bridge|isolated-home]",
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
			const setup = inspectRuntimeSetup();
			const update = await checkAntigravityAcpUpdate().catch(() => undefined);
			const processLines = (item: (typeof snapshot)["processes"][number]) => [
				`• pid=${item.pid ?? "?"} generation=${item.generation} model=${item.modelId} confirmedMode=${item.confirmedPermissionMode} alive=${item.alive} restored=${item.restored} agent=${item.agentVersion ?? "?"} mcpHttp=${item.mcpHttp} permission=${item.waitingForPermission} tools=${item.waitingForTools} ignoredStdoutNoise=${item.ignoredStdoutNoiseLines}`,
				`  omitted Pi tools: ${item.omittedTools.length ? item.omittedTools.map((tool) => `${tool.name} (${tool.reason})`).join("; ") : "none"}`,
				...(verbose && item.stderrTail ? [`  stderr (redacted): ${item.stderrTail}`] : []),
			];
			// Credentials and quota are per account, so inspect each account's
			// own home instead of the ambient one.
			const reports = await Promise.all(shared.accounts.map(async ({ account, runtime: owner }) => {
				const env = account.env ?? process.env;
				const home = resolveAntigravityAcpDirectory(env);
				const auth = inspectAntigravityAuth(home, env);
				const report = await owner.snapshot(verbose);
				return { account, home, auth, storage: describeCredentialStorage({ env }), report };
			}));
			const modeLines = [
				`Requested permission mode: ${permissionModeLabel(snapshot.permissionMode)}`,
				`Tool activity mode: ${snapshot.toolActivityMode}`,
				`Tool bridge mode: ${snapshot.toolBridgeMode}`,
				`Isolated GEMINI_HOME: ${snapshot.isolatedGeminiHome ? "on" : "off"}`,
			];
			const accountLines: string[] = [];
			if (shared.accounts.length === 1) {
				// Keep the historical single-account output byte-identical.
				const only = reports[0]!;
				accountLines.push(
					`Authentication: ${only.auth.status}${only.auth.authType ? ` (${only.auth.authType})` : ""}`,
					`Credential storage (preflight): ${only.storage}`,
					...modeLines,
					`Active bindings: ${only.report.bindings}`,
					formatMetrics(only.report.metrics),
					...only.report.processes.flatMap(processLines),
				);
			} else {
				accountLines.push(...modeLines);
				for (const report of reports) {
					accountLines.push(
						`Account ${report.account.name} (${report.account.providerId}):`,
						`  Credentials: ${report.home}`,
						`  Authentication: ${report.auth.status}${report.auth.authType ? ` (${report.auth.authType})` : ""}`,
						`  Credential storage (preflight): ${report.storage}`,
						`  Active bindings: ${report.report.bindings}`,
					);
					for (const line of formatMetrics(report.report.metrics).split("\n")) accountLines.push(`  ${line}`);
					for (const item of report.report.processes) {
						for (const line of processLines(item)) accountLines.push(`  ${line}`);
					}
				}
			}
			ctx.ui.notify(
				[
					`Antigravity ACP provider ${PACKAGE_VERSION}`,
					`Runtime: installed=${setup.installedVersion ?? "external/unknown"} approved=${update?.approvedVersion ?? setup.approvedVersion} registry=${update?.latestVersion ?? "unavailable"} updates=${setup.updateMode}; ACP SDK ${ACP_SDK_VERSION}, protocol ${ACP_PROTOCOL_VERSION}`,
					`Antigravity server: ${entry}`,
					...accountLines,
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
