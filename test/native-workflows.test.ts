import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const roots: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("native workflows", () => {
	it.each([undefined, false, true])("applies the profile opt-in %s to new, loaded and resumed sessions", async (nativeWorkflows) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-native-workflows-"));
		roots.push(root);
		const agentDir = path.join(root, "profile");
		const configDir = path.join(agentDir, "antigravity-acp-provider");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ nativeWorkflows }));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		const log = path.join(root, "requests.jsonl");
		const connection = new AntigravityAcpConnection({
			cwd: root,
			command: process.execPath,
			args: [fakeAgent],
			env: { ...process.env, FAKE_AGENT_LOG_FILE: log, FAKE_AGENT_WRITE_RUN_WORKFLOW: "1" },
		});
		const skill = path.join(root, "skills", "system", "run-workflow", "SKILL.md");
		try {
			const session = await connection.newSession(root);
			expect(fs.existsSync(skill)).toBe(nativeWorkflows === true);
			await connection.loadSession(session.sessionId, root);
			await connection.resumeSession(session.sessionId, root);
			const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const lifecycle = requests.filter((request) => ["session/new", "session/load", "session/resume"].includes(request.method));
			expect(lifecycle).toHaveLength(3);
			for (const request of lifecycle) {
				expect(request.params.cwd).toBe(root);
				expect(request.params._meta).toEqual({ antigravity: { disabledTools: nativeWorkflows ? [] : ["run_workflow"] } });
			}
			fs.mkdirSync(path.dirname(skill), { recursive: true });
			fs.writeFileSync(skill, "# user-authored\n");
		} finally {
			await connection.close();
		}
		expect(fs.readFileSync(skill, "utf8")).toBe("# user-authored\n");
	});
});
