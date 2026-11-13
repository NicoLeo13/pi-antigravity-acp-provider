import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { FALLBACK_MODELS } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";
import { AntigravityRuntime } from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model = FALLBACK_MODELS[0]!;

describe("native Pi provider", () => {
	it("passes transcript instructions through _meta.antigravity.systemPrompt.append without duplicating them in session/prompt", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-provider-"));
		const log = path.join(root, "calls.jsonl");
		fs.writeFileSync(log, "");
		const prompts: Array<Parameters<AntigravityAcpConnection["prompt"]>[0]> = [];
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({
				...options,
				command: process.execPath,
				args: [fakeAgent],
				env: { ...process.env, ...options.env, FAKE_AGENT_LOG_FILE: log },
			});
			const prompt = connection.prompt.bind(connection);
			connection.prompt = (request, signal) => {
				prompts.push(request);
				return prompt(request, signal);
			};
			return connection;
		});
		try {
			const { provider } = createAntigravityProvider(runtime);
			const stream = provider.streamSimple(model, normalizeContext({
				systemPrompt: "Follow native transcript instructions",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			}), { apiKey: "test-key" });
			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
			const entries = fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; _meta?: unknown });
			const newSession = entries.find((entry) => entry.method === "session/new");
			expect(newSession?._meta).toMatchObject({
				antigravity: {
					enabledTools: [],
					eagerMcpServers: ["pi-bridge"],
					systemPrompt: { append: "Follow native transcript instructions" },
				},
			});
			expect(JSON.stringify(prompts[0]?.prompt)).not.toContain("Follow native transcript instructions");
			expect(prompts[0]?.prompt).toEqual([{ type: "text", text: "hello" }]);
		} finally {
			await runtime.close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("routes tools added by a transcript delta through the MCP bridge", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const { provider } = createAntigravityProvider(runtime);
			const tools = [{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) }];
			const context = normalizeContext({ messages: [
				{ role: "system", content: "Base instructions", timestamp: 0 },
				{ role: "system", content: "", toolsAdded: tools, timestamp: 1 },
				{ role: "user", content: "use bridge", timestamp: 2 },
			] });
			const first = await provider.streamSimple(model, context, { apiKey: "test-key" }).result();
			const call = first.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing transcript tool call");
			expect(call).toMatchObject({ name: "echo", arguments: { text: "from gemini" } });
			const second = await provider.streamSimple(model, normalizeContext({ messages: [
				...context.messages,
				first,
				{ role: "toolResult", toolCallId: call.id, toolName: "echo", content: [{ type: "text", text: "native result" }], isError: false, timestamp: 3 },
			] }), { apiKey: "test-key" }).result();
			expect(second.content).toEqual([{ type: "text", text: "native result" }]);
		} finally {
			await runtime.close();
		}
	});
});
