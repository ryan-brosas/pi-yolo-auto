/**
 * Yolo-Auto Provider Extension
 *
 * Registers YoloAuto (yolo-auto.com) as a custom provider using the
 * openai-completions API. Base URL: https://yolo-auto.com/v1
 *
 * Model resolution strategy: Stale-While-Revalidate
 *   1. Serve embedded models.json + patch + custom instantly (zero-latency)
 *   2. On session_start, revalidate in background: live API /models (gated on
 *      the resolved API key) -> merge with embedded -> cache -> hot-swap
 *   3. patch.json + custom-models.json applied on top of whichever source won
 *
 * Auth: two coequal paths. 1) ~/.pi/agent/auth.json under provider "yolo-auto"
 * (type api_key) — the recommended path. 2) env YOLO_AUTO_API_KEY. The key is
 * resolved at request time via the model registry / pi's $ENV resolution and is
 * never printed.
 */

import { getAgentDir, type ExtensionAPI, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import fs from "fs";
import path from "path";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import { buildModels, toApiModel, transformApiModel, type JsonModel, type PatchData } from "./models.ts";
import { parseSubscription, subscriptionStatusText, type Subscription } from "./usage.ts";

const PROVIDER_ID = "yolo-auto";
const BASE_URL = "https://yolo-auto.com/v1";
const KEY_ENV = "YOLO_AUTO_API_KEY";
const MODELS_URL = `${BASE_URL}/models`;
const USAGE_URL = `${BASE_URL}/usage`;
const CACHE_DIR = path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, `${PROVIDER_ID}-models.json`);
const LIVE_FETCH_TIMEOUT_MS = 8000;

// Grace period for delisted models before permanent eviction.
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function activeDeprecatedModels(): JsonModel[] {
	const now = Date.now();
	const out: JsonModel[] = [];
	for (const e of Object.values(deprecatedData as Record<string, JsonModel & { deprecatedAt?: string }>)) {
		if (!e?.id) continue;
		const at = Date.parse(e.deprecatedAt ?? "");
		if (Number.isNaN(at) || now - at > DEPRECATED_MODEL_TTL_MS) continue;
		const m = { ...e } as JsonModel & { deprecatedAt?: string };
		delete m.deprecatedAt;
		out.push(m);
	}
	return out;
}

function withDeprecated(models: JsonModel[]): JsonModel[] {
	const seen = new Set(models.map((m) => m.id));
	const extras = activeDeprecatedModels().filter((m) => !seen.has(m.id));
	return extras.length ? [...models, ...extras] : models;
}

async function fetchLiveModels(apiKey: string | undefined, signal?: AbortSignal): Promise<JsonModel[] | null> {
	if (!apiKey) return null;
	try {
		const res = await fetch(MODELS_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: signal
				? AbortSignal.any([AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS), signal])
				: AbortSignal.timeout(LIVE_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as unknown;
		const list = Array.isArray(data) ? data : ((data as { data?: unknown[] }).data ?? []);
		if (!Array.isArray(list) || list.length === 0) return null;
		return list.map((r) => transformApiModel(r as Record<string, unknown>)).filter((m): m is JsonModel => m !== null);
	} catch {
		return null;
	}
}

function loadCachedModels(): JsonModel[] | null {
	try {
		const d = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
		return Array.isArray(d) ? d : null;
	} catch { return null; }
}

function cacheModels(models: JsonModel[]): void {
	try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(CACHE_PATH, JSON.stringify(models, null, 2) + "\n"); }
	catch { /* non-fatal */ }
}

// Live API is authoritative for fields it reports; curated embedded wins otherwise.
function mergeWithEmbedded(live: JsonModel[], embedded: JsonModel[]): JsonModel[] {
	const emap = new Map(embedded.map((m) => [m.id, m]));
	const seen = new Set<string>();
	const result: JsonModel[] = [];
	for (const lm of live) {
		seen.add(lm.id);
		const em = emap.get(lm.id);
		if (em) {
			result.push({
				...lm,
				...em,
				cost: {
					input: lm.cost.input || em.cost.input,
					output: lm.cost.output || em.cost.output,
					cacheRead: lm.cost.cacheRead || em.cost.cacheRead,
					cacheWrite: lm.cost.cacheWrite || em.cost.cacheWrite,
				},
				contextWindow: lm.contextWindow || em.contextWindow,
			});
		} else result.push(lm);
	}
	for (const em of embedded) if (!seen.has(em.id)) result.push(em);
	return result;
}

