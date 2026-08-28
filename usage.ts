
// Pure, dependency-free subscription/usage parsing for Yolo-Auto.
// The exact /v1/usage response shape is not documented, so the parser is
// defensive: it accepts several plausible shapes, maps the plan to the site's
// real tiers (Free/Builder/Pro), and degrades to null.

export type YoloPlan = "Free" | "Builder" | "Pro" | null;

export interface Subscription {
plan: YoloPlan;
rawPlan?: string;
requestsUsed?: number;
requestsRemaining?: number;
requestsLimit?: number;
requestsPerMin?: number;
}

const FREE_ALIASES = new Set(["free", "freeplan", "starter", "trial", "hobby"]);
const BUILDER_ALIASES = new Set(["builder", "standard"]);
const PRO_ALIASES = new Set(["pro", "premium", "team"]);

function slug(v: unknown): string {
return String(v ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function lookupPlan(v: unknown): YoloPlan {
if (v == null) return null;
if (typeof v === "object") {
	const o = v as Record<string, unknown>;
	return lookupPlan(o.name ?? o.tier ?? o.id ?? o.label ?? o.key);
}
const key = slug(v);
if (!key) return null;
if (FREE_ALIASES.has(key)) return "Free";
if (BUILDER_ALIASES.has(key)) return "Builder";
if (PRO_ALIASES.has(key)) return "Pro";
if (/\bpro\b/.test(key)) return "Pro";
if (/builder/.test(key)) return "Builder";
if (/\bfree\b/.test(key)) return "Free";
return null;
}

function findFirst(obj: Record<string, unknown>, keys: string[]): unknown {
for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
return undefined;
}

function toNum(v: unknown): number | undefined {
if (typeof v === "number" && Number.isFinite(v)) return v;
if (typeof v === "string") {
	const n = Number(v.replace(/[^0-9.+-]/g, ""));
	return Number.isFinite(n) ? n : undefined;
}
return undefined;
}

function findNum(obj: Record<string, unknown>, keys: string[]): number | undefined {
for (const k of keys) {
	const n = toNum(obj[k]);
	if (n !== undefined) return n;
}
return undefined;
}

// Flatten nested objects into one lowercased-key map for tolerant lookup.
function flatten(obj: Record<string, unknown>, seen = new Set<object>()): Record<string, unknown> {
const out: Record<string, unknown> = {};
if (seen.has(obj)) return out;
seen.add(obj);
for (const [k, v] of Object.entries(obj)) {
	out[k.toLowerCase().replace(/[\s_-]+/g, "")] = v;
	if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, seen));
}
return out;
}

export function parseSubscription(payload: unknown): Subscription | null {
if (!payload || typeof payload !== "object") return null;
const flat = flatten(payload as Record<string, unknown>);

const planField = findFirst(flat, ["plan", "planname", "planid", "subscription", "tier", "name", "type"]);
const plan = lookupPlan(planField);
const rawPlan = typeof planField === "string" ? planField : undefined;

const requestsUsed = findNum(flat, ["requestsused", "usedrequests", "messagesused", "totalrequests", "requests"]);
const requestsRemaining = findNum(flat, ["requestsremaining", "remaining", "remainingrequests", "dailyremaining"]);
const requestsLimit = findNum(flat, ["requestslimit", "limit", "dailylimit", "maxrequests", "requestsperday"]);
const requestsPerMin = findNum(flat, ["reqpermin", "requestspermin", "rpm"]);

if (!plan && requestsUsed === undefined && requestsRemaining === undefined && requestsLimit === undefined) return null;

return { plan, rawPlan, requestsUsed, requestsRemaining, requestsLimit, requestsPerMin };
}

export function subscriptionStatusText(s: Subscription): string | undefined {
const parts: string[] = [];
if (s.plan) parts.push(s.plan);
if (s.requestsRemaining != null) parts.push("\u2194 " + s.requestsRemaining);
if (s.requestsPerMin != null) parts.push("\u221a/min " + s.requestsPerMin);
return parts.length ? parts.join("  ") : undefined;
}
