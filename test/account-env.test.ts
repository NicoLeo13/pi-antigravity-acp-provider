import type { Model } from "@earendil-works/pi-ai";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { AntigravityConnectionOptions } from "../src/acp/connection.js";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { AntigravityRuntime } from "../src/runtime.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const roots: string[] = [];

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

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function accountHome(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-account-"));
	roots.push(root);
	return root;
}

function writeAccountToken(home: string, token = "account"): string {
	const directory = path.join(home, ".gemini", "antigravity-acp");
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const file = path.join(directory, "acp_token.json");
	fs.writeFileSync(file, `{"refresh_token":"${token}"}\n`, { mode: 0o600 });
	return file;
}

/** A connection factory that records the environment each spawn receives and
 * still drives a working ACP server, so a test observes the real call path. */
function recordingFactory(captured: Array<NodeJS.ProcessEnv | undefined>) {
	return (options: AntigravityConnectionOptions) => {
		captured.push(options.env);
		return new AntigravityAcpConnection({
			...options,
			command: process.execPath,
			args: [fakeAgent, "config-options"],
		});
	};
}

describe("per-account environment", () => {
	it("spawns every connection with the configured account environment", async () => {
		const home = accountHome();
		const geminiHome = path.join(home, ".gemini");
		const captured: Array<NodeJS.ProcessEnv | undefined> = [];
		const runtime = new AntigravityRuntime(recordingFactory(captured), "yolo", undefined, {
			env: { HOME: home, GEMINI_HOME: geminiHome, PATH: process.env.PATH },
		});
		try {
			await runtime.discoverModels("test-key");
		} finally {
			await runtime.close();
		}
		expect(captured.length).toBeGreaterThan(0);
		for (const env of captured) {
			expect(env?.HOME).toBe(home);
			expect(env?.GEMINI_HOME).toBe(geminiHome);
		}
	});

	it("keeps the ambient environment when no account environment is configured", async () => {
		const captured: Array<NodeJS.ProcessEnv | undefined> = [];
		const runtime = new AntigravityRuntime(recordingFactory(captured), "yolo", undefined, {});
		try {
			await runtime.discoverModels("test-key");
		} finally {
			await runtime.close();
		}
		expect(captured.length).toBeGreaterThan(0);
		for (const env of captured) expect(env).toBeUndefined();
	});

	it("spawns a turn's binding with the configured account environment", async () => {
		const home = accountHome();
		const captured: Array<NodeJS.ProcessEnv | undefined> = [];
		const runtime = new AntigravityRuntime(recordingFactory(captured), "yolo", undefined, {
			env: { HOME: home, GEMINI_HOME: path.join(home, ".gemini"), PATH: process.env.PATH },
		});
		try {
			const stream = runtime.stream(
				model,
				{ messages: [{ role: "user", content: "hello", timestamp: 1 }] },
				{ apiKey: "test-key", sessionId: "account-session" },
			);
			for await (const event of stream.stream) void event;
			expect(stream.message.stopReason).toBe("stop");
		} finally {
			await runtime.close();
		}
		expect(captured.at(-1)?.HOME).toBe(home);
	});

	it("reports auth health from the account home", async () => {
		const home = accountHome();
		writeAccountToken(home);
		const runtime = new AntigravityRuntime(recordingFactory([]), "yolo", undefined, {
			env: { HOME: home, PATH: process.env.PATH },
		});
		try {
			const health = await runtime.authHealth();
			expect(health.status).toBe("oauth-refreshable");
			expect(health.tokenFile).toBe(true);
		} finally {
			await runtime.close();
		}
	});

	it("keeps the account home when the headless OAuth relay supplies its own environment", async () => {
		const home = accountHome();
		const geminiHome = path.join(home, ".gemini");
		const captured: Array<NodeJS.ProcessEnv | undefined> = [];
		const previous = process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
		process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = "manual";
		const controller = new AbortController();
		const runtime = new AntigravityRuntime(
			(options) => {
				captured.push(options.env);
				controller.abort();
				return new AntigravityAcpConnection({
					...options,
					command: process.execPath,
					args: [fakeAgent, "config-options"],
				});
			},
			"yolo",
			undefined,
			{ env: { HOME: home, GEMINI_HOME: geminiHome, PATH: process.env.PATH } },
		);
		try {
			await expect(
				runtime.loginGoogle(controller.signal, undefined, {
					showAuthorizationUrl() {},
					promptForCallback: () => new Promise(() => {}),
				}),
			).rejects.toThrow();
		} finally {
			if (previous === undefined) delete process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE;
			else process.env.PI_ANTIGRAVITY_ACP_OAUTH_MODE = previous;
			await runtime.close();
		}
		// The relay rewrites BROWSER/PATH from its base environment; it must not
		// take HOME/GEMINI_HOME back from the ambient process.
		expect(captured[0]?.HOME).toBe(home);
		expect(captured[0]?.GEMINI_HOME).toBe(geminiHome);
		expect(captured[0]?.BROWSER).toBeDefined();
	});

	it("clears the account's credentials on logout", async () => {
		const home = accountHome();
		const accountToken = writeAccountToken(home, "account");
		const settingsPath = path.join(path.dirname(accountToken), "settings.json");
		fs.writeFileSync(settingsPath, JSON.stringify({ auth: { type: "oauth-personal" }, theme: "dark" }), { mode: 0o600 });
		const runtime = new AntigravityRuntime(undefined, "yolo", new AcpSessionStore(path.join(home, "sessions.json")), {
			env: { HOME: home },
		});
		await runtime.logout();
		expect(fs.existsSync(accountToken)).toBe(false);
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		expect(settings.auth).toBeUndefined();
		expect(settings.theme).toBe("dark");
	});
});
