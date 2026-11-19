import { normalizeContext, type Context } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { PERMISSION_TOOL_NAME } from "../src/runtime.js";
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
