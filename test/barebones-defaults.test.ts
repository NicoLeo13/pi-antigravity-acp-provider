import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, resolveConfigPath } from "../src/config.js";

const directories: string[] = [];
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalPiCodingAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
	}
	for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("barebones ACP defaults", () => {
	it("isolates GEMINI_HOME and bridges only ecosystem tools by default", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "barebones-home-"));
		directories.push(fakeHome);
		vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "barebones-agent-"));
		directories.push(agentDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;

		expect(loadConfig()).toMatchObject({ isolatedGeminiHome: true, toolBridge: "ecosystem" });

		const configPath = resolveConfigPath();
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
		fs.writeFileSync(configPath, JSON.stringify({ isolatedGeminiHome: false, toolBridge: "all" }));
		expect(loadConfig()).toMatchObject({ isolatedGeminiHome: false, toolBridge: "all" });
	});
});
