import { normalizeContext, type Context } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { QUOTA_REQUEST_CHANNEL } from "../src/constants.js";
import { PERMISSION_TOOL_NAME, type AntigravityRuntime } from "../src/runtime.js";
import {
	createFakeContext,
	createFakeExtensionApi,
	type FakeContext,
	type FakeExtensionApi,
	type FakeProviderRegistry,
} from "./helpers/fake-extension-api.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));

let root: string;
let log: string;
let registry: FakeProviderRegistry;
let loaded: Array<{ pi: FakeExtensionApi; ctx: FakeContext }>;
let captured: Array<NodeJS.ProcessEnv | undefined>;
let connections: AntigravityAcpConnection[];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-accounts-extension-"));
	const agentDir = path.join(root, "agent");
	const workHome = path.join(root, "work-home");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(workHome, { recursive: true });
	log = path.join(root, "calls.jsonl");
	fs.writeFileSync(log, "");
	fs.mkdirSync(path.join(agentDir, "antigravity-acp-provider"), { recursive: true });
	fs.writeFileSync(path.join(agentDir, "antigravity-acp-provider", "config.json"), JSON.stringify({
		permissions: "default",
		accounts: [{ id: "work", label: "Work", geminiHome: workHome }],
	}), { mode: 0o600 });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	registry = new Map();
	loaded = [];
	captured = [];
	connections = [];
});

