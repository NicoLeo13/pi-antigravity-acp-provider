import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	HeadlessOAuthRelay,
	shouldUseHeadlessOAuth,
} from "../src/acp/headless-oauth.js";

describe("headless OAuth detection", () => {
	it("uses manual OAuth for SSH and display-less Linux sessions", () => {
		expect(shouldUseHeadlessOAuth({ SSH_CONNECTION: "client server" }, "linux")).toBe(true);
		expect(shouldUseHeadlessOAuth({}, "linux")).toBe(true);
		expect(shouldUseHeadlessOAuth({ DISPLAY: ":0" }, "linux")).toBe(false);
	});

	it("does not enable the unsupported Windows relay automatically over SSH", () => {
		expect(shouldUseHeadlessOAuth({ SSH_TTY: "ssh" }, "win32")).toBe(false);
	});

	it("honors an explicit mode override", () => {
		expect(
			shouldUseHeadlessOAuth({ PI_ANTIGRAVITY_ACP_OAUTH_MODE: "manual", DISPLAY: ":0" }, "linux"),
		).toBe(true);
		expect(
			shouldUseHeadlessOAuth({ PI_ANTIGRAVITY_ACP_OAUTH_MODE: "browser", SSH_TTY: "/dev/pts/1" }, "linux"),
		).toBe(false);
	});
});

describe.skipIf(process.platform === "win32")("headless OAuth relay", () => {
	it("captures the browser URL and securely relays its loopback callback", async () => {
		let received: URL | undefined;
		const server = http.createServer((request, response) => {
			received = new URL(request.url ?? "/", "http://127.0.0.1");
			response.writeHead(200).end("Authenticated");
		});
		await listen(server);
		const port = (server.address() as AddressInfo).port;
		const redirect = `http://127.0.0.1:${port}/`;
		const authorizationUrl = authorization(redirect, "state-123");
		const relay = new HeadlessOAuthRelay();
		const browser = relay.env.BROWSER;
		if (!browser) throw new Error("missing captured browser command");
		const captureDirectory = path.dirname(browser);
		try {
			await run(browser, [authorizationUrl], relay.env);
			const captured = await relay.waitForAuthorization();
			const shown = new URL(captured.url);
			expect(shown.searchParams.get("prompt")).toBe("consent select_account");
			shown.searchParams.set("prompt", "consent");
			expect(shown.toString()).toBe(authorizationUrl);
			await relay.forwardCallback(`${redirect}?state=state-123&code=one-time-code`, captured);
			expect(received?.searchParams.get("state")).toBe("state-123");
			expect(received?.searchParams.get("code")).toBe("one-time-code");
		} finally {
			relay.dispose();
			await close(server);
		}
		expect(fs.existsSync(captureDirectory)).toBe(false);
	});

	it("rejects unexpected authorization origins", async () => {
		const relay = new HeadlessOAuthRelay();
		const browser = relay.env.BROWSER;
		if (!browser) throw new Error("missing captured browser command");
		try {
			await run(
				browser,
				["https://evil.example/oauth?redirect_uri=http://127.0.0.1:1234/&state=state"],
				relay.env,
			);
			await expect(relay.waitForAuthorization()).rejects.toThrow("unexpected OAuth authorization URL");
		} finally {
			relay.dispose();
		}
	});

	it("cancels while waiting for Antigravity to invoke the browser", async () => {
		const relay = new HeadlessOAuthRelay();
		const controller = new AbortController();
		const pending = relay.waitForAuthorization(controller.signal);
		controller.abort(new Error("test cancellation"));
		try {
			await expect(pending).rejects.toThrow("test cancellation");
		} finally {
			relay.dispose();
		}
	});

	it("accepts a bare authorization code and rejects callback mismatches", async () => {
		const server = http.createServer((_request, response) => response.writeHead(200).end());
		await listen(server);
		const port = (server.address() as AddressInfo).port;
		const redirect = `http://127.0.0.1:${port}/callback`;
		const relay = new HeadlessOAuthRelay();
		const browser = relay.env.BROWSER;
		if (!browser) throw new Error("missing captured browser command");
		try {
			await run(browser, [authorization(redirect, "expected-state")], relay.env);
			const captured = await relay.waitForAuthorization();
			await expect(
				relay.forwardCallback(
					`http://127.0.0.1:${port + 1}/callback?state=expected-state&code=code`,
					captured,
				),
			).rejects.toThrow("does not match");
			await expect(
				relay.forwardCallback(`${redirect}?state=wrong-state&code=code`, captured),
			).rejects.toThrow("state does not match");
			await expect(relay.forwardCallback("bare-code", captured)).resolves.toBeUndefined();
		} finally {
			relay.dispose();
			await close(server);
		}
	});
});

function authorization(redirect: string, state: string): string {
	const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	url.searchParams.set("client_id", "test-client");
	url.searchParams.set("redirect_uri", redirect);
	url.searchParams.set("state", state);
	url.searchParams.set("prompt", "consent");
	return url.toString();
}

function listen(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
}

function close(server: http.Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { env, stdio: "ignore", shell: false });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Command exited ${code}`))));
	});
}
