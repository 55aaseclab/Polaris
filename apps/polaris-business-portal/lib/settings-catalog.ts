import "server-only";

import fs from "node:fs";
import path from "node:path";
import { allowsLocalSmtpSettings } from "@/lib/settings-runtime-policy";

export type SettingsCatalog = {
  credentials: SettingsCredential[];
  generated_at: string;
  skills: SettingsSkill[];
  tools: SettingsTool[];
};

export type SettingsTool = {
  cli: string | null;
  description: string;
  id: string;
  package_name: string | null;
  path: string;
  title: string;
};

export type SettingsSkill = {
  description: string;
  id: string;
  path: string;
  source: "bundled" | "repo";
  title: string;
};

export type SettingsCredential = {
  description: string;
  id: string;
  keys: string[];
  locations: string[];
  status: "configured" | "missing" | "partial";
  title: string;
  used_by: string[];
};

type CredentialSpec = {
  description: string;
  file_checks?: Array<{
    keys?: string[];
    path: string;
  }>;
  id: string;
  keys: string[];
  mode: "all" | "any";
  optional_keys?: string[];
  title: string;
  used_by: string[];
};

const CREDENTIAL_SPECS: CredentialSpec[] = [
  {
    description: "社交媒体采集与广告内容情报使用的 JustOneAPI 访问令牌。",
    file_checks: [{ keys: ["JUSTONEAPI_TOKEN"], path: "tools/social-media/.env" }],
    id: "justoneapi-token",
    keys: ["JUSTONEAPI_TOKEN"],
    mode: "all",
    title: "JustOneAPI token",
    used_by: ["tools/social-media", "tools/data-collection"],
  },
  {
    description: "Codex 及相关智能分析、报告生成流程使用的 OpenAI 密钥。",
    id: "openai-api-key",
    keys: ["OPENAI_API_KEY"],
    mode: "any",
    title: "OpenAI API key",
    used_by: ["tools/codex", "tools/intelligence-analysis", "tools/report-writing"],
  },
  {
    description: "文献批量扩展与检索使用的 Semantic Scholar API 密钥。",
    id: "semantic-scholar-api-key",
    keys: ["SEMANTIC_SCHOLAR_API_KEY"],
    mode: "all",
    title: "Semantic Scholar API key",
    used_by: ["tools/data-collection", "tools/semantic-scholar"],
  },
  {
    description: "客户触达 live send 使用的 SMTP 发信凭证。",
    id: "smtp-delivery",
    keys: ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "OUTREACH_FROM_EMAIL"],
    mode: "all",
    optional_keys: ["OUTREACH_FROM_NAME", "OUTREACH_REPLY_TO", "SMTP_SECURE"],
    title: "SMTP 发信凭证",
    used_by: ["tools/outreach"],
  },
  {
    description: "clue-browser 在受限站点访问时使用的代理配置。",
    id: "browser-proxy",
    keys: ["BROWSER_PROXY_SERVER", "BROWSER_PROXY_USERNAME", "BROWSER_PROXY_PASSWORD"],
    mode: "all",
    title: "Browser proxy",
    used_by: ["tools/browser", "tools/data-collection"],
  },
  {
    description: "浏览器 challenge 辅助视觉模型访问密钥。",
    id: "browser-challenge-vision",
    keys: ["BROWSER_CHALLENGE_VISION_API_KEY"],
    mode: "any",
    optional_keys: ["BROWSER_CHALLENGE_VISION_BASE_URL", "BROWSER_CHALLENGE_VISION_MODEL"],
    title: "Browser challenge vision",
    used_by: ["tools/browser"],
  },
  {
    description: "视频与多模态相关流程使用的 JieKou API 密钥。",
    id: "jiekou-api-key",
    keys: ["JIEKOU_API_KEY"],
    mode: "any",
    optional_keys: ["JIEKOU_BASE_URL"],
    title: "JieKou API key",
    used_by: ["tools/product-video"],
  },
];

export function loadSettingsCatalog(): SettingsCatalog {
  const repoRoot = findRepoRoot();
  return {
    credentials: buildCredentials(repoRoot),
    generated_at: new Date().toISOString(),
    skills: scanSkills(repoRoot),
    tools: scanTools(repoRoot),
  };
}

function findRepoRoot(): string {
  const envRoot = process.env.POLARIS_REPO_ROOT?.trim();
  if (envRoot && fs.existsSync(path.join(envRoot, "tools", "outreach", "clue-outreach"))) {
    return path.resolve(envRoot);
  }

  let current = path.resolve(process.cwd());
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(current, "tools", "outreach", "clue-outreach"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const fromApp = path.resolve(process.cwd(), "../..");
  if (fs.existsSync(path.join(fromApp, "tools", "outreach", "clue-outreach"))) {
    return fromApp;
  }
  throw new Error("Cannot locate repository root (set POLARIS_REPO_ROOT)");
}

function scanTools(repoRoot: string): SettingsTool[] {
  const toolsRoot = path.join(repoRoot, "tools");
  if (!fs.existsSync(toolsRoot)) return [];

  return fs.readdirSync(toolsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const toolRoot = path.join(toolsRoot, entry.name);
      const readme = readFileIfPresent(path.join(toolRoot, "README.md"));
      const packageJson = readJsonIfPresent(path.join(toolRoot, "package.json"));
      return {
        cli: findCliEntrypoint(toolRoot),
        description: firstMarkdownParagraph(readme)
          || readString(packageJson?.description)
          || "仓库工具目录。",
        id: entry.name,
        package_name: readString(packageJson?.name),
        path: relativeRepoPath(repoRoot, toolRoot),
        title: startCase(entry.name),
      };
    })
    .sort((left, right) => left.title.localeCompare(right.title, "zh-CN"));
}