afterEach(async () => {
	for (const { pi, ctx } of loaded.splice(0)) await pi.emit("session_shutdown", { reason: "quit" }, ctx);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

async function load() {
	vi.resetModules();
	const { registerAntigravityAcp } = await import("../extensions/index.js");
	const pi = createFakeExtensionApi(registry);
	registerAntigravityAcp(pi.api, (options) => {
		captured.push(options.env);
		const connection = new AntigravityAcpConnection({
			...options,
			command: process.execPath,
			args: [fakeAgent],
			env: { ...(options.env ?? process.env), FAKE_AGENT_LOG_FILE: log },
		});
		connections.push(connection);
		return connection;
	});
	const ctx = createFakeContext({ sessionId: "parent", cwd: root });
	loaded.push({ pi, ctx });
	return { pi, ctx };
}

const user = (content: string, timestamp = 1): Context["messages"][number] => ({ role: "user", content, timestamp });

const configFile = () => path.join(root, "agent", "antigravity-acp-provider", "config.json");

function stream(providerId: string, messages: Context["messages"], sessionId: string) {
	const provider = registry.get(providerId);
	if (!provider) throw new Error(`${providerId} is not registered`);
	const model = provider.getModels()[0];
	if (!model) throw new Error(`${providerId} has no models`);
	return provider.streamSimple(model, normalizeContext({ messages }), { sessionId, apiKey: "test-key" }).result();
}

describe("multi-account extension", () => {
	it("registers one provider per account with a distinct picker name", async () => {
		const { pi } = await load();
		expect([...registry.keys()]).toEqual(["antigravity-acp", "antigravity-acp-work"]);
		expect(pi.providers.map((provider) => provider.name)).toEqual([
			"Google Antigravity (ACP)",
			"Google Antigravity (ACP) — Work",
		]);
		for (const [id, provider] of registry) {
			expect(provider.getModels().length).toBeGreaterThan(0);
			for (const model of provider.getModels()) expect(model.provider).toBe(id);
		}
	});

	it("routes each provider's stream to its own Gemini home", async () => {
		await load();
		const workHome = path.join(root, "work-home");

		const first = await stream("antigravity-acp", [user("hello")], "parent");
		expect(first.stopReason).toBe("stop");
		expect(captured.at(-1)?.GEMINI_HOME).toBeUndefined();

		const second = await stream("antigravity-acp-work", [user("hello")], "parent-work");
		expect(second.stopReason).toBe("stop");
		expect(captured.at(-1)?.GEMINI_HOME).toBe(workHome);
		expect(connections).toHaveLength(2);
	});

	it("resolves a permission requested by the non-default account", async () => {
		const { pi } = await load();
		const parked = await stream("antigravity-acp-work", [user("request permission")], "work-permission");
		const call = parked.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing permission tool call");

		const ctx = createFakeContext({ sessionId: "resolver", selectAnswer: (labels) => labels[0] });
		const tool = pi.tools.get(PERMISSION_TOOL_NAME);
		if (!tool) throw new Error("missing permission tool");
		const result = await tool.execute("call", { requestId: call.id }, undefined, undefined, ctx as never);
		expect(result.details).toMatchObject({ requestId: call.id, optionId: "allow-once", cancelled: false });
	});

	it("routes quota event requests to the named account", async () => {
		const { pi } = await load();
		const { AntigravityRuntime } = await import("../src/runtime.js");
		const workHome = path.join(root, "work-home");
		vi.spyOn(AntigravityRuntime.prototype, "quota").mockImplementation(function (this: AntigravityRuntime) {
			const home = (this as unknown as { baseEnv?: NodeJS.ProcessEnv }).baseEnv?.GEMINI_HOME;
			return Promise.resolve({ at: 0, groups: [{ displayName: home ?? "ambient", buckets: [] }] });
		});

		const request = (extra: object = {}) => new Promise<unknown>((resolve) => {
			pi.api.events.emit(QUOTA_REQUEST_CHANNEL, { ...extra, reply: resolve });
		});
		expect(await request()).toMatchObject({ ok: true, quota: { groups: [{ displayName: "ambient" }] } });
		expect(await request({ account: "work" })).toMatchObject({ ok: true, quota: { groups: [{ displayName: workHome }] } });
		expect(await request({ providerId: "antigravity-acp-work" })).toMatchObject({
			ok: true,
			quota: { groups: [{ displayName: workHome }] },
		});
		expect(await request({ account: "missing" })).toMatchObject({
			ok: false,
			error: expect.stringContaining('Unknown Antigravity account "missing"'),
		});
	});

	it("reports credentials per account in doctor output", async () => {
		const { pi, ctx } = await load();
		const workHome = path.join(root, "work-home");
		const directory = path.join(workHome, "antigravity-acp");
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		fs.writeFileSync(path.join(directory, "acp_token.json"), '{"refresh_token":"work-token"}', { mode: 0o600 });
		fs.writeFileSync(path.join(directory, "settings.json"), '{"auth":{"type":"oauth-personal"}}', { mode: 0o600 });

		const command = pi.commands.get("antigravity-acp")!;
		await command.handler("doctor", ctx as never);
		const text = ctx.ui.notify.mock.calls.at(-1)![0] as string;
		expect(text).toContain(`Account Google Antigravity (ACP) — Work (antigravity-acp-work):`);
		expect(text).toContain(`Credentials: ${directory}`);
		expect(text).toContain("Authentication: oauth-refreshable (oauth-personal)");
		expect(text).toContain("Authentication: missing");
	});

	it("applies tool-activity changes to every account's runtime", async () => {
		const { pi, ctx } = await load();
		const command = pi.commands.get("antigravity-acp")!;
		await command.handler("tool-activity off", ctx as never);
		const turn = await stream("antigravity-acp-work", [user("emit tool activity")], "work-activity");
		const thinking = turn.content.filter((block) => block.type === "thinking").map((block) => block.thinking).join("\n");
		expect(thinking).not.toContain("[Antigravity tool:");
	});

	it("lists accounts from the menu without reading the JSON by hand", async () => {
		const { pi } = await load();
		const ctx = createFakeContext({
			sessionId: "listed",
			selectAnswer: (labels) => labels.find((label) => label === "List accounts"),
		});
		await pi.commands.get("antigravity-acp")!.handler("accounts", ctx as never);
		const text = ctx.ui.notify.mock.calls.at(-1)![0] as string;
		expect(text).toContain("antigravity-acp-work");
		expect(text).toContain(path.join(root, "work-home", "antigravity-acp"));
	});

	it("adds an account from the interactive menu and registers its provider", async () => {
		const { pi } = await load();
		const extraHome = path.join(root, "extra-home");
		const ctx = createFakeContext({
			sessionId: "adder",
			selectAnswer: (labels) => labels.find((label) => label === "Add an account"),
			inputAnswer: (title) => title.startsWith("Antigravity account id")
				? "extra"
				: title.startsWith("Picker label") ? "Extra" : extraHome,
		});
		await pi.commands.get("antigravity-acp")!.handler("accounts", ctx as never);

		expect([...registry.keys()]).toEqual(["antigravity-acp", "antigravity-acp-work", "antigravity-acp-extra"]);
		expect(pi.providers.map((provider) => provider.name)).toContain("Google Antigravity (ACP) — Extra");
		const config = JSON.parse(fs.readFileSync(configFile(), "utf8")) as {
			accounts: Array<{ id: string; label?: string; geminiHome: string }>;
		};
		expect(config.accounts).toEqual([
			{ id: "work", label: "Work", geminiHome: path.join(root, "work-home") },
			{ id: "extra", label: "Extra", geminiHome: extraHome },
		]);
		await stream("antigravity-acp-extra", [user("hello")], "extra-session");
		expect(captured.at(-1)?.GEMINI_HOME).toBe(extraHome);
	});

	it("removes an account from the menu, unregisters its provider and updates the config", async () => {
		const { pi } = await load();
		const ctx = createFakeContext({
			sessionId: "remover",
			selectAnswer: (labels) => labels.includes("Remove an account")
				? "Remove an account"
				: labels.find((label) => label.includes("Work")),
			confirmAnswer: () => true,
		});
		await pi.commands.get("antigravity-acp")!.handler("accounts", ctx as never);

		expect([...registry.keys()]).toEqual(["antigravity-acp"]);
		expect(pi.providers.map((provider) => provider.id)).toEqual(["antigravity-acp"]);
		const config = JSON.parse(fs.readFileSync(configFile(), "utf8")) as { accounts: unknown[] };
		expect(config.accounts).toEqual([]);
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain("Removed Google Antigravity (ACP) — Work");
	});

	it("refuses to remove the default account", async () => {
		const { pi } = await load();
		const ctx = createFakeContext({
			sessionId: "remover",
			selectAnswer: (labels) => labels.includes("Remove an account")
				? "Remove an account"
				: labels.find((label) => label.includes("antigravity-acp)")),
			confirmAnswer: () => true,
		});
		await pi.commands.get("antigravity-acp")!.handler("accounts", ctx as never);
		expect([...registry.keys()]).toContain("antigravity-acp");
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain("cannot be removed");
	});

	it("logs out the account selected from the menu only", async () => {
		const { pi } = await load();
		const directory = path.join(root, "work-home", "antigravity-acp");
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const token = path.join(directory, "acp_token.json");
		fs.writeFileSync(token, '{"refresh_token":"work"}', { mode: 0o600 });
		const ctx = createFakeContext({
			sessionId: "logout",
			selectAnswer: (labels) => labels.find((label) => label.includes("Work")),
		});
		await pi.commands.get("antigravity-acp")!.handler("logout", ctx as never);
		expect(fs.existsSync(token)).toBe(false);
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain("Google Antigravity (ACP) — Work");
	});

	it("accepts an explicit account id for logout without prompting", async () => {
		const { pi } = await load();
		const directory = path.join(root, "work-home", "antigravity-acp");
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const token = path.join(directory, "acp_token.json");
		fs.writeFileSync(token, '{"refresh_token":"work"}', { mode: 0o600 });
		const ctx = createFakeContext({ sessionId: "logout-argument" });
		await pi.commands.get("antigravity-acp")!.handler("logout work", ctx as never);
		expect(fs.existsSync(token)).toBe(false);
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("keeps credentials on disk when an account is removed from the picker", async () => {
		const { pi } = await load();
		const directory = path.join(root, "work-home", "antigravity-acp");
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		const token = path.join(directory, "acp_token.json");
		fs.writeFileSync(token, '{"refresh_token":"work"}', { mode: 0o600 });
		const ctx = createFakeContext({ sessionId: "remove-keeps-token", confirmAnswer: () => true });
		await pi.commands.get("antigravity-acp")!.handler("accounts remove work", ctx as never);
		expect(registry.has("antigravity-acp-work")).toBe(false);
		expect(fs.existsSync(token)).toBe(true);
	});

	it("asks which account setup targets", async () => {
		const { pi } = await load();
		const ctx = createFakeContext({ sessionId: "setup", selectAnswer: () => undefined });
		await pi.commands.get("antigravity-acp")!.handler("setup", ctx as never);
		expect(ctx.ui.select).toHaveBeenCalledWith("Antigravity account", [
			"Google Antigravity (ACP) (antigravity-acp)",
			"Google Antigravity (ACP) — Work (antigravity-acp-work)",
		]);
	});

	it("keeps the account's session store isolated and closes every runtime", async () => {
		const { pi, ctx } = await load();
		await stream("antigravity-acp-work", [user("hello")], "work-session");
		const stores = fs.readdirSync(path.join(root, "agent", "antigravity-acp-provider", "sessions"));
		expect(stores).toEqual(["work.json"]);
		await pi.emit("session_shutdown", { reason: "quit" }, ctx);
		loaded.splice(0);
		expect(connections.every((connection) => !connection.process.alive)).toBe(true);
	});
});