function loadStaleModels(embedded: JsonModel[]): JsonModel[] {
	const cached = loadCachedModels();
	if (!cached || cached.length === 0) return embedded;
	const cmap = new Map(cached.map((m) => [m.id, m]));
	for (const em of embedded) if (!cmap.has(em.id)) cached.push(em);
	return cached;
}

async function revalidateModels(apiKey: string | undefined, embedded: JsonModel[], signal?: AbortSignal): Promise<JsonModel[] | null> {
	if (!apiKey) return null;
	const live = await fetchLiveModels(apiKey, signal);
	if (!live || live.length === 0) return null;
	const merged = mergeWithEmbedded(live, embedded);
	cacheModels(merged);
	return merged;
}

let cachedApiKey: string | undefined;
let revalidateAbort: AbortController | null = null;

async function resolveApiKey(modelRegistry: ModelRegistry): Promise<void> {
	cachedApiKey = (await modelRegistry.getApiKeyForProvider(PROVIDER_ID)) ?? undefined;
}

// ─── Subscription / usage detection ────────────────────────────────────────────

const USAGE_TIMEOUT_MS = 5000;

// The site's paid tiers, used to label the detected subscription in the footer.
async function fetchSubscription(apiKey: string | undefined, signal?: AbortSignal): Promise<Subscription | null> {
	if (!apiKey) return null;
	try {
		const res = await fetch(USAGE_URL, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: signal
				? AbortSignal.any([AbortSignal.timeout(USAGE_TIMEOUT_MS), signal])
				: AbortSignal.timeout(USAGE_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return parseSubscription(await res.json());
	} catch {
		return null;
	}
}

function updateStatus(ctx: any, sub: Subscription | null): void {
	const text = sub ? subscriptionStatusText(sub) : undefined;
	const md = ctx.model?.provider === PROVIDER_ID;
	ctx.ui?.setStatus(`${PROVIDER_ID}-sub`, md && text ? ctx.ui.theme.fg("dim", text) : undefined);
}

export default function (pi: ExtensionAPI) {
	const embeddedModels = modelsData as JsonModel[];
	const customModels = customModelsData as JsonModel[];
	const patches = patchData as PatchData;

	const staleBase = loadStaleModels(embeddedModels);
	const staleModels = buildModels(withDeprecated(staleBase), customModels, patches);

	pi.registerProvider(PROVIDER_ID, {
		name: "Yolo-Auto (auto)",
		baseUrl: BASE_URL,
		api: "openai-completions",
		apiKey: `$${KEY_ENV}`,
		models: staleModels.map(toApiModel),
	});

	pi.on("session_start", async (_event, ctx) => {
		revalidateAbort?.abort();
		revalidateAbort = new AbortController();
		const signal = revalidateAbort.signal;
		await resolveApiKey(ctx.modelRegistry);
		revalidateModels(cachedApiKey, embeddedModels, signal).then((fresh) => {
			if (fresh && !signal.aborted) {
				pi.registerProvider(PROVIDER_ID, {
					baseUrl: BASE_URL,
					api: "openai-completions",
					apiKey: `$${KEY_ENV}`,
					models: buildModels(withDeprecated(fresh), customModels, patches).map(toApiModel),
				});
			}
		});
		updateStatus(ctx, await fetchSubscription(cachedApiKey, signal));
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.model?.provider === PROVIDER_ID) {
			updateStatus(ctx, await fetchSubscription(cachedApiKey));
		} else {
			updateStatus(ctx, null);
		}
	});

	pi.on("session_shutdown", () => revalidateAbort?.abort());
}
