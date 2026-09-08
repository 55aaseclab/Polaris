/**
 * SEO operations assets: multi-site long-lived websites under seo-ops/sites/.
 * No separate CLI tool — portal + core only.
 */

import fs from "node:fs";
import path from "node:path";
import { isJsonObject, readJsonFile, writeJsonFileAtomic, type JsonObject } from "./json.js";
import { SCHEMAS_DIR } from "./repo.js";
import { type Schema, validateJsonObject } from "./schema-validation.js";
import {
  defaultTaskStates,
  playbookProgress,
  SEO_PLAYBOOK_SECTIONS,
  SEO_PLAYBOOK_TASKS,
  SEO_PLAYBOOK_VERSION,
  type SeoPlaybookSectionId,
  type SeoTaskStatus,
} from "./seo-playbook.js";
import { WorkspacePaths } from "./workspaces.js";

const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SITE_SCHEMA_PATH = path.join(SCHEMAS_DIR, "wanghai.seo.site.v1.schema.json");
const METRICS_SCHEMA_PATH = path.join(SCHEMAS_DIR, "wanghai.seo.metrics-snapshot.v1.schema.json");

let siteSchemaCache: Schema | null = null;
let metricsSchemaCache: Schema | null = null;

function loadSiteSchema(): Schema {
  if (!siteSchemaCache) {
    siteSchemaCache = JSON.parse(fs.readFileSync(SITE_SCHEMA_PATH, "utf-8")) as Schema;
  }
  return siteSchemaCache;
}

function loadMetricsSchema(): Schema {
  if (!metricsSchemaCache) {
    metricsSchemaCache = JSON.parse(fs.readFileSync(METRICS_SCHEMA_PATH, "utf-8")) as Schema;
  }
  return metricsSchemaCache;
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function assertSiteId(siteId: string): void {
  if (!SITE_ID_PATTERN.test(siteId)) {
    throw new Error(`Invalid site_id: ${siteId}`);
  }
}

export type SeoSiteStatus = "planning" | "building" | "live" | "paused" | "archived";

export type SeoSite = {
  schema: "wanghai.seo.site";
  schema_version: 1;
  site_id: string;
  name: string;
  primary_domain: string;
  status: SeoSiteStatus;
  locale: "zh" | "en" | "multi";
  markets: string[];
  positioning: {
    icp: string | null;
    one_liner: string | null;
    search_fit: string | null;
  };
  integrations: {
    ga4_property_id: string | null;
    gsc_site_url: string | null;
    clarity_project_id: string | null;
  };
  playbook: {
    version: string;
    task_states: Record<
      string,
      { status: SeoTaskStatus; updated_at: string; note: string | null }
    >;
  };
  notes: string[];
  created_at: string;
  updated_at: string;
};

export type SeoMetricsSnapshot = {
  schema: "wanghai.seo.metrics-snapshot";
  schema_version: 1;
  site_id: string;
  source: "ga4" | "gsc" | "manual" | "mixed";
  period_start: string;
  period_end: string;
  captured_at: string;
  totals: {
    sessions: number | null;
    users: number | null;
    pageviews: number | null;
    organic_sessions: number | null;
    clicks: number | null;
    impressions: number | null;
    ctr: number | null;
    avg_position: number | null;
  };
  top_pages: Array<{ path: string; pageviews: number | null; sessions: number | null }>;
  top_queries: Array<{
    query: string;
    clicks: number | null;
    impressions: number | null;
    position: number | null;
  }>;
  notes: string[];
};

export function seoOpsRoot(workspaceRoot: string): string {
  return new WorkspacePaths(workspaceRoot).seoOpsDir;
}

export function seoSitesDir(workspaceRoot: string): string {
  return path.join(seoOpsRoot(workspaceRoot), "sites");
}

export function seoSiteDir(workspaceRoot: string, siteId: string): string {
  assertSiteId(siteId);
  return path.join(seoSitesDir(workspaceRoot), siteId);
}

export function ensureSeoOpsLayout(workspaceRoot: string): void {
  const root = seoOpsRoot(workspaceRoot);
  fs.mkdirSync(path.join(root, "sites"), { recursive: true });
  fs.mkdirSync(path.join(root, "case"), { recursive: true });
  const readme = path.join(root, "case", "README.md");
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(
      readme,
      [
        "# SEO 运营",
        "",
        "长期运营的网站资产。每个站点一个目录：`sites/<site_id>/`。",
        "",
        "- `site.json`：站点档案 + playbook 任务状态",
        "- `metrics/`：GA4 / GSC / 手工指标快照",
        "- `content-tasks/`、`backlinks/`：可选扩展任务文件",
        "",
        "Playbook 内置于代码（`@polaris/business-core` seo-playbook）。参考中央文档：",
        "https://www.jianxiaoyitech.com/docs/wanghai/reference/seo-playbook",
        "",
      ].join("\n"),
      "utf-8",
    );
  }
}

