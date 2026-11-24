import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { errorMessage } from "./acp/errors.js";
import { ensureAntigravityAcpReady, inspectRuntimeSetup } from "./acp/setup.js";
import { savePermissionMode, type PermissionMode } from "./config.js";
import { PROVIDER_ID } from "./models.js";
import type { AntigravityRuntime } from "./runtime.js";

export async function runSetupWizard(
	{ ui, modelRegistry }: ExtensionCommandContext,
	runtime: AntigravityRuntime,
): Promise<void> {
	ui.notify("Checking Antigravity ACP runtime…", "info");
	await ensureAntigravityAcpReady((message) => ui.notify(message, "info"));
	const setup = inspectRuntimeSetup();
	const apiKey = await modelRegistry.getApiKeyForProvider(PROVIDER_ID).catch(() => undefined);
	if (!apiKey) {
		ui.notify(
			`Runtime ${setup.installedVersion ?? setup.approvedVersion} ready. Run /login antigravity-acp to sign in before validating it.`,
			"warning",
		);
		return;
	}

	const selectedMode = await ui.select("Default Antigravity permission mode", [
		"yolo — run commands and edits without confirmation",
		"auto-edit — allow edits; ask for commands",
		"default — ask before sensitive operations",
	]);
	if (selectedMode) {
		const mode = selectedMode.startsWith("auto-edit")
			? "auto_edit"
			: (selectedMode.split(" ", 1)[0] as PermissionMode);
		await runtime.setPermissionMode(mode);
		savePermissionMode(mode);
	}

	ui.notify("Validating authentication and discovering models…", "info");
	let modelCount: number;
	try {
		modelCount = (await runtime.discoverModels(apiKey)).length;
	} catch (error) {
		ui.notify(`Antigravity authentication probe failed: ${errorMessage(error)}`, "error");
		return;
	}
	const runtimeStatus = await runtime.snapshot();
	ui.notify(
		[
			"Antigravity ACP setup complete.",
			`Runtime: ${setup.installedVersion ?? setup.approvedVersion} (${setup.platform})`,
			"Authentication: valid",
			`Models discovered: ${modelCount}`,
			`Permission mode: ${runtimeStatus.permissionMode.replace("_", "-")}.`,
		].join("\n"),
		"info",
	);
}
