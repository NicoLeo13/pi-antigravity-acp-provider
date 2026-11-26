import { createHash, randomUUID } from "node:crypto";

import { inspectAntigravityAuth } from "./acp/antigravity.js";
import { providerAcpDirectory } from "./acp/credential-storage.js";
import { MANAGED_AUTH_MARKER } from "./constants.js";

export function newGoogleLoginMarker(): string {
	return `${MANAGED_AUTH_MARKER}:${randomUUID()}`;
}

export function isGoogleLoginMarker(value: string): boolean {
	return value.startsWith(`${MANAGED_AUTH_MARKER}:`);
}

export function hasSavedGoogleLogin(): boolean {
	return inspectAntigravityAuth(providerAcpDirectory(), {}).status === "oauth-refreshable";
}

export function credentialIdentity(apiKey: string | undefined): string {
	if (!apiKey) return "ambient";
	if (isGoogleLoginMarker(apiKey)) return apiKey;
	return `api-key:${createHash("sha256").update(apiKey).digest("hex")}`;
}
