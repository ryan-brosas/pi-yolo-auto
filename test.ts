/**
 * Unit tests for pi-yolo-auto — offline, no live endpoint, no pi-ai dependency.
 * Run: npm test  (node --experimental-strip-types --test test.ts)
 */
import { describe, it } from "node:test";
import assert from "node:assert";

import { applyPatch, applyPlanContext, buildModels, parsePrice, toApiModel, transformApiModel, type JsonModel } from "./models.ts";

const base: JsonModel = {
	id: "qwen3.8-27b", name: "qwen3.8-27b", reasoning: true, input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 16384,
};

describe("parsePrice", () => {
	it("parses string and numeric $/M prices with 6-decimal precision", () => {
		assert.equal(parsePrice("0.003625"), 0.003625);
		assert.equal(parsePrice(0.28), 0.28);
		assert.equal(parsePrice(undefined), 0);
	});
});

describe("transformApiModel", () => {
	it("safely transforms a raw API entry", () => {
		const m = transformApiModel({ id: "m-1", pricing: { prompt: "0.25", completion: "1.0" }, context_length: 131072 })!;
		assert.equal(m.id, "m-1");
		assert.equal(m.cost.input, 0.25);
		assert.equal(m.cost.output, 1);
		assert.equal(m.reasoning, false); // unreliable flag default
		assert.deepEqual(m.input, ["text"]);
	});
	it("treats reasoning flags as opt-in", () => {
		assert.equal(transformApiModel({ id: "r", reasoning_effort: true })!.reasoning, true);
		assert.equal(transformApiModel({ id: "r2" })!.reasoning, false);
	});
	it("rejects missing id", () => assert.equal(transformApiModel({ name: "x" }), null));
});

describe("applyPatch", () => {
	it("deep-merges compat and shallow-merges others", () => {
		const m = applyPatch(base, { reasoning: false, compat: { maxTokensField: "max_tokens", supportsReasoningEffort: true } });
		assert.equal(m.reasoning, false);
		assert.equal(m.compat?.maxTokensField, "max_tokens");
	});
	it("drops thinkingFormat when the patched model is not reasoning", () => {
		const m = applyPatch({ ...base, compat: { thinkingFormat: "qwen" } }, { reasoning: false });
		assert.equal(m.compat?.thinkingFormat, undefined);
	});
});

