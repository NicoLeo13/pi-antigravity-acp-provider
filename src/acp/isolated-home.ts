import fs from "node:fs";
import path from "node:path";

import { resolveConfigRoot } from "../config.js";
import { resolveAntigravityAcpDirectory } from "./antigravity.js";

/** Directory links use a junction on Windows, where plain symlinks can require
 * extra privileges, and a directory symlink elsewhere. */
export function isolatedHomeLinkType(platform: NodeJS.Platform = process.platform): "junction" | "dir" {
	return platform === "win32" ? "junction" : "dir";
}

/** Prepares an isolated `GEMINI_HOME` directory that shares only the user's
 * `antigravity-acp` credentials/conversations directory via symlink, keeping
 * `~/.gemini/GEMINI.md`, `skills/`, and `antigravity-cli/` out of ACP turns. */
export function prepareIsolatedGeminiHome(
	baseEnv: NodeJS.ProcessEnv = process.env,
	isolatedRoot = path.join(resolveConfigRoot(), "gemini-home"),
): string {
	const existing = baseEnv.GEMINI_HOME?.trim();
	if (existing) return baseEnv.GEMINI_HOME!;

	const realAcpDir = resolveAntigravityAcpDirectory(baseEnv);
	fs.mkdirSync(realAcpDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(isolatedRoot, { recursive: true, mode: 0o700 });

	const linkPath = path.join(isolatedRoot, "antigravity-acp");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(linkPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		createCredentialLink(realAcpDir, linkPath);
		return isolatedRoot;
	}

	if (!stat.isSymbolicLink()) {
		throw new Error(
			`Cannot isolate GEMINI_HOME: ${linkPath} exists and is not a symbolic link. ` +
			"Isolation cannot proceed because an unrelated directory sits at the credential link path; " +
			"move it away and try again.",
		);
	}
	if (!symlinkResolvesTo(linkPath, realAcpDir)) {
		fs.unlinkSync(linkPath);
		createCredentialLink(realAcpDir, linkPath);
	}
	return isolatedRoot;
}

/** Returns a child environment with `GEMINI_HOME` pointed at an isolated home
 * unless the caller already supplied an explicit `GEMINI_HOME`. */
export function applyIsolatedGeminiEnvironment(
	baseEnv: NodeJS.ProcessEnv = process.env,
	isolatedRoot?: string,
): NodeJS.ProcessEnv {
	if (baseEnv.GEMINI_HOME?.trim()) return baseEnv;
	return {
		...baseEnv,
		GEMINI_HOME: prepareIsolatedGeminiHome(baseEnv, isolatedRoot),
	};
}

function createCredentialLink(realAcpDir: string, linkPath: string): void {
	try {
		fs.symlinkSync(realAcpDir, linkPath, isolatedHomeLinkType());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST" && symlinkResolvesTo(linkPath, realAcpDir)) return;
		throw error;
	}
}

function symlinkResolvesTo(linkPath: string, target: string): boolean {
	try {
		if (!fs.lstatSync(linkPath).isSymbolicLink()) return false;
		return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) === path.resolve(target);
	} catch {
		return false;
	}
}