export function validateSeoSite(data: JsonObject): SeoSite {
  validateJsonObject(data, loadSiteSchema(), "seo site");
  return data as unknown as SeoSite;
}

export function validateSeoMetrics(data: JsonObject): SeoMetricsSnapshot {
  validateJsonObject(data, loadMetricsSchema(), "seo metrics");
  return data as unknown as SeoMetricsSnapshot;
}

export function readSeoSite(workspaceRoot: string, siteId: string): SeoSite {
  const metaPath = path.join(seoSiteDir(workspaceRoot, siteId), "site.json");
  const raw = readJsonFile<JsonObject>(metaPath);
  if (!raw || !isJsonObject(raw)) {
    throw new Error(`SEO site not found: ${siteId}`);
  }
  return validateSeoSite(raw);
}

export function writeSeoSite(workspaceRoot: string, site: SeoSite): SeoSite {
  ensureSeoOpsLayout(workspaceRoot);
  const validated = validateSeoSite(site as unknown as JsonObject);
  const dir = seoSiteDir(workspaceRoot, validated.site_id);
  fs.mkdirSync(path.join(dir, "metrics"), { recursive: true });
  fs.mkdirSync(path.join(dir, "content-tasks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "backlinks"), { recursive: true });
  writeJsonFileAtomic(path.join(dir, "site.json"), validated);
  return validated;
}

export type CreateSeoSiteInput = {
  site_id: string;
  name: string;
  primary_domain: string;
  status?: SeoSiteStatus;
  locale?: "zh" | "en" | "multi";
  markets?: string[];
  icp?: string | null;
  one_liner?: string | null;
  search_fit?: string | null;
  ga4_property_id?: string | null;
  gsc_site_url?: string | null;
  clarity_project_id?: string | null;
  notes?: string[];
};

export function createSeoSite(workspaceRoot: string, input: CreateSeoSiteInput): SeoSite {
  assertSiteId(input.site_id);
  ensureSeoOpsLayout(workspaceRoot);
  const dir = seoSiteDir(workspaceRoot, input.site_id);
  if (fs.existsSync(path.join(dir, "site.json"))) {
    throw new Error(`SEO site already exists: ${input.site_id}`);
  }
  const now = utcNow();
  const site: SeoSite = {
    schema: "wanghai.seo.site",
    schema_version: 1,
    site_id: input.site_id,
    name: input.name.trim(),
    primary_domain: input.primary_domain.trim().replace(/^https?:\/\//, "").replace(/\/$/, ""),
    status: input.status ?? "planning",
    locale: input.locale ?? "en",
    markets: input.markets?.length ? input.markets : ["global"],
    positioning: {
      icp: input.icp ?? null,
      one_liner: input.one_liner ?? null,
      search_fit: input.search_fit ?? null,
    },
    integrations: {
      ga4_property_id: input.ga4_property_id ?? null,
      gsc_site_url: input.gsc_site_url ?? null,
      clarity_project_id: input.clarity_project_id ?? null,
    },
    playbook: {
      version: SEO_PLAYBOOK_VERSION,
      task_states: defaultTaskStates(now),
    },
    notes: input.notes ?? [],
    created_at: now,
    updated_at: now,
  };
  return writeSeoSite(workspaceRoot, site);
}

export function listSeoSites(workspaceRoot: string): SeoSite[] {
  ensureSeoOpsLayout(workspaceRoot);
  const dir = seoSitesDir(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      try {
        return readSeoSite(workspaceRoot, entry.name);
      } catch {
        return null;
      }
    })
    .filter((site): site is SeoSite => site !== null)
    .sort((a, b) => a.site_id.localeCompare(b.site_id));
}

export type PatchSeoSiteInput = Partial<{
  name: string;
  primary_domain: string;
  status: SeoSiteStatus;
  locale: "zh" | "en" | "multi";
  markets: string[];
  positioning: Partial<SeoSite["positioning"]>;
  integrations: Partial<SeoSite["integrations"]>;
  notes: string[];
}>;

export function patchSeoSite(
  workspaceRoot: string,
  siteId: string,
  patch: PatchSeoSiteInput,
): SeoSite {
  const current = readSeoSite(workspaceRoot, siteId);
  const next: SeoSite = {
    ...current,
    name: patch.name?.trim() || current.name,
    primary_domain: patch.primary_domain
      ? patch.primary_domain.trim().replace(/^https?:\/\//, "").replace(/\/$/, "")
      : current.primary_domain,
    status: patch.status ?? current.status,
    locale: patch.locale ?? current.locale,
    markets: patch.markets ?? current.markets,
    positioning: {
      ...current.positioning,
      ...(patch.positioning ?? {}),
    },
    integrations: {
      ...current.integrations,
      ...(patch.integrations ?? {}),
    },
    notes: patch.notes ?? current.notes,
    updated_at: utcNow(),
  };
  // Ensure playbook tasks stay complete if playbook version upgraded
  const states = { ...defaultTaskStates(next.updated_at), ...next.playbook.task_states };
  next.playbook = {
    version: SEO_PLAYBOOK_VERSION,
    task_states: states,
  };
  return writeSeoSite(workspaceRoot, next);
}

export function setSeoTaskState(
  workspaceRoot: string,
  siteId: string,
  taskId: string,
  status: SeoTaskStatus,
  note?: string | null,
): SeoSite {
  const known = SEO_PLAYBOOK_TASKS.some((task) => task.id === taskId);
  if (!known) throw new Error(`Unknown playbook task: ${taskId}`);
  const site = readSeoSite(workspaceRoot, siteId);
  const now = utcNow();
  site.playbook.task_states[taskId] = {
    status,
    updated_at: now,
    note: note === undefined ? site.playbook.task_states[taskId]?.note ?? null : note,
  };
  site.playbook.version = SEO_PLAYBOOK_VERSION;
  site.updated_at = now;
  return writeSeoSite(workspaceRoot, site);
}

export function listSeoMetrics(workspaceRoot: string, siteId: string): SeoMetricsSnapshot[] {
  const dir = path.join(seoSiteDir(workspaceRoot, siteId), "metrics");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const raw = readJsonFile<JsonObject>(path.join(dir, name));
      if (!raw || !isJsonObject(raw)) return null;
      try {
        return validateSeoMetrics(raw);
      } catch {
        return null;
      }
    })
    .filter((item): item is SeoMetricsSnapshot => item !== null)
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at));
}

