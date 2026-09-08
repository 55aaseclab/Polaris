import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { moduleSummary, workspaceFromContext, type RouteContext } from "../../../_lib";

export async function GET(_request: Request, context: RouteContext<{ workspace: string }>) {
  try {
    const { root, paths } = await workspaceFromContext(context);
    const topics = ["社交媒体运营", "销售市场分析"].map((name) => researchTopicSummary(paths.marketResearchDir, name, root));
    return NextResponse.json({
      modules: moduleSummary(root),
      research: {
        topics,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

function researchTopicSummary(marketResearchDir: string, name: string, workspaceRoot: string) {
  const topicDir = path.join(marketResearchDir, name);
  const latestRunPath = path.join(topicDir, "state", "latest-run.json");
  const latestRun = fs.existsSync(latestRunPath) ? JSON.parse(fs.readFileSync(latestRunPath, "utf-8")) : null;
  const strategyLatestPath = path.join(topicDir, "reports", "strategy", "latest.pdf");
  const exportedReportsDir = path.join(topicDir, "reports", "exported");
  const reportsDir = path.join(topicDir, "reports");
  const reports = [
    ...(fs.existsSync(strategyLatestPath) ? [fileSummary(strategyLatestPath, workspaceRoot)] : []),
    ...listPdfFiles(reportsDir, workspaceRoot, 20),
    ...listPdfFiles(exportedReportsDir, workspaceRoot, 20),
  ];
  return {
    name,
    path: path.relative(workspaceRoot, topicDir).split(path.sep).join("/"),
    exists: fs.existsSync(topicDir) && fs.statSync(topicDir).isDirectory(),
    latest_run: latestRun,
    latest_report: reports[0] ?? null,
    reports,
  };
}

function fileSummary(filePath: string, workspaceRoot: string) {
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    path: path.relative(workspaceRoot, filePath).split(path.sep).join("/"),
    size: stat.size,
    modified_at: stat.mtime.toISOString(),
  };
}

function listPdfFiles(rootDir: string, workspaceRoot: string, limit: number) {
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => fileSummary(path.join(rootDir, entry.name), workspaceRoot))
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at))
    .slice(0, limit);
}
