import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	accountProviderId,
	DEFAULT_ACCOUNT_ID,
	DEFAULT_ACCOUNT_NAME,
	DEFAULT_PROVIDER_ID,
	resolveAccounts,
} from "../src/accounts.js";
import { loadConfig, saveAccounts, savePermissionMode, type AntigravityAcpConfig } from "../src/config.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function config(accounts: AntigravityAcpConfig["accounts"] = []): AntigravityAcpConfig {
	return {
		permissions: "default",
		runtimeUpdates: "notify",
		toolActivity: "compact",
		toolBridge: "ecosystem",
		isolatedGeminiHome: true,
		accounts,
	};
}

describe("account resolution", () => {
	it("keeps the ambient account unchanged when no accounts are configured", () => {
		const resolved = resolveAccounts(config());
		expect(resolved.problems).toEqual([]);
		expect(resolved.accounts).toEqual([
			{
				id: DEFAULT_ACCOUNT_ID,
				providerId: DEFAULT_PROVIDER_ID,
				name: DEFAULT_ACCOUNT_NAME,
			},
		]);
	});

	it("gives each configured account its own provider id, env and session store", () => {
		const resolved = resolveAccounts(config([
			{ id: "work", label: "Work", geminiHome: "/tmp/agy-work" },
			{ id: "personal", geminiHome: "/tmp/agy-personal" },
		]));
		expect(resolved.problems).toEqual([]);
		expect(resolved.accounts.map((account) => account.id)).toEqual(["default", "work", "personal"]);
		expect(resolved.accounts.map((account) => account.providerId)).toEqual([
			"antigravity-acp",
			"antigravity-acp-work",
			"antigravity-acp-personal",
		]);
		expect(resolved.accounts[1]?.name).toBe("Google Antigravity (ACP) — Work");
		expect(resolved.accounts[2]?.name).toBe("Google Antigravity (ACP) — personal");
		expect(resolved.accounts[1]?.env?.GEMINI_HOME).toBe("/tmp/agy-work");
		expect(resolved.accounts[2]?.env?.GEMINI_HOME).toBe("/tmp/agy-personal");
		// The ambient account keeps the ambient env and the historical store path.
		expect(resolved.accounts[0]?.env).toBeUndefined();
		expect(resolved.accounts[0]?.sessionStoreFile).toBeUndefined();
		expect(resolved.accounts[1]?.sessionStoreFile).toMatch(/sessions[\\/]work\.json$/);
		expect(resolved.accounts[2]?.sessionStoreFile).toMatch(/sessions[\\/]personal\.json$/);
	});

	it("expands a ~ home and keeps every other ambient env value", () => {
		const resolved = resolveAccounts(config([{ id: "work", geminiHome: "~/agy-work" }]));
		expect(resolved.accounts[1]?.env?.GEMINI_HOME).toBe(path.join(os.homedir(), "agy-work"));
		expect(resolved.accounts[1]?.env?.PATH).toBe(process.env.PATH);
		expect(accountProviderId("default")).toBe(DEFAULT_PROVIDER_ID);
	});

	it("reports invalid accounts instead of dropping them silently", () => {
		const resolved = resolveAccounts(config([
			{ id: "default", geminiHome: "/tmp/one" },
			{ id: "Bad Id", geminiHome: "/tmp/two" },
			{ id: "relative", geminiHome: "relative/path" },
			{ id: "valid", geminiHome: "/tmp/valid" },
			{ id: "valid", geminiHome: "/tmp/again" },
			{ id: "clone", geminiHome: "/tmp/valid" },
		]));
		expect(resolved.accounts.map((account) => account.id)).toEqual(["default", "valid"]);
		expect(resolved.problems).toHaveLength(5);
		expect(resolved.problems.some((problem) => problem.includes('"default" is reserved'))).toBe(true);
		expect(resolved.problems.some((problem) => problem.includes("declared twice"))).toBe(true);
		expect(resolved.problems.some((problem) => problem.includes("absolute geminiHome"))).toBe(true);
		expect(resolved.problems.some((problem) => problem.includes("share the geminiHome"))).toBe(true);
	});
});

describe("account configuration", () => {
	it("loads accounts and keeps them when another setting is saved", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-accounts-config-"));
		roots.push(root);
		const file = path.join(root, "config.json");
		fs.writeFileSync(file, JSON.stringify({
			accounts: [
				{ id: "work", label: "Work", geminiHome: "/tmp/work" },
				{ id: "", geminiHome: "/tmp/invalid" },
				{ id: "broken" },
				"junk",
			],
		}), { mode: 0o600 });

		expect(loadConfig(file).accounts).toEqual([
			{ id: "work", label: "Work", geminiHome: "/tmp/work" },
			{ id: "", geminiHome: "/tmp/invalid" },
		]);
		savePermissionMode("default", file);
		expect(loadConfig(file)).toMatchObject({
			permissions: "default",
			accounts: [
				{ id: "work", label: "Work", geminiHome: "/tmp/work" },
				{ id: "", geminiHome: "/tmp/invalid" },
			],
		});
	});

	it("saves accounts without losing the other settings", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-accounts-save-"));
		roots.push(root);
		const file = path.join(root, "config.json");
		fs.writeFileSync(file, JSON.stringify({
			permissions: "default",
			runtimeUpdates: "notify",
			toolActivity: "off",
			toolBridge: "all",
			isolatedGeminiHome: false,
		}), { mode: 0o600 });

		saveAccounts([{ id: "work", label: "Work", geminiHome: "/tmp/work" }], file);
		expect(loadConfig(file)).toEqual({
			permissions: "default",
			runtimeUpdates: "notify",
			toolActivity: "off",
			toolBridge: "all",
			isolatedGeminiHome: false,
			accounts: [{ id: "work", label: "Work", geminiHome: "/tmp/work" }],
		});
	});

	it("defaults to no accounts for a missing or malformed file", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-accounts-empty-"));
		roots.push(root);
		const file = path.join(root, "config.json");
		expect(loadConfig(file).accounts).toEqual([]);
		fs.writeFileSync(file, "{not json", { mode: 0o600 });
		expect(loadConfig(file).accounts).toEqual([]);
	});
});
