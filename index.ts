/**
 * @superjeason/pi-model-manager
 *
 * Commands share one "match models.dev / built-in model by id and fill missing fields" path:
 *
 *   /pim:add      Add an OpenAI-compatible provider
 *   /pim:edit     Edit an existing provider
 *   /pim:sync     Sync model metadata
 *
 * Only missing fields are filled; existing values are preserved. Idempotent.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Container, type AutocompleteItem } from "@earendil-works/pi-tui";
import { getApiProviders } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  clearEnrichableFields,
  createEnrichContext,
  createToolEnrichContext,
  getMetadataCacheStatus,
  refreshKiloProfileCache,
  refreshCodexProfileCache,
  enrichModel,
  type EnrichContext,
  type EnrichSource,
  type LikeModel,
  type ModelsJsonConfig,
  type ProviderConfig,
  type ToolProfile,
} from "./enrich.js";
import { MultiSelect, type MultiSelectItem, type MultiSelectTheme } from "./multi-select.js";

const MODELS_JSON = () => join(homedir(), ".pi", "agent", "models.json");

const SYNC_MODEL_ARGUMENTS: AutocompleteItem[] = [
  { value: "tool=kilo", label: "tool=kilo", description: "Use the matching Kilo Gateway route profile" },
  { value: "tool=kilo preview", label: "tool=kilo preview", description: "Preview Kilo profile sync" },
  { value: "tool=codex", label: "tool=codex", description: "Use Codex profile where provider metadataTool is codex" },
  { value: "tool=codex preview", label: "tool=codex preview", description: "Preview Codex profile sync" },
  { value: "tool=gemini-cli", label: "tool=gemini-cli", description: "Use Gemini CLI limits where provider metadataTool is gemini-cli" },
  { value: "tool=gemini-cli preview", label: "tool=gemini-cli preview", description: "Preview Gemini CLI profile sync" },
  { value: "tool=antigravity", label: "tool=antigravity", description: "Keep models.dev specs; Antigravity IDE/CLI cap unknown" },
  { value: "models", label: "models", description: "Use models.dev metadata only" },
  { value: "models preview", label: "models preview", description: "Preview models.dev-only sync" },
  { value: "preview", label: "preview", description: "Show what would change without writing models.json" },
  { value: "dry-run", label: "dry-run", description: "Alias for preview" },
  { value: "dryrun", label: "dryrun", description: "Alias for preview" },
  { value: "force", label: "force", description: "Clear enrichable fields, then re-match (rewrites thinkingLevelMap etc.)" },
  { value: "force preview", label: "force preview", description: "Preview after refreshing selected metadata sources" },
  { value: "status", label: "status", description: "Show current cached metadata source status" },
  { value: "help", label: "help", description: "Show sync modes and per-provider tool-profile assignment" },
];

function completeSyncModelArgs(prefix: string): AutocompleteItem[] | null {
  const p = prefix.trimStart().toLowerCase();
  const filtered = SYNC_MODEL_ARGUMENTS.filter((item) => item.value.startsWith(p));
  return filtered.length > 0 ? filtered : null;
}

/**
 * Multi-select dialog (TUI).
 * Returns:
 *   string[] — confirmed selection (may be empty)
 *   null     — cancelled (Esc / Ctrl+C) OR TUI unavailable / error
 * Callers must not treat null as "fall back to one-by-one".
 */
async function multiSelectItems(
  ctx: { mode: string; ui: any },
  title: string,
  items: MultiSelectItem[],
): Promise<string[] | null> {
  if (ctx.mode !== "tui") return null;
  if (items.length === 0) return [];
  try {
    return await ctx.ui.custom<string[] | null>((tui: any, theme: any, keybindings: any, done: (v: string[] | null) => void) => {
      const th: MultiSelectTheme = {
        title: (s) => theme.fg("accent", theme.bold(s)),
        accent: (s) => theme.fg("accent", s),
        success: (s) => theme.fg("success", s),
        dim: (s) => theme.fg("dim", s),
        muted: (s) => theme.fg("muted", s),
        warning: (s) => theme.fg("warning", s),
        bold: (s) => theme.bold(s),
        // Full-row highlight — same token pi uses for selectors
        row: (s) => theme.bg("selectedBg", s),
        rowText: (s) => theme.fg("text", s),
      };

      const container = new Container();
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      const ms = new MultiSelect({
        items,
        title,
        maxVisible: Math.min(20, Math.max(8, items.length)),
        theme: th,
        keybindings,
        onDirty: () => tui.requestRender(),
        done: (val) => done(val),
      });
      container.addChild(ms);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      return {
        render: (w: number) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          ms.handleInput(data);
          tui.requestRender();
        },
      };
    });
  } catch {
    return null;
  }
}

/** One-by-one yes/no fallback for non-TUI modes. Returns null if cancelled mid-way. */
async function selectOneByOne(
  ui: any,
  ids: string[],
  yesLabel: string,
  noLabel: string,
  promptFor: (id: string) => string,
): Promise<string[] | null> {
  const out: string[] = [];
  for (const id of ids) {
    const choice = await ui.select(promptFor(id), [yesLabel, noLabel], {});
    if (choice === undefined) return null; // cancelled
    if (choice === yesLabel) out.push(id);
  }
  return out;
}

/**
 * Pick models: prefer multi-select TUI; only fall back to one-by-one when
 * multi-select is unavailable (non-TUI / component error), never on user cancel.
 */
