import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { createAntigravityProvider } from "../src/provider.js";
import {
	AntigravityRuntime,
	MANAGED_AUTH_MARKER,
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
} from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = {
	id: "gemini-test",
	name: "Gemini Test",
	api: "antigravity-acp",
	provider: "antigravity-acp",
	baseUrl: "",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 8_192,
};

describe("AntigravityRuntime", () => {
	it("discovers and runs models on a config-options-only ACP server", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "config-options"] }),
		);
		try {
			expect(await runtime.discoverModels("test-key")).toEqual([
				{ modelId: "auto", name: "Auto" }, { modelId: "gemini-test", name: "Gemini Test" },
			]);
			const first = runtime.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: "test-key", sessionId: "modern-session" });
			for await (const _event of first.stream) void _event;
			expect(first.message.stopReason).toBe("stop");
			expect((await runtime.snapshot()).processes[0]?.modelId).toBe("gemini-test");
			await runtime.setPermissionMode("default");
			expect((await runtime.snapshot()).permissionMode).toBe("default");
		} finally {
			await runtime.close();
		}
	});

	it("keeps sessions that only read models, quota or auth out of the user's workspace", async () => {
		// agy writes files such as skills/system/ into the cwd of each session it opens.
		const agentDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-acp-utility-cwd-")));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const cwds: { connection: string; session: string }[] = [];
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "browser-auth"] });
			const newSession = connection.newSession.bind(connection);
			connection.newSession = (cwd, ...rest) => {
				cwds.push({ connection: options.cwd, session: cwd });
				return newSession(cwd, ...rest);
			};
			return connection;
		});
		const utilityCwd = path.join(agentDir, "antigravity-acp-provider", "utility-cwd");
		try {
			await runtime.discoverModels("test-key");
			await runtime.verifyApiKey("test-key");
			await runtime.loginGoogle();
			await runtime.quota("test-key");
			expect(cwds).toEqual(Array.from({ length: 4 }, () => ({ connection: utilityCwd, session: utilityCwd })));
			expect(fs.statSync(utilityCwd).isDirectory()).toBe(true);

			cwds.length = 0;
			const turn = runtime.stream(model, { messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { apiKey: "test-key", sessionId: "workspace-session" });
			for await (const _event of turn.stream) void _event;
			expect(cwds).toEqual([{ connection: process.cwd(), session: process.cwd() }]);
		} finally {
			await runtime.close();
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("does not report Google login success if the server saves no token", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			await expect(runtime.loginGoogle()).rejects.toThrow("did not save a Google login");
		} finally {
			await runtime.close();
		}
	});

	it.skipIf(process.platform === "win32")("switches Google accounts after Pi logout without touching another profile", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-acp-switch-account-"));
		const agent = path.join(root, "pi");
		const shared = path.join(root, "shared");
		const token = path.join(agent, "antigravity-acp-provider", "gemini", "antigravity-acp", "acp_token.json");
		const sharedToken = path.join(shared, "antigravity-acp", "acp_token.json");
		fs.mkdirSync(path.dirname(sharedToken), { recursive: true });
		fs.writeFileSync(sharedToken, '{"refresh_token":"other-client"}');
		vi.stubEnv("PI_CODING_AGENT_DIR", agent);
		vi.stubEnv("GEMINI_HOME", shared);
		vi.stubEnv("GEMINI_API_KEY", undefined);
		vi.stubEnv("PI_ANTIGRAVITY_ACP_OAUTH_MODE", "manual");
		const runtime = new AntigravityRuntime((options) => {
			expect(options.env?.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
			return new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent, "headless-auth"] });
		});
		const { provider } = createAntigravityProvider(runtime);
		const models = createModels();
		models.setProvider(provider);
		function login(account: string) {
			let authorization: URL | undefined;
			const prompt = vi.fn(async () => {
				expect(authorization?.hostname).toBe("accounts.google.com");
				expect(authorization?.searchParams.get("prompt")).toContain("select_account");
				return account;
			});
			return models.login(provider.id, "oauth", {
				notify: (event) => {
					if (event.type === "info" && event.links?.[0]) authorization = new URL(event.links[0].url);
				},
				prompt,
			}).then(() => expect(prompt).toHaveBeenCalledOnce());
		}
		try {
			await expect(models.getAuth(provider.id)).resolves.toBeUndefined();
			await login("first-account");
			const firstLogin = (await models.getAuth(provider.id))?.auth.apiKey;
			expect(firstLogin).toMatch(new RegExp(`^${MANAGED_AUTH_MARKER}:`));
			await models.logout(provider.id);
			expect(fs.existsSync(token)).toBe(true);
			await expect(models.getAuth(provider.id)).resolves.toBeUndefined();
			await expect(models.checkAuth(provider.id)).resolves.toBeUndefined();
			await login("second-account");
			expect((await models.getAuth(provider.id))?.auth.apiKey).not.toBe(firstLogin);
			expect(JSON.parse(fs.readFileSync(token, "utf8"))).toEqual({ refresh_token: "second-account" });
			await runtime.logout();
			expect(fs.existsSync(token)).toBe(false);
			await expect(models.getAuth(provider.id)).rejects.toThrow("OAuth auth derivation failed");
			expect(fs.readFileSync(sharedToken, "utf8")).toBe('{"refresh_token":"other-client"}');
		} finally {
			await runtime.close();
			vi.unstubAllEnvs();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not reuse Google connections, saved sessions, or quota after logout falls back to an API key", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-acp-auth-fallback-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		vi.stubEnv("PI_ANTIGRAVITY_ACP_OAUTH_MODE", "browser");
		vi.stubEnv("GEMINI_API_KEY", "fixture-key");
		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({
			...options, command: process.execPath, args: [fakeAgent, "browser-auth"],
		}), "yolo", store);
		const { provider } = createAntigravityProvider(runtime);
		const models = createModels();
		models.setProvider(provider);
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		const run = (sessionId: string) => models.streamSimple(model, context, { sessionId }).result();
		async function quota() { return runtime.quota((await models.getAuth(provider.id))?.auth.apiKey); }
		try {
			await models.login(provider.id, "oauth", { notify() {}, prompt: async () => { throw new Error("unexpected prompt"); } });
			for (const sessionId of ["warm", "saved"]) {
				expect((await run(sessionId)).content).toEqual([{ type: "text", text: "Google account" }]);
			}
			await runtime.closeSession("saved");
			expect(store.get("saved")?.credentialId).toContain(MANAGED_AUTH_MARKER);
			expect((await quota()).groups[0]?.displayName).toBe("Google account");
			await models.logout(provider.id);
			for (const sessionId of ["warm", "saved"]) {
				expect((await run(sessionId)).content).toEqual([{ type: "text", text: "API key" }]);
			}
			expect((await runtime.snapshot()).processes.map((item) => item.restored)).toEqual([false, false]);
			expect(store.get("saved")?.credentialId).toMatch(/^api-key:[a-f0-9]{64}$/u);
			expect((await quota()).groups[0]?.displayName).toBe("API key");
		} finally {
			await runtime.close();
			vi.unstubAllEnvs();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("maps a complete ACP turn into balanced Pi events", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const context: Context = {
				systemPrompt: "Be useful",
				messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
			};
			const writer = runtime.stream(model, context, { sessionId: "pi-session", apiKey: "test-key" });
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.map((event) => event.type)).toEqual([
				"start",
				"thinking_start",
				"thinking_delta",
				"thinking_end",
				"text_start",
				"text_delta",
				"text_end",
				"done",
			]);
			const done = events.at(-1);
			expect(done).toMatchObject({
				type: "done",
				message: { usage: { input: 7, output: 3, totalTokens: 10 }, rawStopReason: "end_turn" },
			});
			const snapshot = await runtime.snapshot();
			expect(snapshot.bindings).toBe(1);
			expect(snapshot.permissionMode).toBe("yolo");
			expect(snapshot.processes[0]).toMatchObject({ modelId: "gemini-test", alive: true });
			await runtime.setPermissionMode("default");
			expect((await runtime.snapshot()).permissionMode).toBe("default");
			if (done?.type !== "done") throw new Error("missing first turn");
			const switchedModel = { ...model, id: "auto", name: "Auto" };
			const second = runtime.stream(
				switchedModel,
				{
					systemPrompt: "Be useful",
					messages: [
						...context.messages,
						done.message,
						{ role: "user", content: "second turn", timestamp: Date.now() },
					],
				},
				{ sessionId: "pi-session", apiKey: "test-key" },
			);
			for await (const _event of second.stream) void _event;
			const switched = await runtime.snapshot();
			expect(switched.processes[0]).toMatchObject({
				generation: snapshot.processes[0]?.generation,
				modelId: "auto",
			});
		} finally {
			await runtime.close();
		}
	});

	it("restores a persisted ACP session across runtime restarts", async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), "antigravity-runtime-session-"));
		const store = new AcpSessionStore(path.join(directory, "sessions.json"));
		const factory = (options: ConstructorParameters<typeof AntigravityAcpConnection>[0]) =>
			new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] });
		const firstRuntime = new AntigravityRuntime(factory, "yolo", store);
		try {
			const firstContext: Context = {
				messages: [{ role: "user", content: "first", timestamp: 1 }],
			};
			const first = firstRuntime.stream(model, firstContext, { sessionId: "persisted", apiKey: "test-key" });
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const done = firstEvents.at(-1);
			if (done?.type !== "done") throw new Error("first turn did not complete");
			await firstRuntime.close();

			const secondRuntime = new AntigravityRuntime(factory, "yolo", store);
			try {
				const second = secondRuntime.stream(
					model,
					{
						messages: [
							...firstContext.messages,
							done.message,
							{ role: "user", content: "second", timestamp: 2 },
						],
					},
					{ sessionId: "persisted", apiKey: "test-key" },
				);
				for await (const _event of second.stream) void _event;
				expect((await secondRuntime.snapshot()).processes[0]?.restored).toBe(true);
			} finally {
				await secondRuntime.close();
			}
		} finally {
			await firstRuntime.close();
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it("recreates the ACP session when the owned Pi prefix changes", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const first = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "original", timestamp: 1 }] },
				{ sessionId: "rewind-session", apiKey: "test-key" },
			);
			for await (const _event of first.stream) void _event;
			const firstGeneration = (await runtime.snapshot()).processes[0]?.generation;

			const second = runtime.stream(
				model,
				{
					messages: [
						{ role: "user", content: "changed", timestamp: 1 },
						{ role: "user", content: "continue", timestamp: 2 },
					],
				},
				{ sessionId: "rewind-session", apiKey: "test-key" },
			);
			for await (const _event of second.stream) void _event;
			const secondGeneration = (await runtime.snapshot()).processes[0]?.generation;
			expect(secondGeneration).not.toBe(firstGeneration);
		} finally {
			await runtime.close();
		}
	});

	it("recreates a warm session when transcript instructions change", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		const firstContext = normalizeContext({
			systemPrompt: "Original instructions",
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		try {
			const first = runtime.stream(model, firstContext, { sessionId: "system-delta", apiKey: "test-key" });
			for await (const _event of first.stream) void _event;
			const generation = (await runtime.snapshot()).processes[0]?.generation;
			const second = runtime.stream(model, normalizeContext({
				messages: [
					...firstContext.messages,
					first.message,
					{ role: "system", content: "Updated instructions", timestamp: 2 },
					{ role: "user", content: "continue", timestamp: 3 },
				],
			}), { sessionId: "system-delta", apiKey: "test-key" });
			for await (const _event of second.stream) void _event;
			expect(second.message.stopReason).toBe("stop");
			expect((await runtime.snapshot()).processes[0]?.generation).not.toBe(generation);
		} finally {
			await runtime.close();
		}
	});

	it("parks a permission request and resumes it from a Pi tool result", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const firstContext: Context = {
				messages: [{ role: "user", content: "request permission", timestamp: 1 }],
			};
			const firstWriter = runtime.stream(model, firstContext, {
				sessionId: "permission-session",
				apiKey: "test-key",
			});
			const firstEvents = [];
			for await (const event of firstWriter.stream) firstEvents.push(event);
			expect(firstEvents.map((event) => event.type)).toEqual([
				"start",
				"toolcall_start",
				"toolcall_delta",
				"toolcall_end",
				"done",
			]);
			const firstMessage = firstEvents.at(-1);
			if (firstMessage?.type !== "done") throw new Error("missing permission turn");
			const toolCall = firstMessage.message.content.find((block) => block.type === "toolCall");
			if (!toolCall || toolCall.type !== "toolCall") throw new Error("missing permission tool call");
			const request = runtime.getPermission(toolCall.id);
			expect(request?.options.map((option) => option.kind)).toEqual(["allow_once", "reject_once"]);

			const resumedContext: Context = {
				messages: [
					...firstContext.messages,
					firstMessage.message,
					{
						role: "toolResult",
						toolCallId: toolCall.id,
						toolName: PERMISSION_TOOL_NAME,
						content: [{ type: "text", text: "Rejected" }],
						details: {
							kind: PERMISSION_RESULT_KIND,
							requestId: toolCall.id,
							optionId: "reject-once",
							cancelled: false,
						},
						isError: false,
						timestamp: 2,
					},
				],
			};
			const secondWriter = runtime.stream(model, resumedContext, {
				sessionId: "permission-session",
				apiKey: "test-key",
			});
			const secondEvents = [];
			for await (const event of secondWriter.stream) secondEvents.push(event);
			expect(secondEvents.map((event) => event.type)).toEqual([
				"start",
				"text_start",
				"text_delta",
				"text_end",
				"done",
			]);
			expect(secondWriter.message.content).toEqual([{ type: "text", text: "Decision: selected" }]);
			expect(runtime.getPermission(toolCall.id)).toBeUndefined();
		} finally {
			await runtime.close();
		}
	});

	it("round-trips an MCP call through a genuine Pi tool call", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				messages: [{ role: "user", content: "use bridge", timestamp: 1 }],
				tools,
			};
			const firstWriter = runtime.stream(model, firstContext, { apiKey: "test-key" });
			const firstEvents = [];
			for await (const event of firstWriter.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing bridged tool turn");
			expect(firstDone.reason).toBe("toolUse");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing bridged tool call");
			expect(call).toMatchObject({ name: "echo", arguments: { text: "from gemini" } });

			const secondWriter = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "echo result" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ apiKey: "test-key" },
			);
			const secondEvents = [];
			for await (const event of secondWriter.stream) secondEvents.push(event);
			expect(secondWriter.message.content).toEqual([{ type: "text", text: "echo result" }]);
			expect(secondEvents.at(-1)?.type).toBe("done");
		} finally {
			await runtime.close();
		}
	});

	it.each(["parallel", "parallel reversed"])("batches %s MCP calls into one Pi tool turn", async (scenario) => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: `use bridge ${scenario}`, timestamp: 1 }],
			};
			const first = runtime.stream(model, firstContext, {
				sessionId: "parallel-session",
				apiKey: "test-key",
			});
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing parallel tool turn");
			const calls = firstDone.message.content.filter((block) => block.type === "toolCall");
			// Concurrent MCP clients may finish their handshakes in either order.
			expect(calls.map((call) => call.arguments.text).sort()).toEqual(["first", "second"]);

			const toolResults = calls.map((call, index) => ({
				role: "toolResult" as const,
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text" as const, text: `result-${call.arguments.text}` }],
				isError: false,
				timestamp: index + 2,
			}));
			const second = runtime.stream(
				model,
				{
					tools,
					messages: [...firstContext.messages, firstDone.message, ...toolResults],
				},
				{ sessionId: "parallel-session", apiKey: "test-key" },
			);
			for await (const _event of second.stream) void _event;
			expect(second.message.content).toEqual([{ type: "text", text: "result-first,result-second" }]);
		} finally {
			await runtime.close();
		}
	});

	it("honors cancellation on an MCP continuation stream", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const tools = [
				{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) },
			];
			const firstContext: Context = {
				tools,
				messages: [{ role: "user", content: "use bridge delayed", timestamp: 1 }],
			};
			const first = runtime.stream(model, firstContext, {
				sessionId: "continuation-abort",
				apiKey: "test-key",
			});
			const firstEvents = [];
			for await (const event of first.stream) firstEvents.push(event);
			const firstDone = firstEvents.at(-1);
			if (firstDone?.type !== "done") throw new Error("missing tool call turn");
			const call = firstDone.message.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing tool call");

			const controller = new AbortController();
			const second = runtime.stream(
				model,
				{
					tools,
					messages: [
						...firstContext.messages,
						firstDone.message,
						{
							role: "toolResult",
							toolCallId: call.id,
							toolName: call.name,
							content: [{ type: "text", text: "result" }],
							isError: false,
							timestamp: 2,
						},
					],
				},
				{ sessionId: "continuation-abort", apiKey: "test-key", signal: controller.signal },
			);
			setTimeout(() => controller.abort(), 30);
			const secondEvents = [];
			for await (const event of second.stream) secondEvents.push(event);
			expect(secondEvents.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			expect((await runtime.snapshot()).processes[0]?.alive).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("cancels an ACP prompt while preserving a healthy warm binding", async () => {
		let promptStarted!: () => void;
		const prompting = new Promise<void>((resolve) => { promptStarted = resolve; });
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] });
			const prompt = connection.prompt.bind(connection);
			connection.prompt = (...args) => { promptStarted(); return prompt(...args); };
			return connection;
		});
		try {
			const controller = new AbortController();
			const writer = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "hang", timestamp: 1 }] },
				{ sessionId: "abort-session", apiKey: "test-key", signal: controller.signal },
			);
			await prompting;
			controller.abort();
			const events = [];
			for await (const event of writer.stream) events.push(event);
			expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
			const snapshot = await runtime.snapshot();
			expect(snapshot.bindings).toBe(1);
			expect(snapshot.processes[0]?.alive).toBe(true);
		} finally {
			await runtime.close();
		}
	});
});