export function saveSeoMetrics(
  workspaceRoot: string,
  snapshot: SeoMetricsSnapshot,
): SeoMetricsSnapshot {
  const validated = validateSeoMetrics(snapshot as unknown as JsonObject);
  const dir = path.join(seoSiteDir(workspaceRoot, validated.site_id), "metrics");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = validated.captured_at.replace(/[:.]/g, "-");
  const file = path.join(dir, `${stamp}-${validated.source}.json`);
  writeJsonFileAtomic(file, validated);
  return validated;
}

export function createManualMetricsSnapshot(
  workspaceRoot: string,
  siteId: string,
  input: {
    period_start: string;
    period_end: string;
    totals?: Partial<SeoMetricsSnapshot["totals"]>;
    top_pages?: SeoMetricsSnapshot["top_pages"];
    top_queries?: SeoMetricsSnapshot["top_queries"];
    notes?: string[];
    source?: SeoMetricsSnapshot["source"];
  },
): SeoMetricsSnapshot {
  readSeoSite(workspaceRoot, siteId); // ensure exists
  const emptyTotals = {
    sessions: null,
    users: null,
    pageviews: null,
    organic_sessions: null,
    clicks: null,
    impressions: null,
    ctr: null,
    avg_position: null,
  };
  const snapshot: SeoMetricsSnapshot = {
    schema: "wanghai.seo.metrics-snapshot",
    schema_version: 1,
    site_id: siteId,
    source: input.source ?? "manual",
    period_start: input.period_start,
    period_end: input.period_end,
    captured_at: utcNow(),
    totals: { ...emptyTotals, ...(input.totals ?? {}) },
    top_pages: input.top_pages ?? [],
    top_queries: input.top_queries ?? [],
    notes: input.notes ?? [],
  };
  return saveSeoMetrics(workspaceRoot, snapshot);
}

