import { describe, expect, it } from "vitest";

import { fallbackModels, projectModels, PROVIDER_ID } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";

const WORK = "antigravity-acp-work";

describe("per-account providers", () => {
	it("keeps the default provider id, name and model provider", () => {
		const { provider } = createAntigravityProvider();
		expect(provider.id).toBe(PROVIDER_ID);
		expect(provider.name).toBe("Google Antigravity (ACP)");
		expect(provider.getModels().length).toBeGreaterThan(0);
		for (const model of provider.getModels()) expect(model.provider).toBe(PROVIDER_ID);
	});

	it("gives another account its own provider id, name and model provider", () => {
		const { provider } = createAntigravityProvider(undefined, {
			providerId: WORK,
			name: "Google Antigravity (ACP) — work",
		});
		expect(provider.id).toBe(WORK);
		expect(provider.name).toBe("Google Antigravity (ACP) — work");
		expect(provider.getModels().length).toBeGreaterThan(0);
		for (const model of provider.getModels()) {
			expect(model.provider).toBe(WORK);
			// The wire protocol is the same for every account; only the provider differs.
			expect(model.api).toBe(PROVIDER_ID);
		}
	});

	it("builds the offline catalog for a given provider without changing model ids", () => {
		const models = fallbackModels(WORK);
		expect(models.map((model) => model.id)).toEqual(fallbackModels().map((model) => model.id));
		expect(models.every((model) => model.provider === WORK)).toBe(true);
	});

	it("projects discovered models onto the account's provider id", () => {
		const models = projectModels(
			[
				{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (low)" },
				{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (high)" },
			],
			WORK,
		);
		expect(models).toHaveLength(1);
		expect(models[0]?.id).toBe("gemini-3.8-flash");
		expect(models[0]?.provider).toBe(WORK);
		expect(models[0]?.thinkingLevelMap?.low).toBe("gemini-3.8-flash-low");
		expect(models[0]?.thinkingLevelMap?.high).toBe("gemini-3.8-flash-high");
	});
});
