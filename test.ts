/**
 * Unit tests for pi-yolo-auto — offline, no live endpoint, no pi-ai dependency.
 * Run: npm test  (node --experimental-strip-types --test test.ts)
 */
import { describe, it } from "node:test";
import assert from "node:assert";

import { applyPatch, buildModels, parsePrice, toApiModel, transformApiModel, type JsonModel } from "./models.ts";

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


import { parseSubscription, subscriptionStatusText, type Subscription } from "./usage.ts";

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
