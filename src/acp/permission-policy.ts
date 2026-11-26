import type { PermissionMode } from "../config.js";
import { sessionModes, type SessionState } from "./session-state.js";

export function permissionModeId(state: SessionState, policy: PermissionMode): string | undefined {
	const advertised = sessionModes(state)?.availableModes ?? [];
	const candidates = policy === "auto_edit" ? ["auto_edit", "accept-edits"] : [policy];
	return candidates.find((id) => advertised.some((mode) => mode.id === id));
}

export function confirmsPermissionMode(state: SessionState, policy: PermissionMode, modeId: string): boolean {
	return permissionModeId(state, policy) === modeId && sessionModes(state)?.currentModeId === modeId;
}

export function unsupportedPermissionMode(state: SessionState, policy: PermissionMode): string {
	const advertised = sessionModes(state)?.availableModes ?? [];
	const supported = advertised.slice(0, 12).map((mode) => mode.id.replace(/[\s\x00-\x1f\x7f]/gu, " ").slice(0, 80)).join(", ") || "none";
	const guidance = advertised.some((mode) => mode.id === "default")
		? " Select /antigravity-acp permissions default to explicitly request confirmation prompts."
		: " Use a runtime that advertises the requested policy.";
	return `did not advertise permission mode '${policy}'; refusing to prompt. Advertised modes: ${supported}.${guidance}`;
}
