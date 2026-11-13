import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveConfigRoot } from "../config.js";
import { resolveAntigravityAcpDirectory } from "./antigravity.js";

const TOKEN_FILES = ["acp_token.json", "acp_business_token.json"] as const;
const ALLOWED_SETTINGS_KEYS = ["auth", "gcp", "telemetry"] as const;

export interface IsolatedAcpEnvironmentOptions {
	realCwd: string;
	sourceEnv?: NodeJS.ProcessEnv;
	isolatedRoot?: string;
}

export interface IsolatedAcpEnvironment {
	geminiHome: string;
	acpDir: string;
	workspaceDir: string;
	env: NodeJS.ProcessEnv;
}

/** Isolates Antigravity's GEMINI_HOME and workspace cwd away from user-global
 * MCP configs, hooks, and skills while syncing credentials and sanitized settings. */
export function prepareIsolatedAcpEnvironment(
	options: IsolatedAcpEnvironmentOptions,
): IsolatedAcpEnvironment {
	const sourceEnv = options.sourceEnv ?? process.env;
	const sourceAcpDir = resolveAntigravityAcpDirectory(sourceEnv);
	const root = options.isolatedRoot ?? path.join(resolveConfigRoot(), "host-acp");
	const key = createHash("sha256")
		.update(JSON.stringify([path.resolve(sourceAcpDir), path.resolve(options.realCwd)]))
		.digest("hex");
	const geminiHome = path.join(root, key);
	const acpDir = path.join(geminiHome, "antigravity-acp");
	const workspaceDir = path.join(geminiHome, "workspace");

	fs.mkdirSync(geminiHome, { recursive: true, mode: 0o700 });
	fs.mkdirSync(acpDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(acpDir, "conversations"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

	for (const name of TOKEN_FILES) {
		syncTokenFile(path.join(sourceAcpDir, name), path.join(acpDir, name));
	}
	syncSanitizedSettings(path.join(sourceAcpDir, "settings.json"), path.join(acpDir, "settings.json"));

	return {
		geminiHome,
		acpDir,
		workspaceDir,
		env: { ...sourceEnv, GEMINI_HOME: geminiHome },
	};
}

function syncTokenFile(sourcePath: string, targetPath: string): void {
	let content: string;
	try {
		content = fs.readFileSync(sourcePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			fs.rmSync(targetPath, { force: true });
			return;
		}
		throw error;
	}
	atomicWriteSecret(targetPath, content);
}

function syncSanitizedSettings(sourcePath: string, targetPath: string): void {
	let raw: string;
	try {
		raw = fs.readFileSync(sourcePath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			fs.rmSync(targetPath, { force: true });
			return;
		}
		throw error;
	}
	const sanitized = sanitizeSettings(raw);
	if (sanitized === undefined) {
		fs.rmSync(targetPath, { force: true });
		return;
	}
	atomicWriteSecret(targetPath, `${JSON.stringify(sanitized, null, 2)}\n`);
}

function sanitizeSettings(raw: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		const source = parsed as Record<string, unknown>;
		const output: Record<string, unknown> = {};
		for (const key of ALLOWED_SETTINGS_KEYS) {
			if (Object.hasOwn(source, key) && source[key] !== undefined) {
				output[key] = source[key];
			}
		}
		return output;
	} catch {
		return undefined;
	}
}

function atomicWriteSecret(targetPath: string, content: string): void {
	const temporary = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
	try {
		fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		fs.renameSync(temporary, targetPath);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}