async function pickModels(
  ctx: { mode: string; ui: any },
  title: string,
  ids: string[],
  mode: "add" | "delete",
): Promise<string[] | null> {
  const items: MultiSelectItem[] = ids.map((id) => ({ value: id, label: id }));
  // Try multi-select only in TUI; null means unavailable OR cancelled.
  // Distinguish by: if TUI and custom works, cancel returns null from done().
  // If non-TUI, multiSelectItems returns null immediately → fall back.
  if (ctx.mode === "tui") {
    const result = await multiSelectItems(ctx, title, items);
    // multiSelectItems only returns null on cancel or hard failure.
    // Empty array is a valid "confirmed nothing".
    // On hard failure (catch), also null — fall back below only if we detect
    // that custom UI never ran. We treat null as cancel in TUI (user intent).
    return result;
  }
  // Non-TUI fallback
  if (mode === "add") {
    return selectOneByOne(
      ctx.ui,
      ids,
      "Add",
      "Skip",
      (id) => `Add model?  [${id}]`,
    );
  }
  return selectOneByOne(
    ctx.ui,
    ids,
    "Delete",
    "Keep",
    (id) => `Delete model?  [${id}]`,
  );
}

/** Fetch /models with a cancellable bordered loader in TUI; plain fetch otherwise. */
async function fetchModelsWithUI(
  ctx: { mode: string; ui: any },
  baseUrl: string,
  apiKey: string,
): Promise<{ models: RemoteModel[]; error?: string; cancelled?: boolean }> {
  if (ctx.mode === "tui") {
    try {
      return await ctx.ui.custom<{ models: RemoteModel[]; error?: string; cancelled?: boolean }>(
        (tui: any, theme: any, _kb: any, done: (v: any) => void) => {
          const loader = new BorderedLoader(tui, theme, "Fetching model list…");
          loader.onAbort = () => done({ models: [], cancelled: true });
          fetchModels(baseUrl, apiKey, loader.signal)
            .then((models) => done({ models }))
            .catch((e: Error) => {
              if (e.name === "AbortError") done({ models: [], cancelled: true });
              else done({ models: [], error: e.message });
            });
          return loader;
        },
      );
    } catch (e) {
      return { models: [], error: (e as Error).message };
    }
  }
  try {
    const models = await fetchModels(baseUrl, apiKey);
    return { models };
  } catch (e) {
    return { models: [], error: (e as Error).message };
  }
}

/** Curated one-line descriptions for the built-in pi API formats. */
const API_LABELS: Record<string, string> = {
  "openai-completions": "Chat Completions (most proxies / local servers, recommended)",
  "openai-responses": "Responses API (native OpenAI)",
  "anthropic-messages": "Anthropic Messages API",
  "google-generative-ai": "Google Generative AI",
  "google-vertex": "Vertex AI",
  "mistral-conversations": "Mistral Conversations API",
  "openai-codex-responses": "Codex Responses (subscription)",
  "azure-openai-responses": "Azure OpenAI Responses",
  "bedrock-converse-stream": "AWS Bedrock Converse",
  "pi-messages": "pi Messages protocol (Radius gateway)",
};

/**
 * API formats available at runtime.
 *
 * Read live from pi's api-provider registry instead of a hardcoded list, so the
 * picker always matches the running pi: the 10 built-in formats (BUILTIN_APIS in
 * @earendil-works/pi-ai/compat, incl. `pi-messages`) plus any custom API types
 * registered by other extensions via registerApiProvider(). The registry is
 * populated before extensions load, so built-ins come first in canonical order.
 */
function getApiChoices(): { id: string; label: string }[] {
  const apis = getApiProviders();
  if (apis.length === 0) {
    // Defensive fallback if the registry is unavailable: known built-ins only.
    return Object.entries(API_LABELS).map(([id, desc]) => ({ id, label: `${id} — ${desc}` }));
  }
  return apis.map((p) => {
    const desc = API_LABELS[p.api];
    return desc
      ? { id: p.api, label: `${p.api} — ${desc}` }
      : { id: p.api, label: `${p.api} — custom API (registered by extension)` };
  });
}

function loadConfig(path: string): ModelsJsonConfig {
  if (!existsSync(path)) return { providers: {} };
  return JSON.parse(readFileSync(path, "utf-8")) as ModelsJsonConfig;
}

function saveConfig(path: string, config: ModelsJsonConfig): void {
  writeFileSync(path, JSON.stringify(config, null, 4) + "\n", "utf-8");
}

function apiIdFromLabel(label: string): string {
  return label.split(" —")[0].trim();
}

function sourceLabel(src: EnrichSource): string {
  return src.sourceLabel ?? src.provider ?? "metadata";
}

function sourceRef(src: EnrichSource): string {
  return `${sourceLabel(src)}/${src.id}`;
}

