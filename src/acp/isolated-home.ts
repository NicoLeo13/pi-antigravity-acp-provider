import fs from "node:fs";
import path from "node:path";

import { resolveConfigRoot } from "../config.js";
import { resolveAntigravityAcpDirectory } from "./antigravity.js";

/** Prepares an isolated `GEMINI_HOME` directory that shares only the user's
 * `antigravity-acp` credentials/conversations directory via symlink, keeping
 * `~/.gemini/GEMINI.md`, `skills/`, and `antigravity-cli/` out of ACP turns. */
export function prepareIsolatedGeminiHome(
	baseEnv: NodeJS.ProcessEnv = process.env,
	isolatedRoot = path.join(resolveConfigRoot(), "gemini-home"),
): string {
	const existing = baseEnv.GEMINI_HOME?.trim();
	if (existing) return existing;

	const realAcpDir = resolveAntigravityAcpDirectory(baseEnv);
	fs.mkdirSync(realAcpDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(isolatedRoot, { recursive: true, mode: 0o700 });

	const linkPath = path.join(isolatedRoot, "antigravity-acp");
	try {
		const stat = fs.lstatSync(linkPath);
		if (stat.isSymbolicLink() && fs.readlinkSync(linkPath) !== realAcpDir) {
			fs.unlinkSync(linkPath);
			fs.symlinkSync(realAcpDir, linkPath);
		}
	} catch {
		fs.symlinkSync(realAcpDir, linkPath);
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
