# @superjeason/pi-model-manager

Four pi commands for managing custom model providers in `~/.pi/agent/models.json`, with models.dev-first metadata enrichment and request-header disguising.

## Commands

### `/pim:add` — interactive wizard

Adds a new OpenAI-compatible provider end-to-end:

1. Enter **provider name**, **base URL**, **API key**
2. Choose **API type** (all built-in pi formats)
3. Fetches `{baseUrl}/models` (standard OpenAI format) with a cancellable loader
4. Multi-select models (**Space** toggle, **Enter** confirm, **Esc** cancel)
   - If `/models` fetch fails, type model ids manually (comma-separated)
5. Optionally enrich config from models.dev first, then the built-in pi-ai library (same logic as `/pim:sync`)
6. Writes the provider to `models.json`

Then `/reload` and the new provider appears in `/model`.

### `/pim:edit` — modify an existing provider

Select a provider (shown with model count and baseUrl), then choose an action:

- **Change API format** — pick from built-in API types
- **Manage models**
  - Add from `/models` endpoint, or type ids manually
  - Remove existing models (multi-select + confirm)
  - Adding can enrich from models.dev first, then the built-in library
- **Edit connection** — change `baseUrl` / `apiKey`  
  (current value in the prompt; empty keeps, `-` removes, Esc cancels)
- **Enrich model config**
  - Safe: fill **missing** fields only
  - Overwrite: clear matched fields then re-fill (`reasoning` is preserved)
- **Delete provider** — remove provider and all models (confirm)

All destructive ops ask for confirmation first.

### `/pim:sync` — fill missing model config

Reads `models.json`, matches each custom model **by id** against models.dev first, then built-in models loaded at runtime, and fills fields you didn't set:

- `thinkingLevelMap` (from models.dev `reasoning_options` when available; enables `max` / `xhigh` thinking levels)
- `cost` (from models.dev `api.json` pricing → pi `{input,output,cacheRead,cacheWrite[,tiers]}` USD/1M; fills missing or all-zero placeholders)
- `compat` (from built-in pi metadata; merged, your values win)
- `maxTokens`, `contextWindow`, `reasoning`, `input` (only `text`/`image`; pdf/audio/video from models.dev are stripped), `name`

Only fills **missing** fields — anything set explicitly is preserved. Idempotent.

Matching prefers **canonical families** over reseller/gateway clones:

| bare id example | preferred family |
|---|---|
| `gpt-5.5` / `o3` | `openai` |
| `claude-*` | `anthropic` |
| `gemini-*` | `google` |
| `grok-*` | `xai` |
| `glm-*` | `zhipuai` / `zai` |
| `qwen*` / `qwq*` / `qvq*` | `alibaba` / `qwen` / `dashscope` |
| `doubao*` / `seed-1.*` | `volcengine` / `bytedance` |
| `mimo-*` / `xiaomi-mimo*` | `xiaomi` |
| `minimax*` / `abab*` | `minimax` |
| `kimi*` / `moonshot*` | `moonshotai` |

You can also set an explicit family on the provider or model:

```json
{
  "providers": {
    "cpa": {
      "modelFamily": "openai",
      "models": [
        { "id": "gpt-5.5", "modelFamily": "openai" }
      ]
    }
  }
}
```

```
/pim:sync                              # refresh models.dev and assigned tool-profile caches
/pim:sync models                       # refresh/use models.dev only
/pim:sync tool=kilo                    # overlay providers assigned metadataTool=kilo
/pim:sync tool=codex                   # overlay providers assigned metadataTool=codex
/pim:sync provider=cpa tool=kilo       # one-run Kilo override for provider cpa only
/pim:sync models preview               # preview models.dev-only result
/pim:sync provider=cpa tool=kilo preview
/pim:sync status                       # show cache timestamps
/pim:sync help                         # explain modes and provider assignment
```

Tab completion is available for `models`, `tool=...`, `provider=...`, `preview`, and `status`. Every sync refreshes models.dev and the selected/assigned tool catalog cache; `preview` skips only the models.json write. Existing metadata fields are replaced by the newly resolved model and route data on each sync.

### `/pim:headers` — manage request headers

Makes pi's outgoing requests look like they come from the official **Codex CLI** or **Claude Code** CLI, by writing a `headers` map onto the provider in `models.json`. pi's core natively merges configured `headers` into every request and they override pi's default `User-Agent: pi-coding-agent`. Header values support `$ENV_VAR` interpolation and `!cmd` shell commands (same resolution as API keys).

Flow:
1. Select a provider (the label shows whether it is already disguised and how many headers are set)
2. Choose a preset:
   - **Codex CLI** — `originator: codex_cli_rs`, `User-Agent: codex_cli_rs/<ver> (Arch Unknown; x86_64) kitty`, `OpenAI-Beta: responses=experimental`
   - **Claude Code** — `anthropic-version: 2023-06-01`, `anthropic-beta: <full token list>`, `x-app: cli`, `User-Agent: claude-cli/<ver> (external, cli)`, `anthropic-client-platform: claude-code`
   - **Custom headers** — enter `Key: Value` (or `Key=Value`) lines, blank line to finish
   - **Clear disguise** — remove `provider.headers` entirely
   - **Cancel**
3. For Codex/Claude presets: enter a version for the `User-Agent` (pre-filled with a default), then optionally merge extra/override headers on top
4. Preview the current → new header diff
5. Confirm and write; run `/reload`

The Codex preset targets `openai-responses` providers (originator + `OpenAI-Beta`). The Claude preset targets `anthropic-messages` providers (`anthropic-version`/`anthropic-beta`). Applying a Claude preset to an OpenAI-format provider is allowed but won't make sense — pick the preset that matches the upstream's expected protocol.