function inferToolForProvider(name: string, cfg: ProviderConfig): ToolProfile | undefined {
  if (cfg.metadataTool) return cfg.metadataTool;
  const key = `${name} ${cfg.baseUrl ?? ""} ${cfg.api ?? ""}`.toLowerCase();
  if (/kilo/.test(key) || (cfg.models ?? []).some((model) => /^kilo-free\//i.test(model.id))) return "kilo";
  if (/antigravity|googleapis\.com\/v1beta\/interactions/.test(key)) return "antigravity";
  if (/gemini-cli/.test(key)) return "gemini-cli";
  if (/codex/.test(key)) return "codex";
  return undefined;
}

/** Enrich every model under a provider; return report lines + counters. */
function enrichProvider(
  provName: string,
  provCfg: ProviderConfig,
  enrichCtx: EnrichContext,
  opts?: { force?: boolean },
): { report: string[]; changed: number; matched: number; noMatch: number } {
  const report: string[] = [];
  let changed = 0, matched = 0, noMatch = 0;
  const models = provCfg.models;
  if (!Array.isArray(models)) return { report, changed, matched, noMatch };
  for (const m of models) {
    if (opts?.force) clearEnrichableFields(m);
    const [patches, src] = enrichModel(m, enrichCtx, {
      providerName: provName,
      providerCfg: provCfg,
    });
    if (!src) {
      noMatch++;
      report.push(`· ${provName}/${m.id} — no models.dev or built-in match, skipped`);
      continue;
    }
    matched++;
    if (patches.length > 0) {
      changed++;
      report.push(`✓ ${provName}/${m.id} ← ${sourceRef(src)}  +${patches.join(",")}`);
    } else {
      report.push(`= ${provName}/${m.id} ← ${sourceRef(src)}  already complete`);
    }
  }
  return { report, changed, matched, noMatch };
}

// ---------------- /models endpoint ----------------
interface RemoteModel { id: string }

async function fetchModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<RemoteModel[]> {
  let url = baseUrl.replace(/\/+$/, "");
  if (!/\/v\d+$/i.test(url)) url += "/v1";
  url += "/models";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal: signal ?? AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  const json = (await res.json()) as { data?: RemoteModel[] };
  const list = Array.isArray(json?.data) ? json.data : [];
  return list.filter((m) => m && typeof m.id === "string" && m.id.trim() && !/^all\b/i.test(m.id.trim()));
}

function formatReloadHint(): string {
  return "Run /reload, then pick the provider in /model.";
}

// ===================== /pim:headers presets =====================

/**
 * Disguise presets — header sets that make pi's requests look like they come
 * from the official Codex CLI or Claude Code CLI. Values reverse-engineered
 * from source (codex-rs) and the Claude Code binary.
 *
 * Header values support pi's config resolution: `$ENV_VAR` interpolates an
 * environment variable, `!cmd` runs a shell command. The provider's `headers`
 * field overrides pi's default `User-Agent: pi-coding-agent`.
 */
interface DisguisePreset {
  id: string;
  label: string;
  description: string;
  headers: Record<string, string>;
}

// Latest stable Codex release as of 2026-07-29 (github.com/openai/codex tag rust-v0.146.0).
// Bump this when a new stable ships; editable below.
const DEFAULT_CODEX_VERSION = "0.146.0";
// Claude Code version (matches a real released CLI build on this machine).
const DEFAULT_CLAUDE_VERSION = "2.1.195";

// anthropic-beta tokens currently advertised by Claude Code (full set).
const CLAUDE_BETA_TOKENS = [
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
  "context-management-2025-06-27",
  "files-api-2025-04-14",
  "extended-cache-ttl-2025-04-11",
  "prompt-caching-scope-2026-01-05",
  "token-efficient-tools-2025-02-19",
  "mcp-client-2025-11-20",
  "skills-2025-10-02",
  "managed-agents-2026-04-01",
].join(",");

function codexPreset(version: string): DisguisePreset {
  // Real Codex UA format (openai/codex login/src/auth/default_client.rs get_codex_user_agent):
  //   codex_cli_rs/{build_version} ({os_info::os_type()} {os_info::version()}; {arch}) {terminal_token}
  // os_info crate returns: os_type="Arch", version="Unknown" on Arch Linux (verified at runtime).
  // The terminal token comes from codex_terminal_detection::user_agent() (e.g. kitty).
  // These defaults match this Arch Linux + kitty host; edit for other platforms.
  const osToken = "Arch";
  const osVersion = "Unknown";
  const arch = "x86_64";
  const terminalToken = "kitty";
  return {
    id: "codex",
    label: "Codex CLI",
    description: "openai-responses style: originator + codex User-Agent + OpenAI-Beta",
    headers: {
      "originator": "codex_cli_rs",
      "User-Agent": `codex_cli_rs/${version} (${osToken} ${osVersion}; ${arch}) ${terminalToken}`,
      // Sent on the plain-HTTP responses path by Codex.
      "OpenAI-Beta": "responses=experimental",
    },
  };
}

function claudePreset(version: string): DisguisePreset {
  // Real Claude Code UA (binary v2.1.195, getUserAgent() = m7):
  //   claude-cli/{VERSION} (external, {CLAUDE_CODE_ENTRYPOINT ?? "cli"})
  // The (external, cli) suffix is always present for a normal CLI run.
  return {
    id: "claude",
    label: "Claude Code CLI",
    description: "anthropic-messages style: anthropic-version/beta + x-app + claude User-Agent",
    headers: {
      "anthropic-version": "2023-06-01",
      "anthropic-beta": CLAUDE_BETA_TOKENS,
      "x-app": "cli",
      "User-Agent": `claude-cli/${version} (external, cli)`,
      "anthropic-client-platform": "claude-code",
    },
  };
}

/** Format a headers map as aligned `key: value` lines for preview. */
function formatHeaders(headers: Record<string, string> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return "  (none)";
  const keys = Object.keys(headers).sort();
  const width = Math.max(...keys.map((k) => k.length), 8);
  return keys.map((k) => `  ${k.padEnd(width)}  ${headers[k]}`).join("\n");
}

/** Parse a `Key: Value` or `Key=Value` line into [key, value]. Returns null if blank/invalid. */
function parseHeaderLine(line: string): [string, string] | null {
  const raw = line.trim();
  if (!raw) return null;
  // Prefer the first `:` (HTTP headers use `:`), fall back to `=`.
  const sep = raw.indexOf(":");
  const idx = sep >= 0 ? sep : raw.indexOf("=");
  if (idx <= 0) return null;
  const key = raw.slice(0, idx).trim();
  const val = raw.slice(idx + 1).trim();
  if (!key) return null;
  return [key, val];
}

export default function (pi: ExtensionAPI) {
  // ===================== /pim:add =====================
  pi.registerCommand("pim:add", {
    description: "Interactively add an OpenAI-compatible provider (fetch models + optional enrich)",
    handler: async (_args: string, ctx) => {
      const path = MODELS_JSON();
      const ui = ctx.ui;

      // 1. Basic provider info
      const name = (await ui.input("Provider name (e.g. didi, my-proxy):"))?.trim();
      if (!name) { ui.notify("Cancelled.", "info"); return; }
      if (!/^[a-z0-9][a-z0-9-_.]*$/i.test(name)) {
        ui.notify(`Invalid name "${name}": must start with a letter/digit and contain only letters, digits, -, _, .`, "error");
        return;
      }
      const baseUrl = (await ui.input("Base URL (e.g. https://xxx.com/v1):"))?.trim();
      if (!baseUrl) { ui.notify("Cancelled.", "info"); return; }
      const apiKey = (await ui.input("API key (leave empty to omit; use /login or --api-key later):"))?.trim() ?? "";

      const apiChoice = await ui.select(
        "API type (request/response format):",
        getApiChoices().map((a) => a.label),
        {},
      );
      if (!apiChoice) { ui.notify("Cancelled.", "info"); return; }
      const apiType = apiIdFromLabel(apiChoice);

      // 2. Load config + name clash
      let config: ModelsJsonConfig;
      try { config = loadConfig(path); }
      catch (e) { ui.notify(`Failed to parse models.json: ${(e as Error).message}`, "error"); return; }
      if (config.providers[name]) {
        const overwrite = await ui.confirm(
          `Provider "${name}" already exists`,
          `Overwrite providers.${name}? Other providers are left untouched.`,
        );
        if (!overwrite) { ui.notify("Cancelled.", "info"); return; }
      }

      // 3. Fetch model list
      const fetched = await fetchModelsWithUI(ctx, baseUrl, apiKey);
      if (fetched.cancelled) { ui.notify("Cancelled.", "info"); return; }

      let modelIds = fetched.models.map((m) => m.id);
      let fetchError = fetched.error ?? (modelIds.length === 0 ? "endpoint returned an empty list" : "");

      // 4. Select models
      let selected: string[] = [];
      if (modelIds.length > 0) {
        const picked = await pickModels(ctx, `Add models · ${name}`, modelIds, "add");
        if (picked === null) { ui.notify("Cancelled.", "info"); return; }
        selected = picked;
        if (selected.length === 0) { ui.notify("No models selected. Cancelled.", "warning"); return; }
      } else {
        const manual = await ui.input(
          `Fetch failed (${fetchError}). Enter model ids, comma-separated (e.g. glm-5.2,glm-4.7):`,
        );
        if (!manual?.trim()) { ui.notify("No models provided. Cancelled.", "info"); return; }
        selected = manual.split(",").map((s) => s.trim()).filter(Boolean);
        if (selected.length === 0) { ui.notify("No models provided. Cancelled.", "info"); return; }
      }

      // 5. Optional enrich
      const doEnrich = await ui.confirm(
        "Enrich model config?",
        "Use models.dev when available, then fall back to the built-in library. Fills thinkingLevelMap / cost / contextWindow / maxTokens / input. Existing non-zero fields are never overwritten.",
      );

      // 6. Build provider config
      const providerCfg: ModelsJsonConfig["providers"][string] = {
        baseUrl,
        api: apiType,
        models: selected.map((id) => ({ id })),
      };
      if (apiKey) providerCfg.apiKey = apiKey;

      // 7. Enrich
      const report: string[] = [];
      if (doEnrich) {
        const customNames = new Set(Object.keys(config.providers));
        customNames.add(name);
        const enrichCtx = await createEnrichContext(ctx, customNames);
        let enriched = 0;
        for (const m of providerCfg.models!) {
          const [patches, src] = enrichModel(m, enrichCtx, {
            providerName: name,
            providerCfg,
          });
          if (src && patches.length > 0) {
            enriched++;
            report.push(`✓ ${m.id} ← ${sourceRef(src)}  +${patches.join(",")}`);
          } else if (src) {
            report.push(`= ${m.id} ← ${sourceRef(src)}  already complete`);
          } else {
            report.push(`· ${m.id} — no models.dev or built-in match, id only`);
          }
        }
        report.unshift(`Enriched ${enriched}/${selected.length} models (models.dev first, canonical family preferred)`);
      }

      // 8. Write
      config.providers[name] = providerCfg;
      try { saveConfig(path, config); }
      catch (e) { ui.notify(`Failed to write models.json: ${(e as Error).message}`, "error"); return; }

      const head = [
        `Added provider ${name}`,
        `  baseUrl  ${baseUrl}`,
        `  api      ${apiType}${apiKey ? "  ·  apiKey set" : "  ·  no apiKey"}`,
        `  models   ${selected.join(", ")}`,
        "",
        ...report,
        "",
        formatReloadHint(),
      ].join("\n");
      ui.notify(head, "info");
    },
  });

  // ===================== /pim:sync =====================
  pi.registerCommand("pim:sync", {
    description: "Refresh metadata caches and sync provider limits from per-provider tool profiles, or models.dev only.",
    getArgumentCompletions: completeSyncModelArgs,
    handler: async (args: string, ctx) => {
      const path = MODELS_JSON();
      const ui = ctx.ui;
      if (!existsSync(path)) { ui.notify("models.json not found: " + path, "error"); return; }

      const rawArgs = args ?? "";
      const dryRun = /\b(preview|dry-run|dryrun)\b/i.test(rawArgs);
      const force = /\bforce\b/i.test(rawArgs);
      const modelsOnly = /\bmodels\b/i.test(rawArgs);
      const statusOnly = /\bstatus\b/i.test(rawArgs);
      const helpOnly = /\bhelp\b/i.test(rawArgs);
      const toolMatch = rawArgs.match(/\btool=(codex|kilo|gemini-cli|antigravity)\b/i);
      const explicitTool = toolMatch?.[1]?.toLowerCase() as ToolProfile | undefined;
      const providerMatch = rawArgs.match(/\bprovider=([a-z0-9][a-z0-9._-]*)\b/i);
      const selectedProvider = providerMatch?.[1];
      let config: ModelsJsonConfig;
      try { config = loadConfig(path); }
      catch (e) {
        ui.notify(
          `Failed to parse models.json: ${(e as Error).message}\n(Remove // comments first; pure JSON only.)`,
          "error",
        );
        return;
      }

      if (force && !dryRun) {
        const ok = await ui.confirm(
          "Refresh metadata and replace the source cache?",
          "Fetch current models.dev and selected tool catalogs, replace their cache snapshots, then re-enrich models. Tool context profiles only apply to the provider assigned that tool.",
        );
        if (!ok) { ui.notify("Cancelled.", "info"); return; }
      }

      const customNames = new Set(Object.keys(config.providers));
      if (selectedProvider && !config.providers[selectedProvider]) {
        ui.notify(`Provider "${selectedProvider}" not found. Known providers: ${[...customNames].join(", ")}`, "error");
        return;
      }
      if (helpOnly) {
        ui.notify([
          "/pim:sync — refresh models.dev plus assigned per-provider tool profiles; write resolved models.json",
          "/pim:sync models — refresh/use models.dev only",
          "/pim:sync tool=kilo|codex|gemini-cli|antigravity — override only providers assigned that metadataTool",
          "/pim:sync provider=<name> tool=<tool> — one-run override for exactly one provider",
          "/pim:sync preview — fetch/replace caches and preview without writing models.json",
          "/pim:sync status — inspect metadata cache timestamps",
          "Set providers.<name>.metadataTool in models.json for persistent per-provider tool assignment.",
        ].join("\n"), "info");
        return;
      }
      if (statusOnly) {
        const status = await getMetadataCacheStatus();
        ui.notify(status.join("\n"), "info");
        return;
      }
      if (modelsOnly) await createEnrichContext(ctx, customNames, { forceRefresh: true });
      else await Promise.all([
        createEnrichContext(ctx, customNames, { forceRefresh: true }),
        ...Object.entries(config.providers)
          .map(([providerName, providerCfg]) => explicitTool ?? providerCfg.metadataTool ?? inferToolForProvider(providerName, providerCfg))
          .filter((tool): tool is ToolProfile => Boolean(tool))
          .filter((tool, index, tools) => tools.indexOf(tool) === index)
          .map((tool) => {
            if (tool === "kilo") return refreshKiloProfileCache(true).catch(() => undefined);
            if (tool === "codex") return refreshCodexProfileCache(true).catch(() => undefined);
            return Promise.resolve();
          }),
      ]);
      const baseCtx = await createEnrichContext(ctx, customNames, { forceRefresh: false });
      let changed = 0, matched = 0, noMatch = 0;
      const all: ReturnType<typeof enrichProvider>[] = [];
      for (const [provName, provCfg] of Object.entries(config.providers)) {
        const isSelectedProvider = !selectedProvider || selectedProvider === provName;
        const assignedTool = provCfg.metadataTool ?? inferToolForProvider(provName, provCfg);
        const profile = modelsOnly ? undefined : selectedProvider
          ? isSelectedProvider ? explicitTool ?? assignedTool : assignedTool
          : explicitTool ? (assignedTool === explicitTool ? explicitTool : undefined) : assignedTool;
        const enrichCtx = profile
          ? await createToolEnrichContext(ctx, customNames, profile, provName, { forceRefresh: true })
          : baseCtx;
        const r = enrichProvider(provName, provCfg, enrichCtx, { force });
        all.push(r);
        changed += r.changed;
        matched += r.matched;
        noMatch += r.noMatch;
      }

      if (!dryRun) saveConfig(path, config);

      const report = all.flatMap((r) => r.report);
      const modeTag = [
        dryRun ? "preview · models.json not written" : "source caches refreshed",
        modelsOnly ? "models.dev only" : selectedProvider ? `provider=${selectedProvider}${explicitTool ? ` tool=${explicitTool}` : ""}` : explicitTool ? `tool=${explicitTool} on assigned providers` : "per-provider tool profiles",
      ].filter(Boolean).join(" · ");
      const head =
        `[${modeTag}] /pim:sync: matched ${matched} · enriched ${changed} · no match ${noMatch}` +
        (!dryRun ? `\nWrote models.json. ${formatReloadHint()}` : "");
      ui.notify([head, "", ...report].join("\n"), changed > 0 || dryRun ? "info" : "warning");
    },
  });

  // ===================== /pim:edit =====================
  pi.registerCommand("pim:edit", {
    description: "Edit a provider: models, connection, API format, enrich, or delete",
    handler: async (_args: string, ctx) => {
      const path = MODELS_JSON();
      const ui = ctx.ui;
      if (!existsSync(path)) { ui.notify("models.json not found: " + path, "error"); return; }

      let config: ModelsJsonConfig;
      try { config = loadConfig(path); }
      catch (e) { ui.notify(`Failed to parse models.json: ${(e as Error).message}`, "error"); return; }

      const provNames = Object.keys(config.providers);
      if (provNames.length === 0) {
        ui.notify("No providers in models.json. Use /pim:add first.", "warning");
        return;
      }

      // Show name + model count for faster scanning
      const provLabels = provNames.map((n) => {
        const count = config.providers[n]?.models?.length ?? 0;
        const url = config.providers[n]?.baseUrl ?? "";
        return url ? `${n}  ·  ${count} models  ·  ${url}` : `${n}  ·  ${count} models`;
      });
      const pickedLabel = await ui.select("Select a provider to edit:", provLabels, {});
      if (!pickedLabel) { ui.notify("Cancelled.", "info"); return; }
      const provName = pickedLabel.split("  ·  ")[0].trim();
      const provCfg = config.providers[provName];
      if (!provCfg) { ui.notify(`Provider "${provName}" not found.`, "error"); return; }

      const ACTIONS = {
        api: "Change API format",
        models: "Manage models",
        conn: "Edit connection (baseUrl / apiKey)",
        enrich: "Enrich model config",
        del: "Delete provider",
        cancel: "Cancel",
      } as const;

      const action = await ui.select(
        `Edit ${provName} · choose an action:`,
        [ACTIONS.api, ACTIONS.models, ACTIONS.conn, ACTIONS.enrich, ACTIONS.del, ACTIONS.cancel],
        {},
      );
      if (!action || action === ACTIONS.cancel) { ui.notify("Cancelled.", "info"); return; }

      let dirty = false;
      const report: string[] = [];

      // ---------- Change API format ----------
      if (action === ACTIONS.api) {
        const current = typeof provCfg.api === "string" ? provCfg.api : "";
        const curLabel = getApiChoices().find((a) => a.id === current)?.label ?? current ?? "(empty)";
        const picked = await ui.select(
          `New API format (current: ${curLabel}):`,
          [...getApiChoices().map((a) => a.label), "(remove field)"],
          {},
        );
        if (!picked) { ui.notify("Cancelled.", "info"); return; }
        const trimmed = picked === "(remove field)" ? "" : apiIdFromLabel(picked);
        if (trimmed === current) { ui.notify("No change.", "info"); return; }
        const ok = await ui.confirm(
          `Change ${provName}.api?`,
          `Old: ${current || "(empty)"}\nNew: ${trimmed || "(empty)"}`,
        );
        if (!ok) { ui.notify("Cancelled.", "info"); return; }
        if (trimmed === "") delete provCfg.api;
        else provCfg.api = trimmed;
        dirty = true;
        report.push(`✓ api: ${current || "(empty)"} → ${trimmed || "(removed)"}`);
      }

      // ---------- Manage models ----------
      else if (action === ACTIONS.models) {
        const SUB = {
          fetch: "Add from /models endpoint",
          manual: "Add by typing ids",
          remove: "Remove existing models",
          cancel: "Cancel",
        } as const;
        const sub = await ui.select(
          `${provName} · manage models:`,
          [SUB.fetch, SUB.manual, SUB.remove, SUB.cancel],
          {},
        );
        if (!sub || sub === SUB.cancel) { ui.notify("Cancelled.", "info"); return; }

        if (sub === SUB.remove) {
          const existing = (provCfg.models ?? []).map((m) => m.id);
          if (existing.length === 0) { ui.notify("This provider has no models to remove.", "warning"); return; }
          const toDel = await pickModels(ctx, `Remove models · ${provName}`, existing, "delete");
          if (toDel === null) { ui.notify("Cancelled.", "info"); return; }
          if (toDel.length === 0) { ui.notify("No models selected for removal.", "info"); return; }
          const ok = await ui.confirm(
            `Remove ${toDel.length} model(s)?`,
            toDel.join(", "),
          );
          if (!ok) { ui.notify("Cancelled.", "info"); return; }
          const delSet = new Set(toDel);
          provCfg.models = (provCfg.models ?? []).filter((m) => !delSet.has(m.id));
          dirty = true;
          report.push(`✓ Removed ${toDel.length} model(s): ${toDel.join(", ")}`);
        } else {
          let newIds: string[] = [];
          if (sub === SUB.fetch) {
            const baseUrl = provCfg.baseUrl ?? "";
            const apiKey = typeof provCfg.apiKey === "string" ? provCfg.apiKey : "";
            if (!baseUrl) {
              ui.notify("This provider has no baseUrl. Use \"Add by typing ids\" instead.", "warning");
              return;
            }
            const fetched = await fetchModelsWithUI(ctx, baseUrl, apiKey);
            if (fetched.cancelled) { ui.notify("Cancelled.", "info"); return; }
            if (fetched.error) { ui.notify(`Fetch failed: ${fetched.error}`, "error"); return; }
            const existing = new Set((provCfg.models ?? []).map((m) => m.id));
            newIds = fetched.models.map((m) => m.id).filter((id) => !existing.has(id));
            if (newIds.length === 0) {
              ui.notify("No new models on the endpoint (all already present).", "warning");
              return;
            }
          } else {
            const manual = await ui.input("Model ids to add, comma-separated:");
            if (!manual?.trim()) { ui.notify("No models provided. Cancelled.", "info"); return; }
            newIds = manual.split(",").map((s) => s.trim()).filter(Boolean);
          }

          const selected = await pickModels(ctx, `Add models · ${provName}`, newIds, "add");
          if (selected === null) { ui.notify("Cancelled.", "info"); return; }
          if (selected.length === 0) { ui.notify("No models selected.", "info"); return; }

          const doEnrich = await ui.confirm(
            "Enrich model config?",
            "Use models.dev when available (canonical family preferred), then fall back to the built-in library. Fills thinkingLevelMap / cost / contextWindow / maxTokens / input."
          );
          const customNames = new Set(Object.keys(config.providers));
          const enrichCtx = doEnrich ? await createEnrichContext(ctx, customNames) : undefined;
          provCfg.models = provCfg.models ?? [];
          for (const id of selected) {
            const m: LikeModel = { id };
            if (doEnrich && enrichCtx) {
              const [patches, src] = enrichModel(m, enrichCtx, {
                providerName: provName,
                providerCfg: provCfg,
              });
              if (src && patches.length > 0) {
                report.push(`✓ ${id} ← ${sourceRef(src)} +${patches.join(",")}`);
              } else if (src) {
                report.push(`= ${id} ← ${sourceRef(src)} already complete`);
              } else {
                report.push(`· ${id} — no models.dev or built-in match, id only`);
              }
            } else {
              report.push(`✓ ${id} (id only, not enriched)`);
            }
            provCfg.models.push(m);
          }
          dirty = true;
          report.unshift(`Added ${selected.length} model(s)`);
        }
      }

      // ---------- Edit connection ----------
      else if (action === ACTIONS.conn) {
        const field = await ui.select(
          `Edit which field of ${provName}?`,
          ["baseUrl", "apiKey", "Cancel"],
          {},
        );
        if (!field || field === "Cancel") { ui.notify("Cancelled.", "info"); return; }
        const current = typeof provCfg[field as "baseUrl" | "apiKey"] === "string"
          ? String(provCfg[field as "baseUrl" | "apiKey"])
          : "";

        // Title shows current value; empty keeps, "-" removes, Esc cancels
        const newVal = await ui.input(
          `${field} (current: ${current || "(empty)"} | empty keeps, - removes):`,
          "",
        );
        if (newVal === undefined) { ui.notify("Cancelled.", "info"); return; }
        const t = newVal.trim();
        let trimmed: string;
        if (t === "-") trimmed = "";
        else if (t === "") trimmed = current;
        else trimmed = t;

        if (trimmed === current) { ui.notify("No change.", "info"); return; }
        const ok = await ui.confirm(
          `Change ${provName}.${field}?`,
          `Old: ${current || "(empty)"}\nNew: ${trimmed || "(empty)"}`,
        );
        if (!ok) { ui.notify("Cancelled.", "info"); return; }
        if (trimmed === "") delete (provCfg as Record<string, unknown>)[field];
        else (provCfg as Record<string, unknown>)[field] = trimmed;
        dirty = true;
        report.push(`✓ ${field}: ${current || "(empty)"} → ${trimmed || "(removed)"}`);
      }

      // ---------- Enrich model config ----------
      else if (action === ACTIONS.enrich) {
        const models = provCfg.models ?? [];
        if (models.length === 0) { ui.notify("This provider has no models.", "warning"); return; }
        const MODES = {
          safe: "Fill missing fields only (safe)",
          overwrite: "Clear and re-enrich (overwrite matched fields)",
          cancel: "Cancel",
        } as const;
        const mode = await ui.select(
          `Enrich models of ${provName}:`,
          [MODES.safe, MODES.overwrite, MODES.cancel],
          {},
        );
        if (!mode || mode === MODES.cancel) { ui.notify("Cancelled.", "info"); return; }
        const overwrite = mode === MODES.overwrite;
        if (overwrite) {
          const ok = await ui.confirm(
            "Overwrite and re-enrich?",
            "Clears thinkingLevelMap / cost / compat / maxTokens / contextWindow / input / name on each model, then re-matches models.dev (canonical family preferred) and built-in. reasoning and modelFamily are kept."
          );
          if (!ok) { ui.notify("Cancelled.", "info"); return; }
        }
        const customNames = new Set(Object.keys(config.providers));
        const enrichCtx = await createEnrichContext(ctx, customNames);
        let changed = 0, noMatch = 0;
        for (const m of models) {
          if (overwrite) clearEnrichableFields(m);
          const [patches, src] = enrichModel(m, enrichCtx, {
            providerName: provName,
            providerCfg: provCfg,
          });
          if (!src) {
            noMatch++;
            report.push(`· ${m.id} — no models.dev or built-in match, skipped`);
            continue;
          }
          if (patches.length > 0) {
            changed++;
            report.push(`✓ ${m.id} ← ${sourceRef(src)} +${patches.join(",")}`);
          } else {
            report.push(`= ${m.id} ← ${sourceRef(src)} already complete`);
          }
        }
        dirty = changed > 0;
        report.unshift(
          `Enriched ${changed}/${models.length} model(s)` +
          (noMatch > 0 ? `, no match ${noMatch}` : ""),
        );
      }

      // ---------- Delete provider ----------
      else if (action === ACTIONS.del) {
        const modelCount = (provCfg.models ?? []).length;
        const ok = await ui.confirm(
          `Delete provider ${provName}?`,
          `Permanently removes this provider and its ${modelCount} model(s). This cannot be undone.`,
        );
        if (!ok) { ui.notify("Cancelled.", "info"); return; }
        delete config.providers[provName];
        dirty = true;
        report.push(`✓ Deleted provider ${provName} (${modelCount} model(s))`);
      }

      // Write back
      if (dirty) {
        try { saveConfig(path, config); }
        catch (e) { ui.notify(`Failed to write models.json: ${(e as Error).message}`, "error"); return; }
      }
      const head = [
        `/pim:edit · ${provName}`,
        ...report,
        dirty ? "" : "(no changes)",
        dirty ? formatReloadHint() : "",
      ].filter(Boolean).join("\n");
      ui.notify(head, dirty ? "info" : "warning");
    },
  });

  // ===================== /pim:headers =====================
  pi.registerCommand("pim:headers", {
    description: "Manage provider request headers and Codex/Claude presets",
    handler: async (_args: string, ctx) => {
      const path = MODELS_JSON();
      const ui = ctx.ui;
      if (!existsSync(path)) { ui.notify("models.json not found: " + path, "error"); return; }

      let config: ModelsJsonConfig;
      try { config = loadConfig(path); }
      catch (e) { ui.notify(`Failed to parse models.json: ${(e as Error).message}`, "error"); return; }

      const provNames = Object.keys(config.providers);
      if (provNames.length === 0) {
        ui.notify("No providers in models.json. Use /pim:add first.", "warning");
        return;
      }

      // 1. Pick provider (with current disguise hint)
      const provLabels = provNames.map((n) => {
        const p = config.providers[n];
        const count = p?.models?.length ?? 0;
        const disguised = p?.headers && Object.keys(p.headers).length > 0;
        const tag = disguised ? `  ·  disguised: ${Object.keys(p.headers!).length} hdrs` : "";
        return `${n}  ·  ${count} models${tag}`;
      });
      const pickedLabel = await ui.select("Select a provider to disguise:", provLabels, {});
      if (!pickedLabel) { ui.notify("Cancelled.", "info"); return; }
      const provName = pickedLabel.split("  ·  ")[0].trim();
      const provCfg = config.providers[provName];
      if (!provCfg) { ui.notify(`Provider "${provName}" not found.`, "error"); return; }

      // 2. Pick preset
      const ACTIONS = {
        codex: "Codex CLI  (originator + codex UA + OpenAI-Beta)",
        claude: "Claude Code  (anthropic-version/beta + x-app + claude UA)",
        custom: "Custom headers  (enter key: value lines)",
        clear: "Clear disguise  (remove provider.headers)",
        cancel: "Cancel",
      } as const;
      const action = await ui.select(
        `Disguise ${provName} · choose a preset:`,
        [ACTIONS.codex, ACTIONS.claude, ACTIONS.custom, ACTIONS.clear, ACTIONS.cancel],
        {},
      );
      if (!action || action === ACTIONS.cancel) { ui.notify("Cancelled.", "info"); return; }

      let newHeaders: Record<string, string> | undefined;
      const report: string[] = [];

      if (action === ACTIONS.clear) {
        newHeaders = undefined;
        report.push("Removing all disguise headers from provider.");
      } else if (action === ACTIONS.codex || action === ACTIONS.claude) {
        const isCodex = action === ACTIONS.codex;
        // 3a. Version prompt (pre-filled with the default).
        const defaultVer = isCodex ? DEFAULT_CODEX_VERSION : DEFAULT_CLAUDE_VERSION;
        const verInput = (await ui.input(
          `${isCodex ? "Codex" : "Claude Code"} version for User-Agent (enter to use ${defaultVer}):`,
        ))?.trim();
        const version = verInput || defaultVer;
        const preset = isCodex ? codexPreset(version) : claudePreset(version);
        newHeaders = { ...preset.headers };

        // 3b. Optional extra/override headers (blank line to finish).
        const extraChoice = await ui.confirm(
          `Add extra or override headers?`,
          `Merge additional headers on top of the ${preset.label} preset. Existing preset keys will be overwritten by your values.`,
        );
        if (extraChoice) {
          ui.notify(
            `Enter one header per line as \"Key: Value\" (or Key=Value). Submit an empty line to finish.\nCurrent preset:\n${formatHeaders(newHeaders)}`,
            "info",
          );
          for (;;) {
            const line = await ui.input("Header (empty to finish):");
            if (line === undefined) { ui.notify("Cancelled.", "info"); return; }
            if (!line.trim()) break;
            const parsed = parseHeaderLine(line);
            if (!parsed) { ui.notify(`Skipped invalid line: ${line}`, "warning"); continue; }
            const [k, v] = parsed;
            const existed = k in newHeaders!;
            newHeaders![k] = v;
            report.push(`${existed ? "~ override" : "+ add"}  ${k}: ${v}`);
          }
        }
        report.unshift(`Applied ${preset.label} preset (version ${version}).`);
      } else {
        // 3c. Custom: enter headers line by line.
        newHeaders = {};
        ui.notify(
          `Enter one header per line as \"Key: Value\" (or Key=Value). Submit an empty line to finish.`,
          "info",
        );
        for (;;) {
          const line = await ui.input("Header (empty to finish):");
          if (line === undefined) { ui.notify("Cancelled.", "info"); return; }
          if (!line.trim()) break;
          const parsed = parseHeaderLine(line);
          if (!parsed) { ui.notify(`Skipped invalid line: ${line}`, "warning"); continue; }
          const [k, v] = parsed;
          newHeaders[k] = v;
          report.push(`+ ${k}: ${v}`);
        }
        if (Object.keys(newHeaders).length === 0) {
          ui.notify("No headers entered. Cancelled.", "info");
        }
        report.unshift("Applied custom headers.");
      }

      if (newHeaders !== undefined && Object.keys(newHeaders).length === 0) {
        // Custom produced nothing — treat as cancel.
        return;
      }

      // 4. Preview diff
      const before = provCfg.headers;
      const preview = [
        `Disguise ${provName}`,
        "",
        "Current headers:",
        formatHeaders(before),
        "",
        "New headers:",
        formatHeaders(newHeaders),
        "",
        ...report,
      ].join("\n");
      ui.notify(preview, "info");

      // 5. Confirm + write
      const ok = await ui.confirm(
        `Write these headers to providers.${provName}?`,
        `${newHeaders ? Object.keys(newHeaders).length + " header(s)" : "(remove headers)"} · ${formatReloadHint()}`,
      );
      if (!ok) { ui.notify("Cancelled.", "info"); return; }
      if (newHeaders) provCfg.headers = newHeaders;
      else delete provCfg.headers;
      try { saveConfig(path, config); }
      catch (e) { ui.notify(`Failed to write models.json: ${(e as Error).message}`, "error"); return; }
      ui.notify(
        [
          `✓ Disguised ${provName}`,
          newHeaders ? `  ${Object.keys(newHeaders).length} header(s) applied` : "  headers removed",
          formatReloadHint(),
        ].join("\n"),
        "info",
      );
    },
  });
}
