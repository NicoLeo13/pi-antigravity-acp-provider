import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { withStoreLock } from "../src/acp/store-lock.js";

describe("cross-process session transactions", () => {
	it("preserves concurrent saves and removals from independent Pi processes", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-concurrent-"));
		try {
			// Bundle the real implementation for independent workers. TypeScript 7
			// no longer exposes transpileModule; avoid compiler internals and brittle
			// import rewrites while keeping real cross-process lock contention.
			buildSync({
				entryPoints: [fileURLToPath(new URL("../src/acp/session-store.ts", import.meta.url))],
				outfile: path.join(dir, "session-store.cjs"),
				bundle: true,
				platform: "node",
				format: "cjs",
				target: "node22",
			});
			const file = path.join(dir, "sessions.json");
			const worker = `
				const fs = require('node:fs');
				const { AcpSessionStore } = require(${JSON.stringify(path.join(dir, "session-store.cjs"))});
				const read = fs.readFileSync;
				fs.readFileSync = function(file, ...args) {
					const data = read.call(this, file, ...args);
					if (file === ${JSON.stringify(file)}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
					return data;
				};
				const store = new AcpSessionStore(${JSON.stringify(file)});
				const id = process.argv[1];
				for (let i = 0; i < 12; i++) {
					store.save({ piSessionId: id + ':' + i, acpSessionId: 'acp', acpModelId: 'model', credentialId: 'ambient', cwd: '/tmp', messageCount: 1, historyFingerprint: 'hash', lastActive: Date.now() });
				}
				for (let i = 0; i < 6; i++) store.remove(id + ':' + i);
			`;
			await Promise.all(Array.from({ length: 4 }, (_, i) => new Promise<void>((resolve, reject) => {
				const child = spawn(process.execPath, ["-e", worker, String(i)], { stdio: ["ignore", "ignore", "pipe"] });
				let stderr = "";
				child.stderr.on("data", (chunk) => { stderr += chunk; });
				child.on("error", reject);
				child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `Worker exited ${code}`)));
			})));
			const records = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ piSessionId: string }>;
			expect(records.map((r) => r.piSessionId).sort()).toEqual(Array.from({ length: 4 }, (_, i) => Array.from({ length: 6 }, (_, j) => `${i}:${j + 6}`)).flat().sort());
			new AcpSessionStore(file).clear();
			expect(fs.existsSync(file)).toBe(false);
			expect(fs.existsSync(`${file}.lock`)).toBe(false);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	}, 15_000);

	it("releases the lock on failure and recovers stale locks", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-lock-"));
		const file = path.join(dir, "sessions.json");
		try {
			expect(() => withStoreLock(file, () => { throw new Error("write failed"); })).toThrow("write failed");
			expect(fs.existsSync(`${file}.lock`)).toBe(false);
			fs.mkdirSync(`${file}.lock`);
			const old = new Date(Date.now() - 60_000);
			fs.utimesSync(`${file}.lock`, old, old);
			withStoreLock(file, () => fs.writeFileSync(file, "[]"));
			expect(fs.existsSync(`${file}.lock`)).toBe(false);
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
});
