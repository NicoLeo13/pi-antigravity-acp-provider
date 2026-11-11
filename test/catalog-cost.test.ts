import { describe, expect, it } from "vitest";

import { FALLBACK_MODELS, costRatesFor, projectModels } from "../src/models.js";
import { usageFromPrompt } from "../src/stream/usage.js";

describe("costRatesFor", () => {
	it("matches models.dev catalog rates for the flash family, including effort-qualified ids", () => {
		expect(costRatesFor("gemini-3.8-flash")).toEqual({ input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
		expect(costRatesFor("gemini-3.8-flash-high")).toEqual(costRatesFor("gemini-3.8-flash"));
		expect(costRatesFor("gemini-3.7-flash-low")).toEqual(costRatesFor("gemini-3.6-flash"));
	});

	it("rates Argon at its catalog prices", () => {
		expect(costRatesFor("gemini-4-argon")).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
		expect(costRatesFor("gemini-4-argon-medium")).toEqual(costRatesFor("gemini-4-argon"));
	});

	it("rates 3.1 Pro with the long-context tier and covers its agent id", () => {
		const rates = costRatesFor("gemini-3.1-pro");
		expect(rates.input).toBe(2);
		expect(rates.tiers?.[0]).toEqual({ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0, inputTokensAbove: 200_000 });
		expect(costRatesFor("gemini-pro-agent")).toEqual(rates);
	});

	it("keeps unknown families at zero rates instead of guessing", () => {
		expect(costRatesFor("gemini-unknown-family")).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("applies catalog rates to projected fallback models", () => {
		const flash = FALLBACK_MODELS.find((model) => model.id === "gemini-3.8-flash");
		const argon = FALLBACK_MODELS.find((model) => model.id === "gemini-4-argon");
		expect(flash?.cost.input).toBe(0.75);
		expect(argon?.cost.output).toBe(10);
	});
});

describe("usageFromPrompt cost accounting", () => {
	it("prices the turn from the model's catalog rates", () => {
		const flash = FALLBACK_MODELS.find((model) => model.id === "gemini-3.8-flash")!;
		const usage = usageFromPrompt(
			{ stopReason: "end_turn", usage: { inputTokens: 1_000_000, outputTokens: 1000, totalTokens: 1_001_000 } },
			flash,
		);
		expect(usage.cost.input).toBeCloseTo(0.75, 6);
		expect(usage.cost.output).toBeCloseTo(0.00375, 6);
		expect(usage.cost.total).toBeCloseTo(0.75375, 6);
		expect(usage.cost.totalFromProvider).toBe(false);
	});

	it("prices cache reads at the discounted rate", () => {
		const flash = FALLBACK_MODELS.find((model) => model.id === "gemini-3.8-flash")!;
		const usage = usageFromPrompt(
			{ stopReason: "end_turn", usage: { inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 500_000, totalTokens: 1_500_000 } },
			flash,
		);
		expect(usage.cacheRead).toBe(500_000);
		expect(usage.input).toBe(500_000);
		expect(usage.cost.cacheRead).toBeCloseTo(500_000 * 0.075 / 1_000_000, 6);
		expect(usage.cost.input).toBeCloseTo(500_000 * 0.75 / 1_000_000, 6);
	});

	it("stays at zero cost when no model is supplied (legacy callers)", () => {
		const usage = usageFromPrompt({ stopReason: "end_turn", usage: { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 } });
		expect(usage.cost.total).toBe(0);
	});
});

describe("projectModels keeps catalog rates through projection", () => {
	it("does not erase rates when collapsing effort variants", () => {
		const models = projectModels([
			{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
		]);
		expect(models).toHaveLength(1);
		expect(models[0]?.cost.input).toBe(0.75);
	});
});
