import { describe, expect, it } from "vitest";

import { FALLBACK_MODELS, projectModels, resolveAcpModelId, restoreModels, splitEffortSuffix } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";

describe("projectModels", () => {
	it("keeps Flash as the conservative offline default while allowing explicit Argon selection", () => {
		expect(FALLBACK_MODELS[0]?.id).toBe("gemini-3.8-flash");
		expect(FALLBACK_MODELS.some((model) => model.id === "gemini-4-argon")).toBe(true);
	});

	it("lists Carbon offline with the tiers the official ACP server advertises", () => {
		const carbon = FALLBACK_MODELS.find((model) => model.id === "gemini-4-carbon");
		expect(carbon).toMatchObject({
			name: "Gemini 4 Carbon",
			reasoning: true,
			thinkingLevelMap: {
				low: "gemini-4-carbon-low",
				medium: "gemini-4-carbon-medium",
				high: "gemini-4-carbon-high",
				xhigh: null,
			},
		});
		expect(carbon?.cost.input).toBe(2);
	});

	it.each(["low", "medium", "high"])("splits a known %s suffix without truncating the base", (effort) => {
		expect(splitEffortSuffix(`gemini-hyphenated-base-${effort}`)).toEqual({ base: "gemini-hyphenated-base", effort });
	});

	it.each(["gemini-base", "-low", "gemini-base-off", "gemini-base-high-extra"])("does not invent a known effort from %s", (id) => {
		expect(splitEffortSuffix(id)).toBeUndefined();
	});

	it("deduplicates and rejects unsafe ids", () => {
		const models = projectModels([
			{ modelId: "gemini-a", name: "Gemini A" },
			{ modelId: "gemini-a", name: "duplicate" },
			{ modelId: "bad\nmodel", name: "bad" },
		]);
		expect(models.map((model) => model.id)).toEqual(["gemini-a"]);
		expect(models[0]?.cost.input).toBe(0);
	});

	it("collapses ACP effort variants into Pi reasoning levels", () => {
		const models = projectModels([
			{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
			{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
			{ modelId: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
			{ modelId: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
		]);

		expect(models.map((model) => model.id)).toEqual(["gemini-3.8-flash", "gemini-3.1-pro"]);
		expect(models[0]?.thinkingLevelMap?.off).toBeNull();
		expect(models[0]?.thinkingLevelMap?.medium).toBe("gemini-3.8-flash-medium");
		expect(resolveAcpModelId(models[0]!, "low")).toBe("gemini-3.8-flash-low");
		expect(resolveAcpModelId(models[0]!, "high")).toBe("gemini-3.8-flash-high");
		expect(models[1]?.thinkingLevelMap?.medium).toBeNull();
		expect(resolveAcpModelId(models[1]!, "medium")).toBe("gemini-pro-agent");
	});

	it.each(["low", "medium", "high"] as const)("retains the only advertised %s reasoning tier without inventing variants", (effort) => {
		const id = `gemini-4-argon-${effort}`;
		const models = projectModels([{ modelId: id, name: `Gemini 4 Argon (${effort})` }]);
		expect(models).toHaveLength(1);
		expect(models[0]?.id).toBe(id);
		expect(models[0]?.reasoning).toBe(true);
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
			expect(models[0]?.thinkingLevelMap?.[level]).toBe(level === effort ? id : null);
			// Unsupported programmatic levels still select the advertised ID.
			expect(resolveAcpModelId(models[0]!, level === "off" ? undefined : level)).toBe(id);
		}
		expect(resolveAcpModelId(models[0]!, undefined)).toBe(id);
	});

	it("exposes additional Argon tiers only when the server advertises them", () => {
		const models = projectModels([
			{ modelId: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
			{ modelId: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
		]);
		expect(models.map((model) => model.id)).toEqual(["gemini-4-argon"]);
		expect(models[0]?.thinkingLevelMap?.low).toBeNull();
		expect(resolveAcpModelId(models[0]!, "medium")).toBe("gemini-4-argon-medium");
		expect(resolveAcpModelId(models[0]!, "high")).toBe("gemini-4-argon-high");
	});

	it("does not infer reasoning for a model without an advertised effort", () => {
		const models = projectModels([{ modelId: "gemini-unknown", name: "Gemini Unknown" }]);
		expect(models[0]?.reasoning).toBe(false);
		expect(models[0]?.thinkingLevelMap).toBeUndefined();
	});

	it("registers separate Google-account and API-key login methods", async () => {
		const { provider, runtime } = createAntigravityProvider();
		try {
			expect(provider.auth.oauth?.loginLabel).toBe("Sign in with Google");
			expect(provider.auth.apiKey?.name).toBe("Antigravity Gemini API key");
		} finally {
			await runtime.close();
		}
	});
});

describe("restoreModels", () => {
	const discovered = projectModels([
		{ modelId: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
		{ modelId: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
		{ modelId: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
		{ modelId: "gemini-next-preview", name: "Gemini Next Preview" },
	]);

	it("round-trips a discovered catalog through JSON persistence", () => {
		const restored = restoreModels(JSON.parse(JSON.stringify(discovered)) as unknown[]);
		expect(restored).toEqual(discovered);
		expect(resolveAcpModelId(restored[0]!, "high")).toBe("gemini-4-carbon-high");
		expect(restored[1]).toMatchObject({ id: "gemini-next-preview", reasoning: false });
	});

	it("rebuilds entries with current rates and limits instead of trusting stored values", () => {
		const stale = { ...discovered[0]!, cost: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99 }, contextWindow: 1 };
		const [restored] = restoreModels([stale]);
		expect(restored?.cost).toEqual(discovered[0]!.cost);
		expect(restored?.contextWindow).toBe(discovered[0]!.contextWindow);
	});

	it("skips foreign, malformed, duplicate and tierless entries", () => {
		const carbon = discovered[0]!;
		const restored = restoreModels([
			null,
			"gemini-4-carbon",
			{ ...carbon, provider: "google" },
			{ ...carbon, api: "openai-completions" },
			{ ...carbon, id: "bad\nmodel" },
			{ ...carbon, id: 42 },
			{ ...carbon, reasoning: undefined },
			{ ...carbon, id: "gemini-tierless", thinkingLevelMap: { low: null, medium: null, high: null } },
			{ ...carbon, id: "gemini-unsafe-tier", thinkingLevelMap: { low: "bad\ntier" } },
			carbon,
			{ ...carbon, name: "duplicate" },
		]);
		expect(restored).toEqual([carbon]);
	});
});
