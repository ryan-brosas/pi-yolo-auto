#!/usr/bin/env node
/**
 * Update Yolo-Auto models from the provider API.
 *
 * Fetches https://yolo-auto.com/v1/models (requires YOLO_AUTO_API_KEY — the
 * endpoint returns 401 without it) and updates:
 * - models.json: pure API model definitions (no patches baked in)
 * - deprecated-models.json: models the API delisted, stamped deprecatedAt,
 *   served for a 14-day grace period by the runtime then evicted
 * - README.md: model table with patch.json + custom-models.json applied
 *
 * Source files to edit instead:
 *   patch.json          — per-model overrides (reasoning, compat, cost, thinking)
 *   custom-models.json  — models not in the provider API
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_API_URL = "https://yolo-auto.com/v1/models";
const MODELS_JSON_PATH = path.join(__dirname, "..", "models.json");
const PATCH_JSON_PATH = path.join(__dirname, "..", "patch.json");
const CUSTOM_MODELS_JSON_PATH = path.join(__dirname, "..", "custom-models.json");
const README_PATH = path.join(__dirname, "..", "README.md");
const DEPRECATED_MODEL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const KEY = process.env.YOLO_AUTO_API_KEY || process.env.YOLO_API_KEY || undefined;

function convertPricing(v) {
	if (!v) return 0;
	const n = parseFloat(v);
	return Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0;
}

function applyPatch(model, patch) {
	const result = { ...model };
	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
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

function buildModels(base, custom, patch) {
	const map = new Map();
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

function transformModel(apiModel, existingMap) {
	const id = apiModel.id;
	const inCost = convertPricing(apiModel.pricing?.prompt);
	const outCost = convertPricing(apiModel.pricing?.completion);
	const cacheCost = convertPricing(apiModel.pricing?.cache_prompt);
	const hasReasoning = apiModel.reasoning_effort === true || apiModel.custom_reasoning === true || apiModel.reasoning === true;
	const isFree = inCost === 0 && outCost === 0;
	if (existingMap[id]) {
		const existing = { ...existingMap[id] };
		if (inCost > 0) existing.cost.input = inCost;
		if (outCost > 0) existing.cost.output = outCost;
		if (cacheCost > 0) existing.cost.cacheRead = cacheCost;
		if (apiModel.context_length) existing.contextWindow = apiModel.context_length;
		if (apiModel.max_completion_tokens) existing.maxTokens = apiModel.max_completion_tokens;
		if (hasReasoning) existing.reasoning = true;
		return existing;
	}
	const name = (apiModel.name || id).replace(/^[^:]+:\s*/, "");
	return {
		id,
		name,
		reasoning: hasReasoning,
		input: ["text"],
		cost: { input: inCost, output: outCost, cacheRead: cacheCost, cacheWrite: 0 },
		contextWindow: apiModel.context_length || 131072,
		maxTokens: apiModel.max_completion_tokens || apiModel.context_length || 16384,
	};
}

function loadJson(filePath) {
	try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
	catch { return {}; }
}

function formatContextWindow(n) {
	if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}K`;
	return String(n);
}

function generateReadmeTable(models) {
	const lines = [
		"| Model | Context | Vision | Reasoning | Input $/M | Cache Read $/M | Output $/M |",
		"|-------|---------|--------|-----------|-----------|-----------------|------------|",
	];
	for (const m of models) {
		const vision = m.input.includes("image") ? "✅" : "❌";
		const reasoning = m.reasoning ? "✅" : "❌";
		lines.push(`| ${m.name} | ${formatContextWindow(m.contextWindow)} | ${vision} | ${reasoning} | $${(m.cost?.input || 0).toFixed(2)} | $${(m.cost?.cacheRead || 0).toFixed(2)} | $${(m.cost?.output || 0).toFixed(2)} |`);
	}
	return lines.join("\n");
}

function updateReadme(models) {
	let readme = fs.readFileSync(README_PATH, "utf8");
	const newTable = generateReadmeTable(models);
	const tableRegex = /(## Available Models\n\n)\| Model \| Context \| Vision \| Reasoning \| Input \$\/M \| Cache Read \$\/M \| Output \$\/M \|\n\|[-| ]+\|(\n\|[^\n]*\|)*/;
	if (tableRegex.test(readme)) {
		readme = readme.replace(tableRegex, (match, header) => `${header}${newTable}

