// Pure, dependency-free subscription/usage parsing for Yolo-Auto.
// The exact /v1/usage response shape is not documented, so the parser is
// defensive: it accepts several plausible shapes, maps the plan to the site's
// real tiers (Free/Builder/Pro), and degrades to null.

export type PlanTier = "Free" | "Builder" | "Pro";
export type YoloPlan = PlanTier | null;

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
	const requestsPerMin = findNum(flat, ["reqpermin", "requestspermin", "rpm", "requeststartsperminute"]);

	if (!plan && requestsUsed === undefined && requestsRemaining === undefined && requestsLimit === undefined) return null;

	return { plan, rawPlan, requestsUsed, requestsRemaining, requestsLimit, requestsPerMin };
}

export function subscriptionStatusText(s: Subscription): string | undefined {
	return s.plan ?? s.rawPlan ?? undefined;
}

export function subscriptionDetailLines(s: Subscription): string[] {
	const lines: string[] = [`Yolo-Auto \u00b7 ${s.plan ?? s.rawPlan ?? "unknown plan"}`];
	if (s.requestsRemaining != null || s.requestsLimit != null) {
		const bits: string[] = [];
		if (s.requestsRemaining != null) bits.push(`${s.requestsRemaining} remaining`);
		if (s.requestsLimit != null) bits.push(`${s.requestsLimit} limit`);
		lines.push(bits.join(" / "));
	}
	if (s.requestsPerMin != null) lines.push(`${s.requestsPerMin}/min cap`);
	return lines;
}

export const COUNT_WINDOW_MS = 8 * 60_000;
export const COUNT_RECENT_MS = 60_000;

export function countSince(times: number[], since: number): number {
	let n = 0;
	for (let i = times.length - 1; i >= 0; i--) {
		if (times[i] < since) break;
		n++;
	}
	return n;
}

export function sessionElapsed(startedAt: number, now: number): string {
	const s = Math.max(0, Math.floor((now - startedAt) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function sessionRpm(count: number, startedAt: number, now: number): string | undefined {
	const elapsed = now - startedAt;
	if (count <= 0 || elapsed < 30_000) return undefined;
	const rpm = count / (elapsed / 60_000);
	return `${rpm >= 10 ? rpm.toFixed(0) : rpm.toFixed(1)}/min`;
}

export interface RequestSnapshot {
	count: number;
	last1m: number;
	last8m: number;
	elapsed: string;
	rpm?: string;
}

export function requestSnapshot(times: number[], count: number, now: number, startedAt: number): RequestSnapshot {
	return {
		count,
		last1m: countSince(times, now - COUNT_RECENT_MS),
		last8m: countSince(times, now - COUNT_WINDOW_MS),
		elapsed: sessionElapsed(startedAt, now),
		rpm: sessionRpm(count, startedAt, now),
	};
}

// Footer: "Pro  14 req  3/1m"
export function withRequestCount(plan: string | undefined, snap: RequestSnapshot): string | undefined {
	if (snap.count <= 0) return plan;
	const parts: string[] = [];
	if (plan) parts.push(plan);
	parts.push(`${snap.count} req`);
	if (snap.last1m > 0) parts.push(`${snap.last1m}/1m`);
	return parts.join("  ");
}

export const REQUEST_HEAT_HOT_MS = 20_000;
export const REQUEST_HEAT_WARM_MS = 60_000;
export type RequestHeat = "accent" | "success" | "dim";

export function requestHeat(lastAt: number | undefined, now: number): RequestHeat {
	if (lastAt == null) return "dim";
	const age = now - lastAt;
	if (age < REQUEST_HEAT_HOT_MS) return "accent";
	if (age < REQUEST_HEAT_WARM_MS) return "success";
	return "dim";
}

export function nextHeatAt(lastAt: number | undefined, now: number): number | null {
	if (lastAt == null) return null;
	const age = now - lastAt;
	if (age < REQUEST_HEAT_HOT_MS) return lastAt + REQUEST_HEAT_HOT_MS;
	if (age < REQUEST_HEAT_WARM_MS) return lastAt + REQUEST_HEAT_WARM_MS;
	return null;
}

export const REQUEST_MILESTONES = [10, 25, 50, 100, 250, 500, 1000] as const;

export function requestMilestone(n: number): number | null {
	return (REQUEST_MILESTONES as readonly number[]).includes(n) ? n : null;
}

export function yoloDashboard(sub: Subscription | null, snap: RequestSnapshot): string[] {
	const lines = sub ? subscriptionDetailLines(sub) : ["Yolo-Auto"];
	lines.push(`session: ${snap.count}`);
	lines.push(`last 1m: ${snap.last1m}`);
	lines.push(`last 8m: ${snap.last8m}`);
	lines.push(snap.rpm ? `${snap.rpm}  ${snap.elapsed}` : snap.elapsed);
	return lines;
}
