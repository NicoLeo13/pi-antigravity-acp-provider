import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveConfigRoot } from "../config.js";
import { AntigravityAcpError } from "./errors.js";

export const DIAGNOSTIC_FILE_BYTES = 256 * 1024;
export const DIAGNOSTIC_FILE_COUNT = 10;
const LOG_NAME = /^acp-[0-9a-f-]{36}\.jsonl$/u;

type LogState = { kind: "disabled" } | { kind: "open"; fd: number; bytes: number } | { kind: "closed" };
export type AcpOperation = "initialize" | "authenticate" | "session/new" | "session/load" | "session/resume" |
	"session/set_model" | "session/set_mode" | "session/set_config_option" | "session/prompt";
type RecordData =
	| { event: "spawn"; platform: string; arch: string }
	| { event: "identity"; name: string; version: string }
	| { event: "operation_start"; operation: AcpOperation; id: number }
	| { event: "operation_end"; operation: AcpOperation; id: number; durationMs: number; outcome: "ok" | "error"; code?: string }
	| { event: "stderr"; category: "rate-limit" | "retry" | "startup-warning"; retryDelayMs?: number }
	| { event: "cancel" }
	| { event: "exit"; code: number | null; signal: NodeJS.Signals | null };

export class AcpDiagnostics {
	readonly filePath: string | undefined;
	private state: LogState = { kind: "disabled" };
	private readonly startedAt = performance.now();
	private nextOperation = 1;

	constructor(enabled = process.env.PI_ANTIGRAVITY_ACP_DEBUG === "1", directory = path.join(resolveConfigRoot(), "debug")) {
		if (!enabled) return;
		try {
			fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
			if (!fs.lstatSync(directory).isDirectory()) return;
			fs.chmodSync(directory, 0o700);
			const file = path.join(directory, `acp-${randomUUID()}.jsonl`);
			const fd = fs.openSync(file, "wx", 0o600);
			this.filePath = file;
			this.state = { kind: "open", fd, bytes: 0 };
			this.prune(directory);
		} catch {
			// Diagnostics must never prevent an ACP request or process from running.
		}
	}

	spawn(): void {
		this.write({ event: "spawn", platform: process.platform, arch: process.arch });
	}

	identity(info: { name: string; version: string } | null | undefined): void {
		const name = info?.name === "antigravity-acp" || info?.name === "Antigravity ACP Server" ? info.name : "other";
		const version = info?.version && /^(?:agy_acp_server_)?\d{1,6}\.\d{1,6}\.\d{1,6}$/u.test(info.version) ? info.version : "unknown";
		this.write({ event: "identity", name, version });
	}

	async operation<T>(operation: AcpOperation, run: () => Promise<T>): Promise<T> {
		const id = this.nextOperation++;
		const startedAt = performance.now();
		this.write({ event: "operation_start", operation, id });
		try {
			const result = await run();
			this.write({ event: "operation_end", operation, id, durationMs: Math.round(performance.now() - startedAt), outcome: "ok" });
			return result;
		} catch (error) {
			this.write({ event: "operation_end", operation, id, durationMs: Math.round(performance.now() - startedAt), outcome: "error",
				...(error instanceof AntigravityAcpError ? { code: error.code } : {}) });
			throw error;
		}
	}

	stderr(line: string): void {
		if (/429|RESOURCE_EXHAUSTED/iu.test(line)) this.write({ event: "stderr", category: "rate-limit" });
		if (/retry|backoff/iu.test(line)) {
			const delay = /(?:retry(?:ing)?\s+(?:after|in)|delay)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|seconds?)\b/iu.exec(line);
			const ms = delay ? Number(delay[1]) * (delay[2]!.toLowerCase() === "ms" ? 1 : 1000) : undefined;
			this.write({ event: "stderr", category: "retry", ...(ms !== undefined && Number.isFinite(ms) ? { retryDelayMs: ms } : {}) });
		}
		if (/SyntaxWarning/iu.test(line)) this.write({ event: "stderr", category: "startup-warning" });
	}

	cancel(): void {
		this.write({ event: "cancel" });
	}

	exit(code: number | null, signal: NodeJS.Signals | null): void {
		this.write({ event: "exit", code, signal });
		this.close();
	}

	close(): void {
		if (this.state.kind !== "open") return;
		try { fs.closeSync(this.state.fd); } catch { /* Best effort. */ }
		this.state = { kind: "closed" };
		if (this.filePath) this.prune(path.dirname(this.filePath));
	}

	private write(data: RecordData): void {
		if (this.state.kind !== "open") return;
		const record = JSON.stringify({ timestamp: new Date().toISOString(), elapsedMs: Math.round(performance.now() - this.startedAt), ...data }) + "\n";
		const bytes = Buffer.byteLength(record);
		if (this.state.bytes + bytes > DIAGNOSTIC_FILE_BYTES) { this.close(); return; }
		try {
			fs.writeSync(this.state.fd, record);
			this.state.bytes += bytes;
		} catch {
			this.close();
		}
	}

	private prune(directory: string): void {
		try {
			const files = fs.readdirSync(directory).filter((name) => LOG_NAME.test(name)).flatMap((name) => {
				try {
					const file = path.join(directory, name);
					const stat = fs.lstatSync(file);
					return stat.isFile() ? [{ file, modifiedAt: stat.mtimeMs }] : [];
				} catch { return []; }
			}).sort((a, b) => Number(b.file === this.filePath) - Number(a.file === this.filePath) || b.modifiedAt - a.modifiedAt || a.file.localeCompare(b.file));
			for (const entry of files.slice(DIAGNOSTIC_FILE_COUNT)) {
				if (entry.file !== this.filePath) fs.rmSync(entry.file, { force: true });
			}
		} catch { /* Retention is best effort, including concurrent writers. */ }
	}
}
