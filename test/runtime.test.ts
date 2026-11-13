import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import {
	AntigravityRuntime,
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

	it("recognizes Gemini CLI's advertised Google login method", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			await expect(runtime.loginGoogle()).resolves.toBeUndefined();
		} finally {
			await runtime.close();
		}
	});

	it("relays Google login through Pi on a headless host", async () => {
		const previousMode = process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
		process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = "manual";
		const runtime = new AntigravityRuntime(
			(options) =>
				new AntigravityAcpConnection({
					...options,
					command: process.execPath,
					args: [fakeAgent, "headless-auth"],
				}),
		);
		let shownUrl: string | undefined;
		try {
			await runtime.loginGoogle(undefined, undefined, {
				showAuthorizationUrl(url) {
					shownUrl = url;
				},
				promptForCallback: async () => {
					if (!shownUrl) throw new Error("authorization URL was not shown");
					const authorization = new URL(shownUrl);
					const redirect = authorization.searchParams.get("redirect_uri");
					const state = authorization.searchParams.get("state");
					if (!redirect || !state) throw new Error("authorization URL is incomplete");
					return `${redirect}?state=${encodeURIComponent(state)}&code=fake-code`;
				},
			});
			expect(shownUrl).toMatch(/^https:\/\/accounts\.google\.com\//u);
		} finally {
			await runtime.close();
			if (previousMode === undefined) delete process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
			else process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = previousMode;
		}
	});

	it("does not prompt when headless login reuses cached authentication", async () => {
		const previousMode = process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
		process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = "manual";
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		const progress: string[] = [];
		try {
			await runtime.loginGoogle(undefined, (message) => progress.push(message), {
				showAuthorizationUrl() {
					throw new Error("cached authentication unexpectedly showed a URL");
				},
				promptForCallback: async () => {
					throw new Error("cached authentication unexpectedly prompted");
				},
			});
			expect(progress).toContain("Antigravity reused the saved Google login.");
		} finally {
			await runtime.close();
			if (previousMode === undefined) delete process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
			else process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = previousMode;
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

	it("auto-approves pi-bridge permission requests and immediately rejects built-in tool permissions", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const bridgeWriter = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "pi-bridge permission", timestamp: 1 }] },
				{ sessionId: "permission-bridge", apiKey: "test-key" },
			);
			const bridgeEvents = [];
			for await (const event of bridgeWriter.stream) bridgeEvents.push(event);
			expect(bridgeEvents.some((event) => event.type === "toolcall_start")).toBe(false);
			expect(bridgeWriter.message.stopReason).toBe("stop");
			expect(bridgeWriter.message.content).toEqual([{ type: "text", text: "Decision: selected" }]);

			const nativeWriter = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "request permission", timestamp: 2 }] },
				{ sessionId: "permission-native", apiKey: "test-key" },
			);
			const nativeEvents = [];
			for await (const event of nativeWriter.stream) nativeEvents.push(event);
			expect(nativeEvents.some((event) => event.type === "toolcall_start")).toBe(false);
			expect(nativeWriter.message.stopReason).toBe("stop");
			expect(nativeWriter.message.content).toEqual([{ type: "text", text: "Decision: cancelled" }]);
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
