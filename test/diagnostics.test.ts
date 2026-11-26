import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpDiagnostics, DIAGNOSTIC_FILE_BYTES, DIAGNOSTIC_FILE_COUNT } from "../src/acp/diagnostics.js";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AntigravityAcpError } from "../src/acp/errors.js";

const roots: string[] = [];
const root = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-diagnostics-")); roots.push(dir); return dir; };
const records = (file: string) => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("private bounded ACP diagnostics", () => {
	it("does no filesystem work when disabled", async () => {
		const dir = path.join(root(), "absent");
		const log = new AcpDiagnostics(false, dir);
		await log.operation("initialize", async () => 1);
		log.close();
		expect(log.filePath).toBeUndefined();
		expect(fs.existsSync(dir)).toBe(false);
	});

	it("records timings, identity and safe stderr signals without persisting free-form secrets", async () => {
		const log = new AcpDiagnostics(true, root());
		log.spawn();
		log.identity({ name: "Antigravity ACP Server", version: "1.5.17" });
		log.identity({ name: "PRIVATE_NAME", version: "1.5.17-PRIVATE_VERSION" });
		log.stderr("HTTP 429 RESOURCE_EXHAUSTED retrying in 2s api_key=PRIVATE_KEY prompt=PRIVATE_PROMPT");
		log.stderr("SyntaxWarning PRIVATE_CONTENT");
		log.stderr("PRIVATE_OTHER_STDERR");
		await log.operation("initialize", async () => "PRIVATE_RESULT");
		await expect(log.operation("session/new", async () => { throw new AntigravityAcpError("auth", "PRIVATE_ERROR"); })).rejects.toThrow("PRIVATE_ERROR");
		log.exit(0, null);
		const output = fs.readFileSync(log.filePath!, "utf8");
		expect(output).not.toContain("PRIVATE_");
		const events = records(log.filePath!);
		expect(events).toContainEqual(expect.objectContaining({ event: "identity", name: "Antigravity ACP Server", version: "1.5.17" }));
		expect(events).toContainEqual(expect.objectContaining({ event: "stderr", category: "retry", retryDelayMs: 2000 }));
		expect(events).toContainEqual(expect.objectContaining({ event: "operation_end", operation: "session/new", outcome: "error", code: "auth", durationMs: expect.any(Number) }));
		if (process.platform !== "win32") {
			expect(fs.statSync(log.filePath!).mode & 0o777).toBe(0o600);
			expect(fs.statSync(path.dirname(log.filePath!)).mode & 0o777).toBe(0o700);
		}
	});

	it("caps a noisy file and ignores writes after close", () => {
		const log = new AcpDiagnostics(true, root());
		for (let i = 0; i < 6000; i++) log.stderr("HTTP 429 retrying in 2s");
		const size = fs.statSync(log.filePath!).size;
		expect(size).toBeGreaterThan(DIAGNOSTIC_FILE_BYTES / 2);
		expect(size).toBeLessThanOrEqual(DIAGNOSTIC_FILE_BYTES);
		log.exit(0, null);
		expect(fs.statSync(log.filePath!).size).toBe(size);
	});

	it("retains only recent owned logs and leaves unrelated files alone", () => {
		const dir = root();
		fs.writeFileSync(path.join(dir, "keep.txt"), "unrelated");
		for (let i = 0; i < DIAGNOSTIC_FILE_COUNT + 4; i++) {
			const log = new AcpDiagnostics(true, dir); log.spawn(); log.close();
		}
		expect(fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"))).toHaveLength(DIAGNOSTIC_FILE_COUNT);
		expect(fs.readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("unrelated");
	});

	it("does not throw when the diagnostic directory is unusable", async () => {
		const file = path.join(root(), "not-a-directory"); fs.writeFileSync(file, "x");
		const log = new AcpDiagnostics(true, file);
		expect(await log.operation("initialize", async () => 42)).toBe(42);
		log.close();
		expect(log.filePath).toBeUndefined();
	});
});

describe("connection diagnostic integration", () => {
	it("records real subprocess phases and classified stderr without payloads", async () => {
		const agentDir = root();
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_ANTIGRAVITY_ACP_DEBUG", "1");
		const connection = new AntigravityAcpConnection({ cwd: agentDir, command: process.execPath,
			args: [fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url)), "diagnostic-signals"] });
		try {
			await connection.initialize();
			await connection.authenticate({ methodId: "api", _meta: { "api-key": "PRIVATE_API_KEY" } });
			const session = await connection.newSession(agentDir);
			await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "PRIVATE_REQUEST" }] });
		} finally { await connection.close(); }
		const output = fs.readFileSync(connection.diagnosticsPath!, "utf8");
		expect(output).not.toMatch(/PRIVATE_|TEST_SECRET/);
		const events = records(connection.diagnosticsPath!);
		for (const operation of ["initialize", "authenticate", "session/new", "session/prompt"]) {
			expect(events).toContainEqual(expect.objectContaining({ event: "operation_start", operation }));
			expect(events).toContainEqual(expect.objectContaining({ event: "operation_end", operation, outcome: "ok" }));
		}
		expect(events).toContainEqual(expect.objectContaining({ event: "stderr", category: "rate-limit" }));
		expect(events).toContainEqual(expect.objectContaining({ event: "exit" }));
	});

	it("records prompt cancellation without persisting its request", async () => {
		const dir = root(); vi.stubEnv("PI_CODING_AGENT_DIR", dir); vi.stubEnv("PI_ANTIGRAVITY_ACP_DEBUG", "1");
		const log = path.join(dir, "calls.jsonl"); fs.writeFileSync(log, "");
		const connection = new AntigravityAcpConnection({ cwd: dir, command: process.execPath,
			args: [fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url))], env: { ...process.env, FAKE_AGENT_LOG_FILE: log } });
		try {
			const session = await connection.newSession(dir);
			const controller = new AbortController();
			const pending = connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hang PRIVATE_REQUEST" }] }, controller.signal);
			const observed = pending.catch((error: unknown) => error);
			await vi.waitFor(() => expect(fs.readFileSync(log, "utf8")).toContain("session/prompt"));
			controller.abort();
			expect(await observed).toMatchObject({ code: "aborted" });
		} finally { await connection.close(); }
		expect(records(connection.diagnosticsPath!)).toContainEqual(expect.objectContaining({ event: "cancel" }));
		expect(fs.readFileSync(connection.diagnosticsPath!, "utf8")).not.toContain("PRIVATE_REQUEST");
	});

	it("records failed initialize timing and closes cleanly", async () => {
		const dir = root(); vi.stubEnv("PI_CODING_AGENT_DIR", dir); vi.stubEnv("PI_ANTIGRAVITY_ACP_DEBUG", "1");
		const connection = new AntigravityAcpConnection({ cwd: dir, command: process.execPath,
			args: [fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url)), "initialize-timeout"], initializeTimeoutMs: 50 });
		try { await expect(connection.initialize()).rejects.toThrow("initialize timed out"); }
		finally { await connection.close(); }
		expect(records(connection.diagnosticsPath!)).toContainEqual(expect.objectContaining({ event: "operation_end", operation: "initialize", outcome: "error", code: "timeout" }));
	});
});
