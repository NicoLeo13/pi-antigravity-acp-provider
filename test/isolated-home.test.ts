import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyIsolatedGeminiEnvironment, prepareIsolatedGeminiHome } from "../src/acp/isolated-home.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("isolated GEMINI_HOME", () => {
	it("symlinks antigravity-acp without copying GEMINI.md or skills into the isolated root", () => {
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-iso-home-"));
		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-iso-root-"));
		roots.push(fakeHome, isolatedRoot);

		const realGemini = path.join(fakeHome, ".gemini");
		const realAcp = path.join(realGemini, "antigravity-acp");
		fs.mkdirSync(realAcp, { recursive: true });
		fs.writeFileSync(path.join(realGemini, "GEMINI.md"), "# gentle-ai global rules\n");
		fs.writeFileSync(path.join(realAcp, "acp_token.json"), "{\"refresh_token\":\"ok\"}\n");

		const env = applyIsolatedGeminiEnvironment({ HOME: fakeHome }, isolatedRoot);
		expect(env.GEMINI_HOME).toBe(isolatedRoot);
		expect(fs.existsSync(path.join(isolatedRoot, "GEMINI.md"))).toBe(false);
		const linkPath = path.join(isolatedRoot, "antigravity-acp");
		expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(linkPath)).toBe(realAcp);
		expect(fs.existsSync(path.join(linkPath, "acp_token.json"))).toBe(true);
	});

	it("preserves an explicit GEMINI_HOME override", () => {
		const explicit = "/tmp/explicit-gemini-home";
		expect(prepareIsolatedGeminiHome({ GEMINI_HOME: explicit })).toBe(explicit);
		expect(applyIsolatedGeminiEnvironment({ GEMINI_HOME: explicit }).GEMINI_HOME).toBe(explicit);
	});
});
