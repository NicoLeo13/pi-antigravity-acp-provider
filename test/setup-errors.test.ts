import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpOperationTimeoutError, AntigravityAcpError } from "../src/acp/errors.js";
import { runtimeSetupError } from "../src/acp/setup-errors.js";

const release = { platform: "darwin-x86_64", version: "1.5.2" };

describe("Intel macOS runtime setup guidance", () => {
	it("adds conditional upstream guidance to an Intel initialize timeout and retains its cause", () => {
		const cause = new AcpOperationTimeoutError("initialize", 90_000, "SyntaxWarning: invalid escape sequence");
		const error = runtimeSetupError(cause, release);
		expect(error).toMatchObject({ code: "spawn", cause });
		expect(error.message).toContain("initialize timed out after 90000ms");
		expect(error.message).toContain("antigravity-cli/issues/1393");
		expect(error.message).toContain("Hardened Runtime/libffi");
		expect(error.message).toContain("permissions default");
		expect(error.message).toContain("not fully supported");
		expect(error.message).toContain("does not remove or replace code signatures");
	});

	it.each([
		["darwin-aarch64", new AcpOperationTimeoutError("initialize", 90_000)],
		["linux-x86_64", new AcpOperationTimeoutError("initialize", 90_000)],
		["windows-x86_64", new AcpOperationTimeoutError("initialize", 90_000)],
		["darwin-x86_64", new AcpOperationTimeoutError("session/new", 90_000)],
		["darwin-x86_64", new AntigravityAcpError("protocol", "SyntaxWarning: invalid escape sequence")],
		["darwin-x86_64", new Error("Antigravity ACP initialize timed out after 90000ms")],
		["darwin-x86_64", new Error("archive SHA-256 mismatch")],
	] as const)("does not misdiagnose %s / %s", (platform, cause) => {
		const error = runtimeSetupError(cause, { ...release, platform });
		expect(error.message).not.toContain("issues/1393");
		expect(error.message).toContain("trusted manual installation");
		expect(error.cause).toBe(cause);
	});

	it("classifies an actual unresponsive subprocess initialize without needing macOS", async () => {
		const connection = new AntigravityAcpConnection({
			cwd: process.cwd(), command: process.execPath,
			args: [fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url)), "initialize-timeout"],
			initializeTimeoutMs: 50,
		});
		try {
			const cause = await connection.initialize().catch((error: unknown) => error);
			expect(cause).toBeInstanceOf(AcpOperationTimeoutError);
			expect(runtimeSetupError(cause, release).message).toContain("issues/1393");
		} finally {
			await connection.close();
		}
		expect(connection.process.alive).toBe(false);
	});

	it("redacts the underlying diagnostic before adding guidance", () => {
		expect(runtimeSetupError(new Error("api_key=private-value"), release).message).not.toContain("private-value");
	});
});