`);
		if (DRY_RUN) { console.log("[dry-run] would write README table"); } else fs.writeFileSync(README_PATH, readme);
		console.log("✓ Updated README.md");
	} else {
		console.warn("⚠ Could not find model table in \"## Available Models\" section");
	}
}

function updateDeprecatedModels(oldModels, newIds) {
	const deprecatedPath = path.join(path.dirname(MODELS_JSON_PATH), "deprecated-models.json");
	let deprecated = {};
	try {
		const p = JSON.parse(fs.readFileSync(deprecatedPath, "utf8"));
		if (p && typeof p === "object" && !Array.isArray(p)) deprecated = p;
	} catch { /* no graveyard yet */ }
	const now = new Date().toISOString();
	const added = [], resurrected = [], evicted = [];
	for (const old of oldModels) {
		if (old && old.id && !newIds.has(old.id) && !deprecated[old.id]) {
			deprecated[old.id] = { ...old, deprecatedAt: now };
			added.push(old.id);
		}
	}
	for (const [id, entry] of Object.entries(deprecated)) {
		if (newIds.has(id)) { delete deprecated[id]; resurrected.push(id); continue; }
		const at = Date.parse(entry && entry.deprecatedAt ? entry.deprecatedAt : "");
		if (Number.isNaN(at) || Date.now() - at > DEPRECATED_MODEL_TTL_MS) { delete deprecated[id]; evicted.push(id); }
	}
	if (added.length || resurrected.length || evicted.length) {
		fs.writeFileSync(deprecatedPath, JSON.stringify(deprecated, null, 2) + "\n");
		console.log("Updated deprecated-models.json " + JSON.stringify({ added, resurrected, evicted }));
	}
}

function activeDeprecatedForReadme() {
	const deprecatedPath = path.join(path.dirname(MODELS_JSON_PATH), "deprecated-models.json");
	let deprecated = {};
	try {
		const p = JSON.parse(fs.readFileSync(deprecatedPath, "utf8"));
		if (p && typeof p === "object" && !Array.isArray(p)) deprecated = p;
	} catch { /* none */ }
	const now = Date.now();
	const out = [];
	for (const e of Object.values(deprecated)) {
		if (!e || !e.id) continue;
		const at = Date.parse(e.deprecatedAt || "");
		if (Number.isNaN(at) || now - at > DEPRECATED_MODEL_TTL_MS) continue;
		const m = { ...e }; delete m.deprecatedAt; out.push(m);
	}
	return out;
}


const DRY_RUN = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";

async function main() {
	console.log("Fetching models from " + MODELS_API_URL + "...");
	if (!KEY) console.warn("⚠ No YOLO_AUTO_API_KEY set — the endpoint likely returns 401.");
	try {
		const res = await fetch(MODELS_API_URL, { headers: KEY ? { Authorization: "Bearer " + KEY } : {} });
		if (!res.ok) throw new Error("HTTP " + res.status);
		const api = await res.json();
		const list = Array.isArray(api) ? api : (api.data || []);
		if (!Array.isArray(list) || list.length === 0) throw new Error("No models array in response");
		console.log("✓ Fetched " + list.length + " models");

		const existing = Array.isArray(loadJson(MODELS_JSON_PATH)) ? loadJson(MODELS_JSON_PATH) : [];
		const existingMap = {};
		for (const m of existing) existingMap[m.id] = m;

		let transformed = list.map((m) => transformModel(m, existingMap));
		transformed.sort((a, b) => a.id.localeCompare(b.id));

		const newIds = new Set(transformed.map((m) => m.id));
		updateDeprecatedModels(existing, newIds);
		if (DRY_RUN) { console.log("[dry-run] would write models.json (" + transformed.length + " models)"); } else fs.writeFileSync(MODELS_JSON_PATH, JSON.stringify(transformed, null, 2) + "\n");
		console.log("✓ Updated models.json (pure API data)");

	const patch = loadJson(PATCH_JSON_PATH);
	const custom = Array.isArray(loadJson(CUSTOM_MODELS_JSON_PATH)) ? loadJson(CUSTOM_MODELS_JSON_PATH) : [];
	const readmeModels = buildModels([...transformed, ...activeDeprecatedForReadme()], custom, patch);
	readmeModels.sort((a, b) => a.name.localeCompare(b.name));
	updateReadme(readmeModels);

	console.log("\n--- Summary ---");
	console.log("Total models: " + readmeModels.length);
	console.log("Reasoning models (patched): " + readmeModels.filter((m) => m.reasoning).length);
	console.log("Vision models: " + readmeModels.filter((m) => m.input.includes("image")).length);
	} catch (error) {
		console.error("Error:", error.message);
		process.exit(1);
	}
}

main();