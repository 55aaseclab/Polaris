import fs from "node:fs";
import path from "node:path";

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

const latestRoot = path.join(docsRoot, "latest");
const versions = [
  {
    version: "current",
    files: walk(latestRoot)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => ({
        path: file,
        title: fileTitle(file),
        content: fs.readFileSync(path.join(latestRoot, file), "utf8"),
      })),
  },
];

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
export const docsDiffs: DocsDiffData[] = [] as const;
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${source}\n`, "utf8");