Default versions (`DEFAULT_CODEX_VERSION`, `DEFAULT_CLAUDE_VERSION`) and the `anthropic-beta` token list are constants at the top of `index.ts`; edit them to keep current.

## Why

Custom providers don't inherit authoritative model metadata. models.dev exposes model limits (`context`, `output`), modalities, `reasoning`, and provider-level `reasoning_options`; pi's built-in registry can also provide `compat` details. Without `thinkingLevelMap`, the `max` / `xhigh` thinking levels may be unavailable or clamped. These commands fill that in by matching model ids.

## Install

```bash
pi install git:github.com/superjeason/pi-model-manager
# or
pi install npm:@superjeason/pi-model-manager
# or local path
pi install ./pi-model-manager
```

Then `/reload`.

## Multi-select controls

| Key | Action |
|-----|--------|
| Space | Toggle current item |
| ↑ / ↓ | Move cursor |
| PageUp / PageDown | Page |
| Home / End | First / last |
| Enter | Confirm selection |
| Esc / Ctrl+C | Cancel (uses pi's `tui.select.cancel` plus low-level `matchesKey("escape")`; returns without changes) |
| type | Filter list (Unicode supported) |
| Backspace | Clear filter char |
| Ctrl+A | Select all **visible** (uses low-level `matchesKey("ctrl+a")`) |
| Ctrl+D | Deselect all (uses low-level `matchesKey("ctrl+d")`) |

Selection is tracked by model id, so filtering does not scramble checks.
In non-TUI modes (RPC/print), falls back to one-by-one Add/Skip prompts.
**Cancel is never treated as "fall back to one-by-one".**

## Requirements & Notes

- `/pim:add` prefers a standard OpenAI-compatible `/models` endpoint
  (`GET {baseUrl}/models` → `{"data":[{"id":"..."}]}`).  
  `baseUrl` with or without trailing `/v1` both work.  
  If the endpoint is missing (e.g. anthropic-messages / google-generative-ai), type ids manually.
- The API format picker is built **dynamically at runtime** from pi's api-provider
  registry (`getApiProviders()` from `@earendil-works/pi-ai/compat`), so it always
  matches the running pi: the 10 built-in formats (`openai-completions`,
  `openai-responses`, `anthropic-messages`, `google-generative-ai`, `google-vertex`,
  `mistral-conversations`, `openai-codex-responses`, `azure-openai-responses`,
  `bedrock-converse-stream`, `pi-messages`) plus any custom API types registered by
  other extensions. No hardcoded list to go stale.
- `models.json` must be pure JSON (no `//` comments).
- Overwriting an existing provider prompts for confirmation; other providers untouched.
- Enrich only adds missing fields; manual edits are never clobbered (unless you choose overwrite / `/pim:sync force`).
- Metadata source order: models.dev `models.json` + `api.json` first (canonical family preferred), then pi built-in registry.
- Bare ids like `gpt-5.5` prefer `openai/gpt-5.5` over reseller copies (`vivgrid`, `302ai`, …).
- Optional `modelFamily` on provider or model overrides family inference.
- `cost` is filled when missing or all zeros (common custom-provider placeholders); non-zero user costs are kept.
- models.dev `models.json` has limits/modalities; pricing usually comes from `api.json` and is merged in.
- `/pim:sync` always fetches models.dev `models.json` + `api.json`, replaces their cache snapshots, and resolves every configured model anew. Assigned tool profiles overlay only the effective `contextWindow`/`maxTokens` for a strongly matched provider route; other fields remain from models.dev or Pi built-ins.
- Assign a profile per provider with `metadataTool` in `models.json` (`codex`, `kilo`, `gemini-cli`, or `antigravity`). A one-run override is scoped explicitly with `provider=<name> tool=<tool>`; `/pim:sync tool=kilo` applies only to providers already assigned/inferred as Kilo. Set `metadataTool` explicitly for predictable persistent behavior.
- `/pim:sync models` refreshes and uses models.dev without tool overlays. Preview still refreshes/replaces source caches but does not write `models.json`; sync writes the refreshed resolution even if values match the previous file.
- Kilo data comes from `https://api.kilo.ai/api/gateway/models`; route IDs must match before it overrides. Codex context profiles refresh from the public `openai/codex` bundled `models.json`; account-specific Codex runtime catalogs are not available without authentication. The bundled profile is isolated to providers assigned `metadataTool: "codex"`. Gemini CLI uses its official model token limits. Antigravity IDE/CLI effective context is not publicly specified, so its profile retains models.dev model limits and labels the harness cap unknown (no 135K managed-agent threshold is applied to the IDE/CLI).
- Metadata caches live in `~/.cache/pi-model-manager/`; `/pim:sync status` shows timestamps. On fetch failure, the last cached snapshot is retained and the report identifies its provenance.
- Uses pi theme tokens for multi-select colors and focus state (`selectedBg`, `accent`, `success`, `dim`, `muted`, `warning`).
- Focused rows use a full-width `selectedBg` band plus an accent bar (`▌`); checked rows use `[x]` without stealing focus.
- Runtime deps: Node built-ins only; peer: `@earendil-works/pi-coding-agent` (provides `pi-tui`).

## Structure

```
pi-model-manager/
├── index.ts         # /pim:add + /pim:edit + /pim:sync + /pim:headers
├── enrich.ts        # shared model-matching & config-filling
├── multi-select.ts  # themed multi-select TUI component
├── package.json
└── README.md
```
