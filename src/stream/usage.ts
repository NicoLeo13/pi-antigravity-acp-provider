import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { calculateCost } from "@earendil-works/pi-ai";

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function usageFromPrompt(response: PromptResponse, model?: Model<string>): Usage {
	const usage = emptyUsage();
	const standard = asRecord(response.usage);
	const quota = asRecord(asRecord(response._meta)?.quota);
	const tokens = asRecord(quota?.token_count);
	usage.cacheRead = token(standard?.cachedReadTokens) ?? 0;
	usage.cacheWrite = token(standard?.cachedWriteTokens) ?? 0;
	const rawInput = token(standard?.inputTokens) ?? token(tokens?.input_tokens) ?? 0;
	const rawOutput = token(standard?.outputTokens) ?? token(tokens?.output_tokens) ?? 0;
	const reasoning = token(standard?.thoughtTokens);
	const rawTotal = token(standard?.totalTokens);
	const resolved = resolveInputAndOutput(rawInput, rawOutput, usage.cacheRead, usage.cacheWrite, reasoning, rawTotal);
	usage.input = resolved.input;
	usage.output = resolved.output;
	if (reasoning !== undefined) usage.reasoning = reasoning;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	if (model) calculateCost(model, usage);
	return usage;
}

function resolveInputAndOutput(
	rawInput: number,
	rawOutput: number,
	cacheRead: number,
	cacheWrite: number,
	reasoning: number | undefined,
	rawTotal: number | undefined,
): { input: number; output: number } {
	const thoughts = reasoning ?? 0;
	const outputIncludesThoughts = reasoning === undefined || rawOutput >= reasoning;
	if (rawTotal !== undefined) {
		const candidates: Array<{ input: number; output: number }> = [];
		// 1. ACP 1.5.0+: input excludes cache counters, output already includes thoughtTokens.
		if (outputIncludesThoughts) {
			candidates.push({ input: rawInput, output: rawOutput });
		}
		// 2. Legacy ACP (e.g. 1.4.3): input includes cacheRead (and possibly cacheWrite), output excludes thoughts.
		if (rawInput >= cacheRead) {
			if (cacheWrite > 0 && rawInput >= cacheRead + cacheWrite) {
				candidates.push({ input: rawInput - cacheRead - cacheWrite, output: rawOutput + thoughts });
			}
			candidates.push({ input: rawInput - cacheRead, output: rawOutput + thoughts });
		}
		// 3. Gross input + inclusive output (totalTokens === inputTokens + outputTokens).
		if (outputIncludesThoughts && rawInput >= cacheRead) {
			if (cacheWrite > 0 && rawInput >= cacheRead + cacheWrite) {
				candidates.push({ input: rawInput - cacheRead - cacheWrite, output: rawOutput });
			}
			candidates.push({ input: rawInput - cacheRead, output: rawOutput });
		}
		// 4. Net input + exclusive output.
		if (thoughts > 0) {
			candidates.push({ input: rawInput, output: rawOutput + thoughts });
		}
		const matched = candidates.find(
			(candidate) => candidate.input + candidate.output + cacheRead + cacheWrite === rawTotal,
		);
		if (matched) return matched;
	}
	return {
		input: rawInput,
		output: outputIncludesThoughts ? rawOutput : rawOutput + thoughts,
	};
}

function token(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
