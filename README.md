<div align="center">

<p align="center"><img src="assets/yolo-auto-logo-mark-128.png" width="96" alt="Yolo-Auto logo" /></p>

# pi-yolo-auto

**A pi provider extension for [Yolo-Auto](https://yolo-auto.com)'s flat-rate Qwen3.8-27B API**

_Adds an OpenAI-compatible provider with auto model-catalog sync and per-session subscription (Free/Builder/Pro) usage to pi._

[![CI](https://img.shields.io/github/actions/workflow/status/ryan-brosas/pi-yolo-auto/ci.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/ryan-brosas/pi-yolo-auto/actions/workflows/ci.yml) [![Live probe](https://img.shields.io/github/actions/workflow/status/ryan-brosas/pi-yolo-auto/live-provider-probe.yml?branch=main&style=for-the-badge&label=live-probe)](https://github.com/ryan-brosas/pi-yolo-auto/actions/workflows/live-provider-probe.yml) [![Node.js](https://img.shields.io/badge/Node.js-22-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](package.json) [![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

## Run

```sh
pi --model yolo-auto/qwen3.8-27b "hello"
```

Loads the provider from the pi package registry and runs one turn against the
Yolo-Auto endpoint. The extension serves the embedded model catalog immediately
and refreshes it from `GET /models` on session start, so the first real prompt
already has a resolved model id.

## Why pi-yolo-auto?

|    | Capability                      | What it unlocks                                                                                                                                  |
|:--:|---------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| ⚡ | **Flat-rate LLM access**        | A paid Qwen3.8-27B endpoint integrated like any native pi provider, with no per-token surprise.                                                  |
| 🔄 | **Self-updating model catalog** | Stale-while-revalidate sync keeps `models.json` current without downtime or manual edits.                                                        |
| 📊 | **Subscription visibility**     | The status footer shows your tier (Free/Builder/Pro) and request counters straight from `/usage`.                                                |
| 🪟 | **Plan-aware context**          | Qwen3.8-27B reports 128K context on Free/Builder and 256K on Pro, matching the site tiers; the catalog hot-swaps when the detected plan changes. |

## How it fits

```mermaid
flowchart LR
    API1[/GET /models/] --> Sync[update-models.js]
    API2[/GET /usage/] --> Footer[(status footer)]
    Sync --> Models[models.json]
    Models --> Patch[patch.json]
    Patch --> Custom[custom-models.json]
    Custom --> Ext[index.ts provider]
    Ext --> Footer
```

The extension entry point (`index.ts`) is the composition root: it registers the
provider, owns the stale-while-revalidate loop over the embedded catalog, and
feeds the subscription footer. The pure pipeline (`models.ts`, `usage.ts`) stays
dependency-free so it is unit-testable without pi-ai.

## Available Models

| Model       | Context | Vision | Reasoning | Input $/M | Cache Read $/M | Output $/M |
|-------------|---------|--------|-----------|-----------|----------------|------------|
| Qwen3.8 27B | 131K    | ✅     | ✅        | $0.00     | $0.00          | $0.00      |

## Install

Install it through pi's package registry:

```bash
pi install npm:pi-yolo-auto
```

Then load the extension and a `yolo-auto` provider appears in `/model`:

```bash
pi update --extensions   # or restart pi
```

## Auth

Get your API key from your [Yolo-Auto account](https://yolo-auto.com), then log in from inside pi (recommended):

```bash
/login yolo-auto
```

You'll be prompted to paste the key; it is stored in `~/.pi/agent/auth.json`
(key in the `access` slot) and never printed back.

The `/login` path is the one and only auth path. No environment variable.

## Usage

```sh
pi --list-models yolo-auto
pi --model yolo-auto/qwen3.8-27b "hello"
```

Credentials are read from `~/.pi/agent/auth.json` (written by `/login`) and
resolved at request time; they are never stored by this package or printed.

## Documentation

- Configuration & data ownership: [AGENTS.md](AGENTS.md)
- Model catalog pipeline: [models.ts](models.ts)
- Subscription parser: [usage.ts](usage.ts)
- Model cache & sync: [scripts/update-models.js](scripts/update-models.js)

## License

MIT, © 2026 Ryan Brosas. Third-party licenses are listed in THIRD_PARTY_NOTICES.md
when they exist.
