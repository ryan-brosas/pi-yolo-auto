#!/usr/bin/env node
/**
 * Probe the authenticated Yolo-Auto /models and /usage endpoints.
 *
 * This intentionally does not log response bodies or credentials. The usage
 * payload is passed through the same parser used by the provider extension.
 */
import process from "node:process";
import { parseSubscription } from "../usage.ts";

const BASE_URL = (process.env.YOLO_AUTO_BASE_URL || "https://yolo-auto.com/v1").replace(/\/+$/, "");
const API_KEY = process.env.YOLO_AUTO_API_KEY || process.env.YOLO_API_KEY;
const REQUEST_TIMEOUT_MS = 5000;

if (!API_KEY) {
	console.warn("⚠ No YOLO_AUTO_API_KEY set — skipping live provider probe.");
	process.exit(0);
}

async function getJson(pathname) {
	try {
		const response = await fetch(`${BASE_URL}${pathname}`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${API_KEY}`,
			},
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await response.text();
		if (!response.ok) return { ok: false, error: `${pathname} returned HTTP ${response.status}` };
		try {
			return { ok: true, value: JSON.parse(body) };
		} catch {
			return { ok: false, error: `${pathname} returned invalid JSON` };
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { ok: false, error: `${pathname} request failed: ${detail}` };
	}
}

function modelList(payload) {
	if (Array.isArray(payload)) return payload;
	return payload && typeof payload === "object" && Array.isArray(payload.data) ? payload.data : null;
}

async function probe() {
	const modelsResponse = await getJson("/models");
	if (!modelsResponse.ok) return modelsResponse.error;
	const models = modelList(modelsResponse.value);
	if (!models?.length) return "/models returned no models";
	if (models.some((model) => !model || typeof model.id !== "string" || model.id.length === 0)) {
		return "/models returned a model without a string id";
	}
	console.log(`✓ GET /models (${models.length} models)`);

	const usageResponse = await getJson("/usage");
	if (!usageResponse.ok) return usageResponse.error;
	const subscription = parseSubscription(usageResponse.value);
	if (!subscription) return "/usage returned no recognized plan or usage fields";
	const counters = ["requestsUsed", "requestsRemaining", "requestsLimit", "requestsPerMin"]
		.filter((key) => subscription[key] !== undefined).length;
	console.log(`✓ GET /usage (plan: ${subscription.plan || "unknown"}; ${counters} counters recognized)`);
	return null;
}

const error = await probe();
if (error) {
	console.error("✗ Live provider probe failed:", error);
	process.exitCode = 1;
}
