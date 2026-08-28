// Pure, dependency-free model pipeline for the Yolo-Auto provider.
// Kept separate from index.ts so it is unit-testable without pi-ai/pi-coding-agent.

import type { PlanTier } from "./usage.ts";

export interface JsonModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	/** Plan-dependent context windows (site tiers: Free/Builder 128K, Pro 256K). */
	contextByPlan?: Partial<Record<PlanTier, number>>;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: {
		supportsDeveloperRole?: boolean;
		supportsStore?: boolean;
		maxTokensField?: "max_completion_tokens" | "max_tokens";
		thinkingFormat?: string;
		supportsReasoningEffort?: boolean;
	};
}

export interface PatchEntry {
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	cost?: Partial<JsonModel["cost"]>;
	contextWindow?: number;
	maxTokens?: number;
	contextByPlan?: Partial<Record<PlanTier, number>>;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
}
export type PatchData = Record<string, PatchEntry>;

/** Convert one pricing value (assumed $/M tokens) to a 6-decimal number. */
export function parsePrice(v: unknown): number {
	if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 1e6) / 1e6;
	const n = typeof v === "string" ? parseFloat(v) : NaN;
	return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0;
}

/**
 * Transform an entry from the provider /v1/models API. The API flags are
 * unreliable; callers enrich reasoning/compat via patch.json afterwards.
 */
export function transformApiModel(api: Record<string, unknown>): JsonModel | null {
	const id = typeof api.id === "string" ? api.id.trim() : "";
	if (!id) return null;
	const pricing = (api.pricing && typeof api.pricing === "object" ? api.pricing : {}) as Record<string, unknown>;
	const hasReasoning = api.reasoning_effort === true || api.custom_reasoning === true || api.reasoning === true;
	const name = String(api.name || api.id).replace(/^[^:]+:\s*/, "");
	return {
		id,
		name,
		reasoning: hasReasoning,
		input: ["text"],
		cost: {
			input: parsePrice(pricing.prompt),
			output: parsePrice(pricing.completion),
			cacheRead: parsePrice(pricing.cache_prompt),
			cacheWrite: 0,
		},
		contextWindow: asNum(api.context_length, 131072),
		maxTokens: asNumFallback(api.max_completion_tokens, api.context_length, 16384),
	};
}

function asNum(v: unknown, fb: number): number {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	const n = typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : fb;
}
function asNumFallback(a: unknown, b: unknown, fb: number): number {
	const x = asNum(a, fb);
	if (Number.isFinite(x) && x > 0 && x !== fb) return x;
	const y = asNum(b, fb);
	return Number.isFinite(y) && y > 0 ? y : fb;
}

/** Apply one patch entry onto a model (deep-merge compat, shallow elsewhere). */
export function applyPatch(model: JsonModel, patch: PatchEntry): JsonModel {
	const result: JsonModel = { ...model };
	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.contextByPlan !== undefined) result.contextByPlan = { ...patch.contextByPlan };
	if (patch.thinkingLevelMap !== undefined) result.thinkingLevelMap = { ...patch.thinkingLevelMap };
	if (patch.cost) {
		result.cost = {
			input: patch.cost.input ?? result.cost.input,
			output: patch.cost.output ?? result.cost.output,
			cacheRead: patch.cost.cacheRead ?? result.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? result.cost.cacheWrite,
		};
	}
	if (patch.compat) result.compat = { ...(result.compat || {}), ...patch.compat };
	if (!result.reasoning && result.compat?.thinkingFormat) delete result.compat.thinkingFormat;
	if (result.compat && Object.keys(result.compat).length === 0) delete result.compat;
	return result;
}

/**
 * Full merge pipeline: base → apply patch → merge custom. Custom replaces
 * same-id base entries wholesale (after the patch is applied), matching the
 * reference provider semantics.
 */
export function buildModels(
	base: JsonModel[],
	custom: JsonModel[],
	patch: PatchData,
): JsonModel[] {
	const map = new Map<string, JsonModel>();
	for (const m of base) map.set(m.id, m);
	for (const [id, pe] of Object.entries(patch)) {
		const existing = map.get(id);
		if (existing) map.set(id, applyPatch(existing, pe));
	}
	for (const m of custom) {
		const existing = map.get(m.id);
		const pe = patch[m.id];
		map.set(m.id, existing && pe ? applyPatch(m, pe) : m);
	}
	return Array.from(map.values());
}

/**
 * Apply plan-dependent context windows declared via patch entries. Models
 * without a contextByPlan entry are untouched; a null plan keeps the
 * catalog default.
 */
export function applyPlanContext(models: JsonModel[], plan: PlanTier | null): JsonModel[] {
	if (!plan) return models;
	return models.map((m) => {
		const w = m.contextByPlan?.[plan];
		return typeof w === "number" && w > 0 ? { ...m, contextWindow: w } : m;
	});
}

export function toApiModel(m: JsonModel): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		input: m.input,
		cost: m.cost,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
	};
	if (m.thinkingLevelMap) out.thinkingLevelMap = m.thinkingLevelMap;
	if (m.compat && Object.keys(m.compat).length) out.compat = m.compat;
	return out;
}