describe("buildModels (base → patch → custom)", () => {
	it("applies patch then custom replacement in order", () => {
		const out = buildModels(
			[base],
			[{ ...base, id: "qwen3.8-27b", name: "Custom Name", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
			{ "qwen3.8-27b": { maxTokens: 32128 } },
		);
		assert.equal(out.length, 1);
		assert.equal(out[0].name, "Custom Name");
		assert.equal(out[0].maxTokens, 32128); // patch applied onto custom
	});
	it("custom replaces base on collision", () => {
		const out = buildModels([base], [{ ...base, name: "New" }], {});
		assert.equal(out[0].name, "New");
	});
});

describe("toApiModel", () => {
	it("flattens to registry shape and includes compat", () => {
		const out = toApiModel({ ...base, compat: { supportsStore: false } });
		assert.equal(out.maxTokens, 16384);
		assert.equal(out.compat?.supportsStore, false);
	});
});


describe("applyPlanContext", () => {
	const planModel: JsonModel = { ...base, contextByPlan: { Free: 131072, Builder: 131072, Pro: 262144 } };

	it("expands Pro to 256K and keeps Free/Builder at 128K", () => {
		assert.equal(applyPlanContext([planModel], "Pro")[0].contextWindow, 262144);
		assert.equal(applyPlanContext([planModel], "Builder")[0].contextWindow, 131072);
		assert.equal(applyPlanContext([planModel], "Free")[0].contextWindow, 131072);
	});

	it("null plan keeps the catalog default", () => {
		assert.equal(applyPlanContext([planModel], null)[0].contextWindow, 131072);
	});

	it("leaves models without contextByPlan untouched", () => {
		assert.equal(applyPlanContext([base], "Pro")[0].contextWindow, 131072);
	});

	it("flows through buildModels from patch entries", () => {
		const out = buildModels([base], [], { "qwen3.8-27b": { contextByPlan: { Pro: 262144 } } });
		assert.equal(applyPlanContext(out, "Pro")[0].contextWindow, 262144);
		assert.equal(applyPlanContext(out, "Builder")[0].contextWindow, 131072);
	});
});

import { countSince, nextHeatAt, parseSubscription, REQUEST_HEAT_HOT_MS, REQUEST_HEAT_WARM_MS, requestHeat, requestMilestone, requestSnapshot, sessionElapsed, sessionRpm, subscriptionDetailLines, subscriptionStatusText, withRequestCount, yoloDashboard, type Subscription } from "./usage.ts";

describe("parseSubscription", () => {
	it("maps plan aliases to canonical tiers", () => {
		for (const probe of ["builder", "Builder", "standard"]) {
			assert.equal(parseSubscription({ plan: probe })?.plan, "Builder", String(probe));
		}
		for (const probe of ["pro", "Pro", "premium"]) {
			assert.equal(parseSubscription({ plan: probe })?.plan, "Pro", String(probe));
		}
		for (const probe of ["free", "Free", "starter"]) {
			assert.equal(parseSubscription({ plan: probe })?.plan, "Free", String(probe));
		}
	});

	it("reads plan from nested/subscription shapes", () => {
		assert.equal(parseSubscription({ data: { subscription: { name: "Pro" } } })?.plan, "Pro");
		assert.equal(parseSubscription({ subscription: { tier: "builder" } })?.plan, "Builder");
	});

	it("extracts usage counters with tolerant keys", () => {
		const s = parseSubscription({
			plan: "pro",
			daily_remaining: "120",
			requests_per_day: 500,
			req_per_min: 10,
		})!;
		assert.equal(s.requestsRemaining, 120);
		assert.equal(s.requestsLimit, 500);
		assert.equal(s.requestsPerMin, 10);
	});

	it("returns null for payload with no plan/usage signal", () => {
		assert.equal(parseSubscription({ welcome: "hi" }), null);
		assert.equal(parseSubscription(null), null);
	});

	it("builds a human footer line", () => {
		const s: Subscription = { plan: "Pro", requestsRemaining: 120 };
		assert.match(subscriptionStatusText(s) ?? "", /Pro/);
		assert.equal(subscriptionStatusText({ plan: null }), undefined);
	});
});

describe("subscriptionDetailLines", () => {
	it("renders plan, remaining, and cap as numbers", () => {
		const lines = subscriptionDetailLines({ plan: "Pro", requestsRemaining: 120, requestsLimit: 500, requestsPerMin: 10 });
		assert.equal(lines[0], "Yolo-Auto \u00b7 Pro");
		assert.equal(lines[1], "120 remaining / 500 limit");
		assert.equal(lines[2], "10/min cap");
	});

	it("omits unknown sections and falls back to raw plan", () => {
		assert.deepEqual(subscriptionDetailLines({ plan: null, rawPlan: "weird" }), ["Yolo-Auto \u00b7 weird"]);
		assert.equal(subscriptionDetailLines({ plan: "Free", requestsRemaining: 9, requestsLimit: 10 })[1], "9 remaining / 10 limit");
	});
});
describe("withRequestCount", () => {
	it("renders numeric session + last-1m counts", () => {
		const snap = (count: number, last1m = 0) => ({ count, last1m, last8m: last1m, elapsed: "1m" });
		assert.equal(withRequestCount("Pro", snap(14, 3)), "Pro  14 req  3/1m");
		assert.equal(withRequestCount(undefined, snap(3)), "3 req");
		assert.equal(withRequestCount("Pro", snap(0)), "Pro");
		assert.equal(withRequestCount(undefined, snap(0)), undefined);
	});
});

describe("countSince / requestHeat / milestone", () => {
	it("counts timestamps from the tail", () => {
		assert.equal(countSince([10, 20, 30, 40], 25), 2);
		assert.equal(countSince([], 0), 0);
	});
	it("fades accent \u2192 success \u2192 dim", () => {
		const t0 = 1_000_000;
		assert.equal(requestHeat(undefined, t0), "dim");
		assert.equal(requestHeat(t0, t0), "accent");
		assert.equal(requestHeat(t0, t0 + REQUEST_HEAT_HOT_MS), "success");
		assert.equal(requestHeat(t0, t0 + REQUEST_HEAT_WARM_MS), "dim");
		assert.equal(nextHeatAt(t0, t0), t0 + REQUEST_HEAT_HOT_MS);
		assert.equal(nextHeatAt(t0, t0 + REQUEST_HEAT_HOT_MS), t0 + REQUEST_HEAT_WARM_MS);
		assert.equal(nextHeatAt(t0, t0 + REQUEST_HEAT_WARM_MS), null);
	});
	it("fires only on exact milestones", () => {
		assert.equal(requestMilestone(10), 10);
		assert.equal(requestMilestone(11), null);
	});
});

describe("requestSnapshot / dashboard numbers", () => {
	it("formats elapsed, rpm, and dashboard without a login", () => {
		assert.equal(sessionElapsed(0, 45_000), "45s");
		assert.equal(sessionElapsed(0, 120_000), "2m");
		assert.equal(sessionRpm(0, 0, 60_000), undefined);
		assert.equal(sessionRpm(12, 0, 60_000), "12/min");
		const now = 60_000;
		const snap = requestSnapshot([now - 1_000, now], 3, now, 0);
		assert.equal(snap.last1m, 2);
		assert.equal(snap.last8m, 2);
		assert.deepEqual(yoloDashboard({ plan: "Pro" }, snap), ["Yolo-Auto \u00b7 Pro", "session: 3", "last 1m: 2", "last 8m: 2", "3.0/min  1m"]);
		assert.deepEqual(yoloDashboard(null, snap).slice(0, 2), ["Yolo-Auto", "session: 3"]);
	});
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const realUsage = JSON.parse(readFileSync(join(__dir, "test/fixtures/real-usage.json"), "utf8"));

describe("parseSubscription against real /v1/usage", () => {
	it("maps planId pro -> Pro and requestStartsPerMinute", () => {
		const s = parseSubscription(realUsage)!;
		assert.equal(s.plan, "Pro");
		assert.equal(s.rawPlan, "pro");
		assert.equal(s.requestsPerMin, 10);
	});
});
