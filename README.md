# pi-yolo-auto

[![CI](https://github.com/OWNER/pi-yolo-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/pi-yolo-auto/actions/workflows/ci.yml)
[![Live probe](https://github.com/OWNER/pi-yolo-auto/actions/workflows/live-provider-probe.yml/badge.svg)](https://github.com/OWNER/pi-yolo-auto/actions/workflows/live-provider-probe.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

A **pi provider extension** for the [Yolo-Auto](https://yolo-auto.com) flat-rate
Qwen3.8-27B API (OpenAI-compatible): auto model-discovery sync plus
subscription (Free/Builder/Pro) usage in the footer.

## Features

- OpenAI-compatible provider via `openai-completions` at `https://yolo-auto.com/v1`.
- **Stale-while-revalidate model sync**: serves embedded `models.json` instantly, refreshes
  from `GET /models` on session, hot-swaps via re-registration.
- **Overlay + deprecation**: `patch.json`, `custom-models.json`, 14-day grace on delisted
  models (`deprecated-models.json`).
- **Subscription detection**: probes `GET /usage` and shows Free/Builder/Pro + request
  counters in the status footer.
- **Dependency-free core**: pure pipeline (`models.ts`, `usage.ts`) unit-tested offline.

## Install

Wire into pi's `packages` in `~/.pi/agent/settings.json`, then `pi update --extensions`.

## Auth — two coequal paths

1. **auth.json** (`~/.pi/agent/auth.json`):
   ```json
   { "yolo-auto": { "type": "api_key", "key": "sk-..." } }
   ```
2. **Environment**: `export YOLO_AUTO_API_KEY=sk-...`

The models endpoint returns `401` without a key — configure one before first use.

## Usage

```bash
pi --list-models yolo-auto
pi --model yolo-auto/qwen3.8-27b "hello"
```

## Development

```bash
npm install
npm test                   # offline unit tests
npm run check              # syntax check all files
npm run typecheck          # strict pure-pipeline typecheck
npm run verify             # check + typecheck + test
npm run update-models -- --dry-run
npm run update-models      # sync models.json (needs YOLO_AUTO_API_KEY)
```

## CI

- `ci.yml` — every push/PR: syntax, unit tests (Node 22/24), typecheck, JSON validation.
- `live-provider-probe.yml` — opt-in (manual/schedule): live /models + /usage verify;
  needs the `YOLO_AUTO_API_KEY` repository secret.

## License

MIT
