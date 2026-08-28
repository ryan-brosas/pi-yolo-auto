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
 * Auth: /login. The key is stored under provider "yolo-auto" in
 * ~/.pi/agent/auth.json and resolved at request time via the model registry.
 * It is never printed.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import fs from "fs";
import path from "path";
import modelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import deprecatedData from "./deprecated-models.json" with { type: "json" };
import { applyPlanContext, buildModels, toApiModel, transformApiModel, type JsonModel, type PatchData } from "./models.ts";
import { COUNT_WINDOW_MS, nextHeatAt, parseSubscription, requestHeat, requestMilestone, requestSnapshot, subscriptionStatusText, withRequestCount, yoloDashboard, type PlanTier, type Subscription } from "./usage.ts";

const PROVIDER_ID = "yolo-auto";
const BASE_URL = "https://yolo-auto.com/v1";

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
// Latest known base catalog (embedded → cache → live) and the last plan whose
// context windows were applied to the registered provider.
let currentBase: JsonModel[] | null = null;
let currentPlan: PlanTier | null = null;
// Once-per-session guard for the low-remaining warning.
let lowWarned = false;
// Per-session count of completed yolo-auto LLM requests (flat-rate plans are
// unlimited, so a live counter is more useful than a budget bar).
let sessionRequests = 0;
const requestTimes: number[] = [];
let sessionStartedAt = Date.now();
let lastSub: Subscription | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let widgetOpen = false;

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

const STATUS_KEY = `${PROVIDER_ID}-sub`;
const WIDGET_KEY = `${PROVIDER_ID}-usage`;

function snapNow(now = Date.now()) {
	return requestSnapshot(requestTimes, sessionRequests, now, sessionStartedAt);
}

function noteRequest(now: number): void {
	sessionRequests++;
	requestTimes.push(now);
	const cutoff = now - COUNT_WINDOW_MS;
	while (requestTimes.length && requestTimes[0] < cutoff) requestTimes.shift();
	if (requestTimes.length > 64) requestTimes.splice(0, requestTimes.length - 64);
}

function updateStatus(ctx: ExtensionContext, sub: Subscription | null): void {
	if (!ctx.hasUI) return;
	const now = Date.now();
	const snap = snapNow(now);
	const text = withRequestCount(sub ? subscriptionStatusText(sub) : undefined, snap);
	const on = ctx.model?.provider === PROVIDER_ID;
	const heat = requestHeat(requestTimes[requestTimes.length - 1], now);
	ctx.ui.setStatus(STATUS_KEY, on && text ? ctx.ui.theme.fg(heat, text) : undefined);
	if (!on) {
		widgetOpen = false;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	} else if (widgetOpen) {
		ctx.ui.setWidget(WIDGET_KEY, yoloDashboard(sub, snap));
	}
	if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
	const next = nextHeatAt(requestTimes[requestTimes.length - 1], now);
	if (on && next != null) {
		idleTimer = setTimeout(() => {
			idleTimer = null;
			updateStatus(ctx, sub);
		}, Math.max(0, next - now) + 10);
	}
}

// noinspection JSUnusedGlobalSymbols -- Pi loads this default export from package.json
export default function (pi: ExtensionAPI) {
	const embeddedModels = modelsData as JsonModel[];
	const customModels = customModelsData as JsonModel[];
	const patches = patchData as PatchData;

	currentBase = loadStaleModels(embeddedModels);

	// Re-register whenever the base catalog or the detected plan changes;
	// plan-dependent context windows come from patch.json (contextByPlan).
	function registerCatalog(): void {
		const models = applyPlanContext(
			buildModels(withDeprecated(currentBase ?? embeddedModels), customModels, patches),
			currentPlan,
		);
		pi.registerProvider(PROVIDER_ID, {
			name: "Yolo-Auto (auto)",
			baseUrl: BASE_URL,
			api: "openai-completions",
			models: models.map(toApiModel),
		});
	}

	// Refresh the footer and hot-swap the catalog when the detected plan changes.
	async function applySubscription(sub: Subscription | null, ctx: ExtensionContext): Promise<void> {
		const plan = sub?.plan ?? null;
		if (plan !== currentPlan) {
			const prev = currentPlan;
			currentPlan = plan;
			registerCatalog();
			if (ctx.hasUI && prev != null && plan != null && plan !== prev) {
				ctx.ui.notify(`yolo-auto plan: ${plan}`, "info");
			}
		}
		if (
			ctx.hasUI && !lowWarned && sub?.requestsRemaining != null && sub.requestsLimit != null &&
			sub.requestsLimit > 0 && sub.requestsRemaining / sub.requestsLimit <= 0.1
		) {
			lowWarned = true;
			ctx.ui.notify(`yolo-auto: only ${sub.requestsRemaining}/${sub.requestsLimit} requests left`, "warning");
		}
		lastSub = sub;
		updateStatus(ctx, sub);
	}

	// On-demand usage detail: multi-line widget above the editor.
	pi.registerCommand(PROVIDER_ID, {
		description: "Show Yolo-Auto request counts (session, last 1m/8m, rpm). /yolo-auto hide to dismiss",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			if (String(args ?? "").trim() === "hide") {
				widgetOpen = false;
				ctx.ui.setWidget(WIDGET_KEY, undefined);
				return;
			}
			if (!cachedApiKey) await resolveApiKey(ctx.modelRegistry);
			const sub = (await fetchSubscription(cachedApiKey)) ?? lastSub;
			lastSub = sub;
			widgetOpen = true;
			updateStatus(ctx, sub);
			const line = withRequestCount(sub ? subscriptionStatusText(sub) : undefined, snapNow());
			ctx.ui.notify(line ? `yolo-auto: ${line}` : "yolo-auto: 0 req", "info");
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		revalidateAbort?.abort();
		lowWarned = false;
		sessionRequests = 0;
		requestTimes.length = 0;
		sessionStartedAt = Date.now();
		widgetOpen = false;
		lastSub = null;
		if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
		revalidateAbort = new AbortController();
		const signal = revalidateAbort.signal;
		await resolveApiKey(ctx.modelRegistry);
		revalidateModels(cachedApiKey, embeddedModels, signal).then((fresh) => {
			if (fresh && !signal.aborted) {
				currentBase = fresh;
				registerCatalog();
			}
		});
		await applySubscription(await fetchSubscription(cachedApiKey, signal), ctx);
	});

	// Flat-rate plans are unlimited: count completed yolo-auto requests per session.
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant" || event.message.provider !== PROVIDER_ID) return;
		noteRequest(Date.now());
		const hit = requestMilestone(sessionRequests);
		if (hit != null && ctx.hasUI) ctx.ui.notify(`yolo-auto: ${hit} requests this session`, "info");
		updateStatus(ctx, lastSub);
	});
	pi.on("model_select", async (event, ctx) => {
		if (event.model?.provider === PROVIDER_ID) {
			await applySubscription(await fetchSubscription(cachedApiKey), ctx);
		} else {
			updateStatus(ctx, null);
		}
	});

	pi.on("session_shutdown", () => {
		revalidateAbort?.abort();
		if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
	});
}
