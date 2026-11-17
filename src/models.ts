import type { AcpModelInfo } from "./acp/session-state.js";
import type {
	Model,
	ThinkingLevel,
	ThinkingLevelMap,
} from "@earendil-works/pi-ai";

export const PROVIDER_ID = "antigravity-acp";
export const API_ID = "antigravity-acp";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
type Effort = "low" | "medium" | "high" | "xhigh";
type Variants = Partial<Record<Effort, string>>;

/** Catalog rates in USD per million tokens. Flash / Argon / Carbon / Pro entries
 * match models.dev's Google / Vertex entries (retrieved 2026-11-11); Hydrogen
 * matches Google's published paid-tier pricing from its 2026-11-12 launch (not
 * yet in models.dev). Antigravity bills through a subscription, so these produce
 * a reference estimate rather than a billed amount — the same estimate OpenCode
 * shows for the same models. Unknown model families keep zero rates instead of
 * guessing. */
const FLASH_RATES: Model<typeof API_ID>["cost"] = { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 };
const ARGON_RATES: Model<typeof API_ID>["cost"] = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const CARBON_RATES: Model<typeof API_ID>["cost"] = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 0 };
const HYDROGEN_RATES: Model<typeof API_ID>["cost"] = { input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 };
const PRO_RATES = {
	input: 2,
	output: 12,
	cacheRead: 0.2,
	cacheWrite: 0,
	tiers: [{ input: 4, output: 18, cacheRead: 0.4, cacheWrite: 0, inputTokensAbove: 200_000 }],
};

/** Resolve the catalog rates for a projected model id. Effort-qualified ids share the
 * base model's rates, and `gemini-pro-agent` is Gemini 3.1 Pro under its agent name. */
export function costRatesFor(modelId: string): Model<typeof API_ID>["cost"] {
	const base = splitEffortSuffix(modelId)?.base ?? modelId;
	if (/^gemini-3\.[678]-flash$/u.test(base)) return FLASH_RATES;
	if (/^gemini-4-hydrogen$/u.test(base)) return HYDROGEN_RATES;
	if (/^gemini-4-argon$/u.test(base)) return ARGON_RATES;
	if (/^gemini-4-carbon$/u.test(base)) return CARBON_RATES;
	if (/^(gemini-3\.1-pro|gemini-pro-agent)$/u.test(base)) return PRO_RATES;
	return ZERO_COST;
}

// Keep the broadly available Flash model first for offline/default selection.
export const FALLBACK_MODELS: readonly Model<typeof API_ID>[] = [
	reasoningModel("gemini-3.8-flash", "Gemini 3.8 Flash", {
		low: "gemini-3.8-flash-low",
		medium: "gemini-3.8-flash-medium",
		high: "gemini-3.8-flash-high",
	}),
	reasoningModel("gemini-4-hydrogen", "Gemini 4 Hydrogen", {
		low: "gemini-4-hydrogen-low",
		medium: "gemini-4-hydrogen-medium",
		high: "gemini-4-hydrogen-high",
		xhigh: "gemini-4-hydrogen-xhigh",
	}),
	reasoningModel("gemini-4-argon", "Gemini 4 Argon", {
		low: "gemini-4-argon-low",
		medium: "gemini-4-argon-medium",
		high: "gemini-4-argon-high",
	}),
	reasoningModel("gemini-3.7-flash", "Gemini 3.7 Flash", {
		low: "gemini-3.7-flash-low",
		medium: "gemini-3.7-flash-medium",
		high: "gemini-3.7-flash-high",
	}),
	reasoningModel("gemini-3.6-flash", "Gemini 3.6 Flash", {
		low: "gemini-3.6-flash-low",
		medium: "gemini-3.6-flash-medium",
		high: "gemini-3.6-flash-high",
	}),
	reasoningModel("gemini-3.1-pro", "Gemini 3.1 Pro", {
		low: "gemini-3.1-pro-low",
		high: "gemini-pro-agent",
	}),
];

/** Collapse Antigravity's effort-qualified ACP IDs into one Pi model. The
 * exact server IDs live in thinkingLevelMap, allowing Shift+Tab to select the
 * corresponding low/medium/high variant without cluttering /model. */
