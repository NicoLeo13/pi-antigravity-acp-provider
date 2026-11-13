import { describe, expect, it } from "vitest";

import { FALLBACK_MODELS, costRatesFor, projectModels, resolveAcpModelId, splitEffortSuffix } from "../src/models.js";
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

	it("rates Hydrogen at Google's published launch pricing, including the xhigh tier", () => {
		const expected = { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 };
		expect(costRatesFor("gemini-4-hydrogen")).toEqual(expected);
		expect(costRatesFor("gemini-4-hydrogen-xhigh")).toEqual(expected);
		expect(costRatesFor("gemini-4-hydrogen-low")).toEqual(expected);
	});

	it("rates Carbon at the models.dev catalog prices", () => {
		expect(costRatesFor("gemini-4-carbon")).toEqual({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 });
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

	it("prices cache reads at the discounted rate for both net and gross input formats", () => {
		const flash = FALLBACK_MODELS.find((model) => model.id === "gemini-3.8-flash")!;
		const netUsage = usageFromPrompt(
			{
				stopReason: "end_turn",
				usage: { inputTokens: 1_000_000, outputTokens: 1000, thoughtTokens: 400, cachedReadTokens: 500_000, totalTokens: 1_501_000 },
			},
			flash,
		);
		expect(netUsage.cacheRead).toBe(500_000);
		expect(netUsage.input).toBe(1_000_000);
		expect(netUsage.output).toBe(1000);
		expect(netUsage.cost.cacheRead).toBeCloseTo(500_000 * 0.075 / 1_000_000, 6);
		expect(netUsage.cost.input).toBeCloseTo(1_000_000 * 0.75 / 1_000_000, 6);
		expect(netUsage.cost.output).toBeCloseTo(1000 * 3.75 / 1_000_000, 6);

		const grossUsage = usageFromPrompt(
			{ stopReason: "end_turn", usage: { inputTokens: 1_000_000, outputTokens: 0, cachedReadTokens: 500_000, totalTokens: 1_000_000 } },
			flash,
		);
		expect(grossUsage.cacheRead).toBe(500_000);
		expect(grossUsage.input).toBe(500_000);
		expect(grossUsage.cost.cacheRead).toBeCloseTo(500_000 * 0.075 / 1_000_000, 6);
		expect(grossUsage.cost.input).toBeCloseTo(500_000 * 0.75 / 1_000_000, 6);
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

describe("xhigh tier handling", () => {
	it("groups a server-advertised xhigh variant into the thinking map instead of emitting a fixed model", () => {
		const models = projectModels([
			{ modelId: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
			{ modelId: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
			{ modelId: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (Xhigh)" },
		]);
		expect(models).toHaveLength(1);
		expect(models[0]?.reasoning).toBe(true);
		expect(models[0]?.thinkingLevelMap?.xhigh).toBe("gemini-4-hydrogen-xhigh");
		expect(models[0]?.thinkingLevelMap?.max).toBeNull();
	});

	it("resolves xhigh to the xhigh id when present and clamps to high otherwise", () => {
		const hydrogen = FALLBACK_MODELS.find((model) => model.id === "gemini-4-hydrogen")!;
		const argon = FALLBACK_MODELS.find((model) => model.id === "gemini-4-argon")!;
		expect(resolveAcpModelId(hydrogen, "xhigh")).toBe("gemini-4-hydrogen-xhigh");
		expect(resolveAcpModelId(argon, "xhigh")).toBe("gemini-4-argon-high");
		expect(resolveAcpModelId(argon, "high")).toBe("gemini-4-argon-high");
		expect(resolveAcpModelId(argon, "medium")).toBe("gemini-4-argon-medium");
	});

	it("keeps splitEffortSuffix consistent with the new tier", () => {
		expect(splitEffortSuffix("gemini-4-hydrogen-xhigh")).toEqual({ base: "gemini-4-hydrogen", effort: "xhigh" });
		expect(splitEffortSuffix("gemini-4-hydrogen")).toBeUndefined();
	});
});
