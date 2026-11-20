import type { Provider } from "@earendil-works/pi-ai";

import { AcpSessionStore } from "./acp/session-store.js";
import { DEFAULT_ACCOUNT_ID, resolveAccounts, type ResolvedAccount } from "./accounts.js";
import { loadConfig, type AntigravityAcpConfig } from "./config.js";
import { PACKAGE_VERSION } from "./constants.js";
import { createAntigravityProvider } from "./provider.js";
import { AntigravityRuntime, type AntigravityConnectionFactory } from "./runtime.js";

/** One registered provider and its own runtime. Routing is this pair: Pi keys
 * providers by id and the provider's stream closes over its own runtime. */
export interface SharedAccount {
	account: ResolvedAccount;
	runtime: AntigravityRuntime;
	provider: Provider<"antigravity-acp">;
}

export interface SharedRuntime {
	version: string;
	refs: number;
	accounts: SharedAccount[];
	problems: string[];
	/** Kept so an account added at runtime uses the same spawn seam. */
	connectionFactory?: AntigravityConnectionFactory;
}

// Pi loads every extension instance without a module cache, so the record lives on globalThis.
const KEY = Symbol.for("pi-antigravity-acp:runtime");
const slots = globalThis as unknown as Record<symbol, SharedRuntime | undefined>;

export function acquireSharedRuntime(connectionFactory?: AntigravityConnectionFactory): SharedRuntime {
	let shared = slots[KEY];
	if (shared?.version !== PACKAGE_VERSION) {
		// A different package version never shares; an unreferenced old stack would otherwise leak.
		if (shared && shared.refs === 0) void closeSharedRuntime(shared);
		shared = createSharedRuntime(connectionFactory);
		slots[KEY] = shared;
	}
	shared.refs += 1;
	return shared;
}

function createSharedRuntime(connectionFactory?: AntigravityConnectionFactory): SharedRuntime {
	const config = loadConfig();
	const { accounts, problems } = resolveAccounts(config);
	return {
		version: PACKAGE_VERSION,
		refs: 0,
		problems,
		accounts: accounts.map((account) => buildSharedAccount(account, config, connectionFactory)),
		...(connectionFactory ? { connectionFactory } : {}),
	};
}

function buildSharedAccount(
	account: ResolvedAccount,
	config: AntigravityAcpConfig,
	connectionFactory?: AntigravityConnectionFactory,
): SharedAccount {
	// The default account keeps the runtime's own store, so a test-injected
	// connection factory still runs storeless exactly as before.
	const sessionStore = account.sessionStoreFile
		? new AcpSessionStore(account.sessionStoreFile)
		: undefined;
	const runtime = new AntigravityRuntime(connectionFactory, config.permissions, sessionStore, {
		toolActivityMode: config.toolActivity,
		toolBridgeMode: config.toolBridge,
		isolatedGeminiHome: config.isolatedGeminiHome,
		...(account.env ? { env: account.env } : {}),
	});
	const { provider } = createAntigravityProvider(runtime, {
		providerId: account.providerId,
		name: account.name,
	});
	return { account, runtime, provider };
}

/** Adds a configured account to a live shared stack. The caller registers the
 * returned provider with Pi; config persistence is the caller's responsibility. */
export function addSharedAccount(
	shared: SharedRuntime,
	account: ResolvedAccount,
	config: AntigravityAcpConfig,
): SharedAccount {
	const created = buildSharedAccount(account, config, shared.connectionFactory);
	shared.accounts.push(created);
	return created;
}

/** Detaches an account without closing it, so the caller can unregister its
 * provider and then close its runtime. The ambient account cannot be removed. */
export function removeSharedAccount(shared: SharedRuntime, id: string): SharedAccount | undefined {
	if (id === DEFAULT_ACCOUNT_ID) return undefined;
	const index = shared.accounts.findIndex(({ account }) => account.id === id);
	return index < 0 ? undefined : shared.accounts.splice(index, 1)[0];
}

// Children loaded without extensions stream through the runtime without a ref, so only quit closes it.
export async function releaseSharedRuntime(shared: SharedRuntime, reason: string): Promise<void> {
	shared.refs = Math.max(0, shared.refs - 1);
	if (shared.refs > 0 || reason !== "quit") return;
	if (slots[KEY] === shared) delete slots[KEY];
	await closeSharedRuntime(shared);
}

async function closeSharedRuntime(shared: SharedRuntime): Promise<void> {
	await Promise.all(shared.accounts.map(({ runtime }) => runtime.close()));
}