export function projectModels(models: readonly AcpModelInfo[]): Model<typeof API_ID>[] {
	const safe = models.filter((candidate) => validModelId(candidate.modelId.trim()));
	const groups = new Map<
		string,
		{ name: string; variants: Variants; members: AcpModelInfo[] }
	>();

	for (const candidate of safe) {
		const id = candidate.modelId.trim();
		const parsed = effortFromName(candidate.name) ?? effortFromId(id);
		if (!id.startsWith("gemini-") || !parsed) continue;
		const key = parsed.baseName.toLowerCase();
		const group = groups.get(key) ?? { name: parsed.baseName, variants: {}, members: [] };
		group.variants[parsed.effort] = id;
		group.members.push(candidate);
		groups.set(key, group);
	}

	const emittedGroups = new Set<string>();
	const emittedIds = new Set<string>();
	const projected: Model<typeof API_ID>[] = [];
	for (const candidate of safe) {
		const id = candidate.modelId.trim();
		if (emittedIds.has(id)) continue;
		const parsed = effortFromName(candidate.name) ?? effortFromId(id);
		const key = parsed?.baseName.toLowerCase();
		const group = key ? groups.get(key) : undefined;
		if (group && Object.keys(group.variants).length >= 2) {
			if (emittedGroups.has(key!)) continue;
			emittedGroups.add(key!);
			for (const member of group.members) emittedIds.add(member.modelId.trim());
			projected.push(
				reasoningModel(canonicalId(group.name, group.variants), group.name, group.variants),
			);
			continue;
		}
		emittedIds.add(id);
		// A single advertised effort is still a reasoning model (for example
		// Argon Medium during a rollout). Preserve its exact public/ACP ID and
		// expose only that tier, rather than claiming thinking is unsupported or
		// guessing additional variants which may not exist for this account.
		projected.push(id.startsWith("gemini-") && parsed
			? reasoningModel(id, candidate.name.trim() || id, { [parsed.effort]: id })
			: fixedModel(id, candidate.name.trim() || id));
	}
	return projected;
}

export type ModelEffort = "low" | "medium" | "high" | "xhigh";

/** Antigravity advertises effort-qualified ids (`gemini-3.8-flash-high`) while the
 * server's `model` config option takes only the base id and keeps the tier on a
 * selector of its own, so a qualified id has to be split before it is sent.
 * Gemini 4 Hydrogen adds an `xhigh` tier. */
export function splitEffortSuffix(modelId: string): { base: string; effort: ModelEffort } | undefined {
	const match = /^(.*)-(low|medium|high|xhigh)$/u.exec(modelId);
	if (!match?.[1]) return undefined;
	return { base: match[1], effort: match[2] as ModelEffort };
}

/** Resolve Pi's current reasoning level to the exact model ID advertised by
 * Antigravity. Unsupported programmatic levels clamp to the nearest tier. */
export function resolveAcpModelId(
	model: Model<typeof API_ID>,
	reasoning: ThinkingLevel | undefined,
): string {
	const map = model.thinkingLevelMap;
	if (!model.reasoning || !map) return model.id;
	const preferred: Effort =
		reasoning === "minimal" || reasoning === "low"
			? "low"
			: reasoning === "xhigh" || reasoning === "max"
				? "xhigh"
				: reasoning === "high"
					? "high"
					: "medium";
	const order: Effort[] =
		preferred === "low"
			? ["low", "medium", "high"]
			: preferred === "xhigh"
				? ["xhigh", "high", "medium", "low"]
				: preferred === "high"
					? ["high", "medium", "low"]
					: ["medium", "high", "low"];
	for (const effort of order) {
		const value = map[effort];
		if (typeof value === "string" && value) return value;
	}
	return model.id;
}

function reasoningModel(
	id: string,
	name: string,
	variants: Variants,
): Model<typeof API_ID> {
	const thinkingLevelMap: ThinkingLevelMap = {
		off: null,
		minimal: null,
		low: variants.low ?? null,
		medium: variants.medium ?? null,
		high: variants.high ?? null,
		xhigh: variants.xhigh ?? null,
		max: null,
	};
	return baseModel(id, name, true, thinkingLevelMap);
}

function fixedModel(id: string, name: string): Model<typeof API_ID> {
	return baseModel(id, name, false);
}

function baseModel(
	id: string,
	name: string,
	reasoning: boolean,
	thinkingLevelMap?: ThinkingLevelMap,
): Model<typeof API_ID> {
	return {
		id,
		name,
		api: API_ID,
		provider: PROVIDER_ID,
		baseUrl: "",
		reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: ["text", "image"],
		cost: costRatesFor(id),
		contextWindow: 1_000_000,
		maxTokens: 65_536,
	};
}

function effortFromName(name: string): { baseName: string; effort: Effort } | undefined {
	const match = name.trim().match(/^(.+?)\s*\((low|medium|high|xhigh)\)$/iu);
	if (!match?.[1] || !match[2]) return undefined;
	return { baseName: match[1].trim(), effort: match[2].toLowerCase() as Effort };
}

function effortFromId(id: string): { baseName: string; effort: Effort } | undefined {
	const split = splitEffortSuffix(id);
	return split ? { baseName: titleFromId(split.base), effort: split.effort } : undefined;
}

function canonicalId(name: string, variants: Variants): string {
	const bases = Object.values(variants)
		.filter((value): value is string => typeof value === "string")
		.map((value) => splitEffortSuffix(value)?.base ?? value);
	if (bases.length > 0 && bases.every((value) => value === bases[0])) return bases[0]!;
	return name
		.toLowerCase()
		.replace(/[^a-z0-9.]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
}

function titleFromId(id: string): string {
	return id
		.split("-")
		.map((part) => (part === "gemini" ? "Gemini" : part.charAt(0).toUpperCase() + part.slice(1)))
		.join(" ");
}

function validModelId(id: string): boolean {
	return id.length > 0 && id.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(id);
}
