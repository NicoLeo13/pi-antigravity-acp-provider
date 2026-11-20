import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	applyIsolatedGeminiEnvironment,
	isolatedHomeLinkType,
	prepareIsolatedGeminiHome,
} from "../src/acp/isolated-home.js";
import { AntigravityRuntime } from "../src/runtime.js";

const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "agy-iso-home-"));
	const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agy-iso-root-"));
	roots.push(fakeHome, isolatedRoot);
	const realGemini = path.join(fakeHome, ".gemini");
	const realAcp = path.join(realGemini, "antigravity-acp");
	fs.mkdirSync(realAcp, { recursive: true });
	fs.writeFileSync(path.join(realGemini, "GEMINI.md"), "# gentle-ai global rules\n");
	fs.mkdirSync(path.join(realGemini, "skills"), { recursive: true });
	fs.mkdirSync(path.join(realGemini, "antigravity-cli"), { recursive: true });
	fs.writeFileSync(path.join(realAcp, "acp_token.json"), "{\"refresh_token\":\"ok\"}\n");
	return { fakeHome, isolatedRoot, realGemini, realAcp };
}

describe("isolated GEMINI_HOME", () => {
	it("links only antigravity-acp into a fresh isolated root", () => {
		const { fakeHome, isolatedRoot, realAcp } = fixture();

		const env = applyIsolatedGeminiEnvironment({ HOME: fakeHome }, isolatedRoot);

		expect(env.GEMINI_HOME).toBe(isolatedRoot);
		expect(env.HOME).toBe(fakeHome);
		const linkPath = path.join(isolatedRoot, "antigravity-acp");
		expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
		expect(fs.readlinkSync(linkPath)).toBe(realAcp);
		expect(fs.existsSync(path.join(linkPath, "acp_token.json"))).toBe(true);
		expect(fs.existsSync(path.join(isolatedRoot, "GEMINI.md"))).toBe(false);
		expect(fs.existsSync(path.join(isolatedRoot, "skills"))).toBe(false);
		expect(fs.existsSync(path.join(isolatedRoot, "antigravity-cli"))).toBe(false);

		// Re-running is idempotent and keeps the same link.
		expect(prepareIsolatedGeminiHome({ HOME: fakeHome }, isolatedRoot)).toBe(isolatedRoot);
		expect(fs.readlinkSync(linkPath)).toBe(realAcp);
	});

	it("refuses an unrelated directory at the credential link path without touching it", () => {
		const { fakeHome, isolatedRoot } = fixture();
		const linkPath = path.join(isolatedRoot, "antigravity-acp");
		fs.mkdirSync(linkPath, { recursive: true });
		fs.writeFileSync(path.join(linkPath, "unrelated.txt"), "keep me\n");

		expect(() => prepareIsolatedGeminiHome({ HOME: fakeHome }, isolatedRoot)).toThrow(linkPath);
		expect(() => prepareIsolatedGeminiHome({ HOME: fakeHome }, isolatedRoot)).toThrow(/unrelated directory/);
		expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
		expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(path.join(linkPath, "unrelated.txt"), "utf8")).toBe("keep me\n");
	});

	it("replaces an existing symlink that points elsewhere", () => {
		const { fakeHome, isolatedRoot, realAcp } = fixture();
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "agy-iso-elsewhere-"));
		roots.push(elsewhere);
		const linkPath = path.join(isolatedRoot, "antigravity-acp");
		fs.symlinkSync(elsewhere, linkPath, isolatedHomeLinkType());

		expect(prepareIsolatedGeminiHome({ HOME: fakeHome }, isolatedRoot)).toBe(isolatedRoot);
		expect(fs.readlinkSync(linkPath)).toBe(realAcp);
		expect(fs.existsSync(elsewhere)).toBe(true);
	});

	it("accepts a concurrent EEXIST creator that resolves to the real directory", () => {
		const { fakeHome, isolatedRoot, realAcp } = fixture();
		const linkPath = path.join(isolatedRoot, "antigravity-acp");
		const original = fs.symlinkSync;
		const race = vi.spyOn(fs, "symlinkSync").mockImplementation((target, pathName, type) => {
			original(target, pathName, type);
			throw Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
		});
		try {
			expect(prepareIsolatedGeminiHome({ HOME: fakeHome }, isolatedRoot)).toBe(isolatedRoot);
			expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
			expect(fs.readlinkSync(linkPath)).toBe(realAcp);
		} finally {
			race.mockRestore();
		}
	});

	it("rethrows EEXIST when the existing path does not resolve to the real directory", () => {
		const { fakeHome, isolatedRoot } = fixture();
		const linkPath = path.join(isolatedRoot, "antigravity-acp");
		const failure = Object.assign(new Error("EEXIST: file already exists"), { code: "EEXIST" });
		const link = vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
			fs.mkdirSync(linkPath, { recursive: true });
			throw failure;
		});
		try {
			expect(() => prepareIsolatedGeminiHome({ HOME: fakeHome }, isolatedRoot)).toThrow(failure);
		} finally {
			link.mockRestore();
		}
	});

	it("rethrows unrelated link errors unchanged", () => {
		const { fakeHome, isolatedRoot } = fixture();
		const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const link = vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
			throw failure;
		});
		try {
			expect(() => prepareIsolatedGeminiHome({ HOME: fakeHome }, isolatedRoot)).toThrow(failure);
		} finally {
			link.mockRestore();
		}
	});

	it("passes an explicit directory/junction link type to symlinkSync", () => {
		const { fakeHome, isolatedRoot, realAcp } = fixture();
		const linkPath = path.join(isolatedRoot, "antigravity-acp");
		const link = vi.spyOn(fs, "symlinkSync");
		prepareIsolatedGeminiHome({ HOME: fakeHome }, isolatedRoot);
		expect(link).toHaveBeenCalledWith(realAcp, linkPath, isolatedHomeLinkType());
		expect(isolatedHomeLinkType("win32")).toBe("junction");
		expect(isolatedHomeLinkType("linux")).toBe("dir");
		expect(isolatedHomeLinkType("darwin")).toBe("dir");
	});

	it("preserves an explicit GEMINI_HOME override without isolating", () => {
		const { fakeHome, isolatedRoot, realAcp } = fixture();
		const explicit = path.join(fakeHome, "explicit-gemini-home");

		expect(prepareIsolatedGeminiHome({ GEMINI_HOME: explicit, HOME: fakeHome }, isolatedRoot)).toBe(explicit);
		expect(fs.existsSync(path.join(isolatedRoot, "antigravity-acp"))).toBe(false);
		expect(fs.existsSync(path.join(realAcp, "acp_token.json"))).toBe(true);
		const baseEnv = { GEMINI_HOME: explicit, HOME: fakeHome };
		expect(applyIsolatedGeminiEnvironment(baseEnv, isolatedRoot)).toBe(baseEnv);
	});

	it("exposes credentials to a spawned child while hiding GEMINI.md and skills", () => {
		const { fakeHome, isolatedRoot } = fixture();
		const env = applyIsolatedGeminiEnvironment({ HOME: fakeHome, PATH: process.env.PATH }, isolatedRoot);
		const probe = execFileSync(
			process.execPath,
			[
				"-e",
				[
					"const fs = require('node:fs');",
					"const path = require('node:path');",
					"const gh = process.env.GEMINI_HOME;",
					"console.log(JSON.stringify({",
					"  geminiHome: gh,",
					"  token: JSON.parse(fs.readFileSync(path.join(gh, 'antigravity-acp', 'acp_token.json'), 'utf8')).refresh_token,",
					"  hasGeminiMd: fs.existsSync(path.join(gh, 'GEMINI.md')),",
					"  hasSkills: fs.existsSync(path.join(gh, 'skills')),",
					"}));",
				].join("\n"),
			],
			{ env, encoding: "utf8" },
		);
		expect(JSON.parse(probe)).toEqual({
			geminiHome: isolatedRoot,
			token: "ok",
			hasGeminiMd: false,
			hasSkills: false,
		});
	});

	it("defaults AntigravityRuntime isolatedGeminiHome to false and updates via setter", async () => {
		const runtime = new AntigravityRuntime(() => {
			throw new Error("unused");
		});
		try {
			expect((await runtime.snapshot()).isolatedGeminiHome).toBe(false);
			runtime.setIsolatedGeminiHome(true);
			expect((await runtime.snapshot()).isolatedGeminiHome).toBe(true);
		} finally {
			await runtime.close();
		}
	});
});
