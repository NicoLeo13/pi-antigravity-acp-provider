import { AntigravityAcpError, AcpOperationTimeoutError, errorMessage } from "./errors.js";

export function runtimeSetupError(cause: unknown, release: { platform: string; version: string }): AntigravityAcpError {
	const intelInitializeHang = release.platform === "darwin-x86_64" &&
		cause instanceof AcpOperationTimeoutError && cause.operation === "initialize";
	const guidance = intelInitializeHang
		? `The Intel macOS standalone ACP ${release.version} initialize timeout matches a known upstream Hardened Runtime/libffi startup hang ` +
			"(https://github.com/google-antigravity/antigravity-cli/issues/1393). " +
			"The SyntaxWarning about invalid escape sequences is not the cause of that hang. " +
			"Longer timeouts or repeated downloads will not repair an affected binary. " +
			"Use the official agy CLI directly while awaiting a corrected standalone build. " +
			"Advanced users can explicitly select an agy acp wrapper with AGY_ACP_BIN and permissions default, " +
			"but host CLI authentication, quota, and session behavior are not fully supported by this provider. " +
			"See the README Intel macOS setup caveat. This provider does not remove or replace code signatures."
		: "Set AGY_ACP_BIN to a trusted manual installation if needed.";
	return new AntigravityAcpError("spawn", `Google Antigravity ACP setup failed: ${errorMessage(cause)}. ${guidance}`, { cause });
}
