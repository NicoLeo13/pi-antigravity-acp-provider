import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { prepareIsolatedAcpEnvironment } from "../src/acp/isolated-env.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

function makeSourceHome(root: string): { sourceHome: string; sourceAcpDir: string } {
	const sourceHome = path.join(root, "source-gemini");
	const sourceAcpDir = path.join(sourceHome, "antigravity-acp");
	fs.mkdirSync(path.join(sourceAcpDir, "conversations"), { recursive: true });
	fs.mkdirSync(path.join(sourceHome, "config", "skills", "global-skill"), { recursive: true });
	fs.mkdirSync(path.join(sourceHome, "antigravity-cli", "skills", "cli-skill"), { recursive: true });
	fs.writeFileSync(path.join(sourceAcpDir, "acp_token.json"), JSON.stringify({ refresh_token: "rt-1" }));
	fs.writeFileSync(path.join(sourceAcpDir, "acp_business_token.json"), JSON.stringify({ token: "bt-1" }));
	fs.writeFileSync(
		path.join(sourceAcpDir, "settings.json"),
		JSON.stringify({
			auth: { type: "oauth-personal" },
			gcp: { project: "proj-1", location: "us" },
			telemetry: { enabled: false },
			mcpServers: { forbidden: { command: "evil" } },
			hooks: { PreToolUse: ["bad"] },
			extraKey: "drop-me",
		}),
	);
	fs.writeFileSync(path.join(sourceHome, "settings.json"), JSON.stringify({ rootOnly: true }));
	fs.writeFileSync(path.join(sourceHome, "config", "mcp_config.json"), JSON.stringify({ mcpServers: {} }));
	fs.writeFileSync(path.join(sourceHome, "config", "hooks.json"), JSON.stringify({ hooks: {} }));
	fs.writeFileSync(path.join(sourceHome, "config", "skills", "global-skill", "SKILL.md"), "# global");
	fs.writeFileSync(path.join(sourceHome, "antigravity-cli", "skills", "cli-skill", "SKILL.md"), "# cli");
	return { sourceHome, sourceAcpDir };
}

describe("prepareIsolatedAcpEnvironment", () => {
	it("copies only tokens and sanitized settings into an isolated GEMINI_HOME with an empty workspace", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-isolated-env-"));
		roots.push(root);
		const { sourceHome, sourceAcpDir } = makeSourceHome(root);
		const realCwd = path.join(root, "project-a");
		const isolatedRoot = path.join(root, "host-acp");
		fs.mkdirSync(realCwd, { recursive: true });

		const isolated = prepareIsolatedAcpEnvironment({
			realCwd,
			sourceEnv: { ...process.env, GEMINI_HOME: sourceHome },
			isolatedRoot,
		});

		expect(isolated.env.GEMINI_HOME).toBe(isolated.geminiHome);
		expect(isolated.acpDir).toBe(path.join(isolated.geminiHome, "antigravity-acp"));
		expect(isolated.workspaceDir).toBe(path.join(isolated.geminiHome, "workspace"));
		expect(fs.readdirSync(isolated.workspaceDir)).toEqual([]);
		expect(fs.existsSync(path.join(isolated.acpDir, "conversations"))).toBe(true);
		expect(fs.existsSync(path.join(isolated.geminiHome, "config"))).toBe(false);
		expect(fs.existsSync(path.join(isolated.geminiHome, "antigravity-cli"))).toBe(false);
		expect(fs.existsSync(path.join(isolated.geminiHome, "settings.json"))).toBe(false);
		expect(sourceAcpDir).toContain("source-gemini");

		expect(JSON.parse(fs.readFileSync(path.join(isolated.acpDir, "acp_token.json"), "utf8"))).toEqual({
			refresh_token: "rt-1",
		});
		expect(JSON.parse(fs.readFileSync(path.join(isolated.acpDir, "acp_business_token.json"), "utf8"))).toEqual({
			token: "bt-1",
		});
		expect(JSON.parse(fs.readFileSync(path.join(isolated.acpDir, "settings.json"), "utf8"))).toEqual({
			auth: { type: "oauth-personal" },
			gcp: { project: "proj-1", location: "us" },
			telemetry: { enabled: false },
		});

		expect(fs.statSync(isolated.acpDir).mode & 0o777).toBe(0o700);
		expect(fs.statSync(isolated.workspaceDir).mode & 0o777).toBe(0o700);
		expect(fs.statSync(path.join(isolated.acpDir, "acp_token.json")).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.join(isolated.acpDir, "acp_business_token.json")).mode & 0o777).toBe(0o600);
		expect(fs.statSync(path.join(isolated.acpDir, "settings.json")).mode & 0o777).toBe(0o600);
	});

	it("removes stale tokens and settings when deleted from the source directory", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-isolated-stale-"));
		roots.push(root);
		const { sourceHome, sourceAcpDir } = makeSourceHome(root);
		const realCwd = path.join(root, "project-a");
		const isolatedRoot = path.join(root, "host-acp");
		fs.mkdirSync(realCwd, { recursive: true });

		const first = prepareIsolatedAcpEnvironment({
			realCwd,
			sourceEnv: { ...process.env, GEMINI_HOME: sourceHome },
			isolatedRoot,
		});
		expect(fs.existsSync(path.join(first.acpDir, "acp_token.json"))).toBe(true);
		expect(fs.existsSync(path.join(first.acpDir, "settings.json"))).toBe(true);

		fs.rmSync(path.join(sourceAcpDir, "acp_token.json"));
		fs.rmSync(path.join(sourceAcpDir, "acp_business_token.json"));
		fs.rmSync(path.join(sourceAcpDir, "settings.json"));

		const second = prepareIsolatedAcpEnvironment({
			realCwd,
			sourceEnv: { ...process.env, GEMINI_HOME: sourceHome },
			isolatedRoot,
		});
		expect(second.geminiHome).toBe(first.geminiHome);
		expect(fs.existsSync(path.join(second.acpDir, "acp_token.json"))).toBe(false);
		expect(fs.existsSync(path.join(second.acpDir, "acp_business_token.json"))).toBe(false);
		expect(fs.existsSync(path.join(second.acpDir, "settings.json"))).toBe(false);
	});

	it("uses deterministic per-project directories so conversations persist per realCwd without cross-project mixing", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-isolated-determinism-"));
		roots.push(root);
		const { sourceHome } = makeSourceHome(root);
		const isolatedRoot = path.join(root, "host-acp");
		const projectA = path.join(root, "project-a");
		const projectB = path.join(root, "project-b");
		fs.mkdirSync(projectA, { recursive: true });
		fs.mkdirSync(projectB, { recursive: true });

		const firstA = prepareIsolatedAcpEnvironment({
			realCwd: projectA,
			sourceEnv: { ...process.env, GEMINI_HOME: sourceHome },
			isolatedRoot,
		});
		const marker = path.join(firstA.acpDir, "conversations", "keep-me.meta");
		fs.writeFileSync(marker, "ok");

		const secondA = prepareIsolatedAcpEnvironment({
			realCwd: projectA,
			sourceEnv: { ...process.env, GEMINI_HOME: sourceHome },
			isolatedRoot,
		});
		const envB = prepareIsolatedAcpEnvironment({
			realCwd: projectB,
			sourceEnv: { ...process.env, GEMINI_HOME: sourceHome },
			isolatedRoot,
		});

		expect(secondA.geminiHome).toBe(firstA.geminiHome);
		expect(fs.existsSync(marker)).toBe(true);
		expect(envB.geminiHome).not.toBe(firstA.geminiHome);
	});
});
