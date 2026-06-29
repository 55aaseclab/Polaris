import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const appRoot = process.cwd();
const docsRoot = path.join(appRoot, "site");
const outputPath = path.join(
  appRoot,
  "site",
  ".vitepress",
  "theme",
  "generated",
  "docs-data.ts",
);
const diffDocsRoot = path.join(appRoot, "site", "diff");

function walk(dir, baseDir = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walk(absolute, baseDir);
    }
    return [path.relative(baseDir, absolute).replace(/\\/g, "/")];
  });
}

function fileTitle(filePath) {
  if (filePath === "index.md") {
    return "Overview";
  }
  const name = path.basename(filePath, path.extname(filePath));
  return name === "index" ? path.dirname(filePath).split(path.sep).pop() || "index" : name;
}

const versionDirs = fs
  .readdirSync(docsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => !name.startsWith(".") && name !== "diff")
  .sort((left, right) => (left === "latest"
    ? 1
    : right === "latest"
      ? -1
      : left.localeCompare(right, undefined, { numeric: true })));

const latestReleaseVersion = versionDirs.filter((version) => version !== "latest").at(-1) ?? null;

const versions = versionDirs.map((version) => {
  const versionRoot = path.join(docsRoot, version);
  const files = walk(versionRoot)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => ({
      path: file,
      title: fileTitle(file),
      content: fs.readFileSync(path.join(versionRoot, file), "utf8"),
    }));
  return {
    version,
    files,
  };
});

function unifiedDiff(leftVersion, rightVersion, filePath, leftContent, rightContent) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-docs-diff-"));
  const leftRoot = path.join(tempRoot, leftVersion);
  const rightRoot = path.join(tempRoot, rightVersion);
  const leftPath = path.join(leftRoot, filePath);
  const rightPath = path.join(rightRoot, filePath);
  fs.mkdirSync(path.dirname(leftPath), { recursive: true });
  fs.mkdirSync(path.dirname(rightPath), { recursive: true });
  fs.writeFileSync(leftPath, leftContent, "utf8");
  fs.writeFileSync(rightPath, rightContent, "utf8");
  try {
    const result = spawnSync(
      "git",
      [
        "diff",
        "--no-index",
        "--text",
        "--unified=3",
        "--no-color",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        path.join(leftVersion, filePath),
        path.join(rightVersion, filePath),
      ],
      {
        cwd: tempRoot,
        encoding: "utf8",
      },
    );

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0 && result.status !== 1) {
      throw new Error(result.stderr || `git diff failed with status ${result.status}`);
    }

    const output = (result.stdout || "").trim();
    return output || "No textual differences.";
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

const diffs = [];
for (let leftIndex = 0; leftIndex < versions.length; leftIndex += 1) {
  for (let rightIndex = leftIndex + 1; rightIndex < versions.length; rightIndex += 1) {
    const left = versions[leftIndex];
    const right = versions[rightIndex];
    if (!left || !right) {
      continue;
    }
    const pathSet = new Set([
      ...left.files.map((file) => file.path),
      ...right.files.map((file) => file.path),
    ]);
    for (const filePath of Array.from(pathSet).sort()) {
      const leftFile = left.files.find((file) => file.path === filePath);
      const rightFile = right.files.find((file) => file.path === filePath);
      diffs.push({
        leftVersion: left.version,
        rightVersion: right.version,
        path: filePath,
        unified: unifiedDiff(
          left.version,
          right.version,
          filePath,
          leftFile?.content ?? "",
          rightFile?.content ?? "",
        ),
      });
    }
  }
}

function safeSlug(filePath) {
  const withoutExt = filePath.replace(/\.md$/i, "");
  const normalized = withoutExt === "index" ? "overview" : withoutExt;
  return normalized
    .split("/")
    .map((part) => part.replace(/[^a-zA-Z0-9-_]/g, "-"))
    .join("/");
}

function resetDiffDocs(rootDir) {
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.mkdirSync(rootDir, { recursive: true });
}

function writeDiffDocs(diffEntries) {
  resetDiffDocs(diffDocsRoot);
  for (const entry of diffEntries) {
    if (
      !latestReleaseVersion
      || entry.leftVersion !== latestReleaseVersion
      || entry.rightVersion !== "latest"
    ) {
      continue;
    }
    const slug = safeSlug(entry.path);
    const relativePath = `${slug}.md`;
    const targetPath = path.join(diffDocsRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const title = fileTitle(entry.path);
    const content = [
      "---",
      `title: ${title}`,
      "aside: false",
      "pageClass: diff-page",
      `diffPath: ${JSON.stringify(entry.path)}`,
      `leftVersion: ${JSON.stringify(entry.leftVersion)}`,
      `rightVersion: ${JSON.stringify(entry.rightVersion)}`,
      "---",
      "",
      "<DocsDiff />",
      "",
    ].join("\n");
    fs.writeFileSync(targetPath, content, "utf8");
  }

  const indexLines = [
    "---",
    "title: Diff",
    "pageClass: diff-page",
    "---",
    "",
    "# Diff",
    "",
    latestReleaseVersion
      ? `Compare \`${latestReleaseVersion}\` against \`latest\` from the sidebar.`
      : "Open a file from the sidebar.",
    "",
  ];
  fs.writeFileSync(path.join(diffDocsRoot, "index.md"), indexLines.join("\n"), "utf8");
}

const source = `export interface DocsFileData {
  path: string;
  title: string;
  content: string;
}

export interface DocsVersionData {
  version: string;
  files: DocsFileData[];
}

export interface DocsDiffData {
  leftVersion: string;
  rightVersion: string;
  path: string;
  unified: string;
}

export const docsVersions: DocsVersionData[] = ${JSON.stringify(versions, null, 2)} as const;
export const docsDiffs: DocsDiffData[] = ${JSON.stringify(diffs, null, 2)} as const;
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${source}\n`, "utf8");
writeDiffDocs(diffs);