function scanSkills(repoRoot: string): SettingsSkill[] {
  const sources: Array<{ path: string; source: SettingsSkill["source"] }> = [
    { path: path.join(repoRoot, "skills"), source: "repo" },
    { path: path.join(repoRoot, "third_party", "social-auto-upload", "skills"), source: "bundled" },
  ];
  const skills: SettingsSkill[] = [];

  for (const source of sources) {
    if (!fs.existsSync(source.path)) continue;
    for (const entry of fs.readdirSync(source.path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(source.path, entry.name, "SKILL.md");
      const skillText = readFileIfPresent(skillPath);
      if (!skillText) continue;
      skills.push({
        description: firstMarkdownParagraph(skillText) || "仓库技能说明。",
        id: entry.name,
        path: relativeRepoPath(repoRoot, skillPath),
        source: source.source,
        title: firstMarkdownHeading(skillText) || startCase(entry.name),
      });
    }
  }

  return skills.sort((left, right) => {
    if (left.source !== right.source) return left.source === "repo" ? -1 : 1;
    return left.title.localeCompare(right.title, "zh-CN");
  });
}

function buildCredentials(repoRoot: string): SettingsCredential[] {
  const specs = allowsLocalSmtpSettings()
    ? CREDENTIAL_SPECS
    : CREDENTIAL_SPECS.filter((spec) => spec.id !== "smtp-delivery");
  return specs.map((spec) => {
    const configuredKeys = spec.keys.filter((key) => hasEnvValue(key)).length;
    const fileConfigured = spec.file_checks?.some((check) => fileHasConfiguredValue(
      path.join(repoRoot, check.path),
      check.keys,
    )) ?? false;
    const hasPrimarySignal = configuredKeys > 0 || fileConfigured;
    const primaryReady = spec.mode === "all"
      ? spec.keys.every((key) => hasEnvValue(key))
      : hasPrimarySignal;
    const status: SettingsCredential["status"] = primaryReady
      ? "configured"
      : hasPrimarySignal
        ? "partial"
        : "missing";

    return {
      description: spec.description,
      id: spec.id,
      keys: [...spec.keys, ...(spec.optional_keys ?? [])],
      locations: [
        ".env",
        ...(spec.file_checks?.map((check) => check.path) ?? []),
      ],
      status,
      title: spec.title,
      used_by: spec.used_by,
    };
  });
}

function hasEnvValue(key: string): boolean {
  return (process.env[key] ?? "").trim().length > 0;
}

function fileHasConfiguredValue(filePath: string, keys?: string[]): boolean {
  const content = readFileIfPresent(filePath);
  if (!content) return false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (!keys || keys.length === 0) return true;
    const [name, ...rest] = line.split("=");
    if (!keys.includes(name.trim())) continue;
    if (rest.join("=").trim()) return true;
  }
  return false;
}

function findCliEntrypoint(toolRoot: string): string | null {
  for (const entry of fs.readdirSync(toolRoot, { withFileTypes: true })) {
    if (entry.isFile() && /^(clue|wanghai)-/.test(entry.name)) return entry.name;
  }
  return null;
}

function readFileIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJsonIfPresent(filePath: string): Record<string, unknown> | null {
  const text = readFileIfPresent(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstMarkdownHeading(text: string | null): string | null {
  if (!text) return null;
  const body = stripFrontMatter(text);
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("# ")) continue;
    return line.slice(2).trim();
  }
  return null;
}

function firstMarkdownParagraph(text: string | null): string {
  if (!text) return "";
  const body = stripFrontMatter(text);
  const lines = body.split(/\r?\n/);
  const paragraph: string[] = [];
  let inCodeBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (paragraph.length > 0) break;
      continue;
    }
    if (inCodeBlock) continue;
    if (!line) {
      if (paragraph.length > 0) break;
      continue;
    }
    if (paragraph.length === 0 && (
      line.startsWith("#")
      || line.startsWith("|")
      || /^[-*]\s/.test(line)
      || /^\d+\.\s/.test(line)
      || line === "---"
    )) {
      continue;
    }
    if (paragraph.length > 0 && (
      line.startsWith("#")
      || line.startsWith("|")
      || /^[-*]\s/.test(line)
      || /^\d+\.\s/.test(line)
    )) {
      break;
    }
    paragraph.push(line);
  }

  return paragraph.join(" ").replace(/\s+/g, " ").trim();
}

function stripFrontMatter(text: string): string {
  return text.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
}

function startCase(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0] ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function relativeRepoPath(repoRoot: string, targetPath: string): string {
  return path.relative(repoRoot, targetPath).replaceAll(path.sep, "/");
}