/**
 * Placeholder for GA4 Data API sync.
 * Requires GA4_PROPERTY access via env later; v1 stores manual or stub snapshots.
 */
export function syncGa4MetricsPlaceholder(
  workspaceRoot: string,
  siteId: string,
  options?: { period_start?: string; period_end?: string },
): SeoMetricsSnapshot {
  const site = readSeoSite(workspaceRoot, siteId);
  const end = options?.period_end ?? new Date().toISOString().slice(0, 10);
  const start =
    options?.period_start
    ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const notes = [
    "GA4 live sync not configured in v1.",
    site.integrations.ga4_property_id
      ? `Configured property: ${site.integrations.ga4_property_id}`
      : "Set integrations.ga4_property_id on the site, then wire GA4 Data API credentials.",
  ];
  return createManualMetricsSnapshot(workspaceRoot, siteId, {
    period_start: start,
    period_end: end,
    source: "ga4",
    notes,
    totals: {},
  });
}

export type SeoSiteSummary = {
  site_id: string;
  name: string;
  primary_domain: string;
  status: SeoSiteStatus;
  locale: string;
  markets: string[];
  playbook_version: string;
  progress: ReturnType<typeof playbookProgress>;
  ga4_property_id: string | null;
  gsc_site_url: string | null;
  latest_metrics: SeoMetricsSnapshot | null;
  updated_at: string;
};

export function seoSiteSummary(workspaceRoot: string, site: SeoSite): SeoSiteSummary {
  const metrics = listSeoMetrics(workspaceRoot, site.site_id);
  return {
    site_id: site.site_id,
    name: site.name,
    primary_domain: site.primary_domain,
    status: site.status,
    locale: site.locale,
    markets: site.markets,
    playbook_version: site.playbook.version,
    progress: playbookProgress(site.playbook.task_states),
    ga4_property_id: site.integrations.ga4_property_id,
    gsc_site_url: site.integrations.gsc_site_url,
    latest_metrics: metrics[0] ?? null,
    updated_at: site.updated_at,
  };
}

export function seoSiteDetail(workspaceRoot: string, siteId: string) {
  const site = readSeoSite(workspaceRoot, siteId);
  const tasks = SEO_PLAYBOOK_TASKS.map((task) => ({
    ...task,
    section_title: SEO_PLAYBOOK_SECTIONS[task.section as SeoPlaybookSectionId].title,
    state: site.playbook.task_states[task.id] ?? {
      status: "todo" as const,
      updated_at: site.updated_at,
      note: null,
    },
  }));
  const sections = (Object.keys(SEO_PLAYBOOK_SECTIONS) as SeoPlaybookSectionId[]).map((id) => ({
    id,
    ...SEO_PLAYBOOK_SECTIONS[id],
    tasks: tasks.filter((task) => task.section === id),
  }));
  return {
    site,
    summary: seoSiteSummary(workspaceRoot, site),
    sections,
    metrics: listSeoMetrics(workspaceRoot, siteId).slice(0, 20),
    playbook_version: SEO_PLAYBOOK_VERSION,
  };
}

export {
  SEO_PLAYBOOK_TASKS,
  SEO_PLAYBOOK_SECTIONS,
  SEO_PLAYBOOK_VERSION,
  playbookProgress,
};
export type { SeoPlaybookSectionId, SeoTaskStatus } from "./seo-playbook.js";
