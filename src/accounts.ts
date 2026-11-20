import os from "node:os";
import path from "node:path";

import {
	loadConfig,
	resolveConfigRoot,
	type AntigravityAccountConfig,
	type AntigravityAcpConfig,
} from "./config.js";

/** The implicit account. It keeps the ambient environment and the historical
 * provider id, so existing users see no change. */
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_PROVIDER_ID = "antigravity-acp";
export const DEFAULT_ACCOUNT_NAME = "Google Antigravity (ACP)";

export interface ResolvedAccount {
	/** `default` for the ambient account, otherwise the configured slug. */
	id: string;
	/** Pi provider id; unique per account, which is what routes a request. */
	providerId: string;
	/** Picker label; must identify the account. */
	name: string;
	/** Undefined for the default account, which inherits the ambient environment. */
	env?: NodeJS.ProcessEnv;
	/** Undefined for the default account, which keeps the runtime's own store
	 * so a test-injected connection factory still runs storeless. */
	sessionStoreFile?: string;
}

export interface AccountResolution {
	accounts: ResolvedAccount[];
	/** Configuration that was rejected, for a visible warning instead of a
	 * silently missing provider. */
	problems: string[];
}

/** Resolves the implicit default account plus every configured account, in
 * config order. Rejected entries are dropped and described in `problems`. */
export function resolveAccounts(config: AntigravityAcpConfig = loadConfig()): AccountResolution {
	const accounts: ResolvedAccount[] = [
		{
			id: DEFAULT_ACCOUNT_ID,
			providerId: DEFAULT_PROVIDER_ID,
			name: DEFAULT_ACCOUNT_NAME,
		},
	];
	const problems: string[] = [];
	const ids = new Set<string>([DEFAULT_ACCOUNT_ID]);
	const labels = new Set<string>();
	const homes = new Map<string, string>();

	for (const entry of config.accounts) {
		const problem = accountProblem(entry, ids, labels, homes);
		if (problem) {
			problems.push(problem);
			continue;
		}
		const home = expandHome(entry.geminiHome);
		const label = entry.label?.trim() || entry.id;
		ids.add(entry.id);
		labels.add(label);
		homes.set(home, entry.id);
		accounts.push({
			id: entry.id,
			providerId: accountProviderId(entry.id),
			name: `${DEFAULT_ACCOUNT_NAME} — ${label}`,
			// The account is isolated by GEMINI_HOME, which is what the managed
			// server reads for tokens, settings and quota.
			env: { ...process.env, GEMINI_HOME: home },
			sessionStoreFile: path.join(resolveConfigRoot(), "sessions", `${entry.id}.json`),
		});
	}

	return { accounts, problems };
}

/** `antigravity-acp` for the default account, `antigravity-acp-<id>` otherwise. */
export function accountProviderId(id: string): string {
	return id === DEFAULT_ACCOUNT_ID ? DEFAULT_PROVIDER_ID : `${DEFAULT_PROVIDER_ID}-${id}`;
}

function accountProblem(
	entry: AntigravityAccountConfig,
	ids: Set<string>,
	labels: Set<string>,
	homes: Map<string, string>,
): string | undefined {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
		return `account "${entry.id}" needs a lowercase slug id (a-z, 0-9, dashes)`;
	}
	if (entry.id === DEFAULT_ACCOUNT_ID) {
		return `account id "default" is reserved for the ambient account`;
	}
	if (ids.has(entry.id)) return `account "${entry.id}" is declared twice`;
	// The label is what the picker shows and what an explicit argument may
	// match, so two identical labels would make selection ambiguous.
	const label = entry.label?.trim() || entry.id;
	if (labels.has(label)) return `account label "${label}" is used twice`;
	const home = expandHome(entry.geminiHome);
	if (!path.isAbsolute(home)) {
		return `account "${entry.id}" needs an absolute geminiHome (got "${entry.geminiHome}")`;
	}
	const owner = homes.get(home);
	if (owner) return `accounts "${owner}" and "${entry.id}" share the geminiHome "${home}"`;
	return undefined;
}

function expandHome(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "~") return os.homedir();
	return trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
}
