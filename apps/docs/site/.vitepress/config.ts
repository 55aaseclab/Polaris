import { defineConfig } from "vitepress";
import { docsDiffs } from "./theme/generated/docs-data.ts";

function titleize(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function diffFileLabel(filePath: string) {
  const parts = filePath.split("/");
  const last = parts.at(-1) ?? filePath;
  if (last === "index.md") {
    return parts.length > 1 ? `${titleize(parts[0] ?? "")} Overview` : "Overview";
  }
  return titleize(last.replace(/\.md$/i, ""));
}

function buildDiffSidebar() {
  const filePaths = Array.from(
    new Set(
      docsDiffs
        .filter((entry) => entry.leftVersion === "0.2.4" && entry.rightVersion === "latest")
        .map((entry) => entry.path),
    ),
  ).sort();

  const rootItems: Array<{ text: string; link: string }> = [];
  const groups = new Map<string, Array<{ text: string; link: string }>>();

  for (const filePath of filePaths) {
    const parts = filePath.split("/");
    const slug = filePath
      .replace(/\.md$/i, "")
      .replace(/^index$/i, "overview")
      .split("/")
      .map((part) => part.replace(/[^a-zA-Z0-9-_]/g, "-"))
      .join("/");
    const link = `/diff/${slug}`;
    if (filePath === "index.md") {
      continue;
    }
    if (parts.length === 1) {
      rootItems.push({ text: diffFileLabel(filePath), link });
      continue;
    }
    const group = parts[0]!;
    const itemText = diffFileLabel(filePath);
    const items = groups.get(group) ?? [];
    items.push({ text: itemText, link });
    groups.set(group, items);
  }

  const sidebar: Array<{ text?: string; items: Array<{ text: string; link: string }> }> = [];

  if (rootItems.length > 0) {
    sidebar.push({
      text: "Files",
      items: rootItems,
    });
  }

  for (const [group, items] of Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    sidebar.push({
      text: titleize(group),
      items,
    });
  }

  return sidebar;
}

export default defineConfig({
  title: "Polaris Docs",
  description: "Versioned Polaris documentation with inline diff browsing.",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: false,
  themeConfig: {
    siteTitle: "Polaris Docs",
    nav: [
      { text: "Latest", link: "/latest/" },
      { text: "0.2.4", link: "/0.2.4/" },
      { text: "Diff", link: "/diff/" },
    ],
    sidebar: {
      "/latest/": [
        {
          text: "Latest",
          items: [
            { text: "Overview", link: "/latest/" },
            { text: "Version", link: "/latest/VERSION" },
            { text: "Changelog", link: "/latest/CHANGELOG" },
          ],
        },
        {
          text: "Polaris",
          items: [
            { text: "What Your Team Gets", link: "/latest/polaris/what-your-team-gets" },
            { text: "Overview", link: "/latest/polaris/" },
            { text: "Agent Swarm Maturity", link: "/latest/polaris/agent-swarm-maturity" },
          ],
        },
        {
          text: "Onboarding",
          items: [
            { text: "Overview", link: "/latest/polaris/onboarding/" },
            { text: "Shared Docker Foundation", link: "/latest/polaris/onboarding/shared-docker-foundation" },
            { text: "Workspace Command Surface", link: "/latest/polaris/onboarding/workspace-command-surface" },
            { text: "Others", link: "/latest/polaris/onboarding/others" },
          ],
        },
        {
          text: "Governed Use",
          items: [
            { text: "Overview", link: "/latest/polaris/governed-use/" },
            { text: "Ownership Model", link: "/latest/polaris/governed-use/ownership-model" },
            { text: "Credential Switch", link: "/latest/polaris/governed-use/credential-switch" },
            { text: "Clerk Integration", link: "/latest/polaris/governed-use/clerk-integration" },
          ],
        },
        {
          text: "Shared Infrastructure",
          items: [
            { text: "Overview", link: "/latest/polaris/shared-infrastructure/" },
            { text: "Isolation Boundary", link: "/latest/polaris/shared-infrastructure/isolation-boundary" },
            { text: "Runtime State And Driver Switching", link: "/latest/polaris/shared-infrastructure/runtime-state-and-driver-switching" },
            { text: "Others", link: "/latest/polaris/shared-infrastructure/others" },
          ],
        },
        {
          text: "Member Exit And Handover",
          items: [
            { text: "Overview", link: "/latest/polaris/member-exit-and-handover/" },
            { text: "Personal And Team Context", link: "/latest/polaris/member-exit-and-handover/personal-and-team-context" },
            { text: "Others", link: "/latest/polaris/member-exit-and-handover/others" },
          ],
        },
        {
          text: "Operations",
          items: [
            { text: "Remote Deploy", link: "/latest/operations/remote-deploy" },
            { text: "K3s Multi-Machine Setup", link: "/latest/operations/setup-k3s-across-multiple-machines" },
          ],
        },
        {
          text: "Tooling",
          items: [
            { text: "Workspace README", link: "/latest/tooling/workspace/" },
            { text: "Host README", link: "/latest/tooling/host/" },
            { text: "Alacritty", link: "/latest/tooling/host/alacritty" },
          ],
        },
      ],
      "/0.2.4/": [
        {
          text: "0.2.4",
          items: [
            { text: "Overview", link: "/0.2.4/" },
          ],
        },
        {
          text: "Polaris",
          items: [
            { text: "Overview", link: "/0.2.4/polaris/" },
            { text: "What Your Team Gets", link: "/0.2.4/polaris/what-your-team-gets" },
            { text: "Onboarding", link: "/0.2.4/polaris/onboarding/" },
            { text: "Governed Use", link: "/0.2.4/polaris/governed-use/" },
            { text: "Shared Infrastructure", link: "/0.2.4/polaris/shared-infrastructure/" },
            { text: "Member Exit And Handover", link: "/0.2.4/polaris/member-exit-and-handover/" },
            { text: "Agent Swarm Maturity", link: "/0.2.4/polaris/agent-swarm-maturity" },
          ],
        },
        {
          text: "Operations",
          items: [
            { text: "Remote Deploy", link: "/0.2.4/operations/remote-deploy" },
            { text: "K3s Multi-Machine Setup", link: "/0.2.4/operations/setup-k3s-across-multiple-machines" },
          ],
        },
        {
          text: "Tooling",
          items: [
            { text: "Workspace README", link: "/0.2.4/tooling/workspace/" },
            { text: "Host README", link: "/0.2.4/tooling/host/" },
            { text: "Alacritty", link: "/0.2.4/tooling/host/alacritty" },
          ],
        },
      ],
      "/diff/": [
        {
          text: "Diff",
          items: [
            { text: "Overview", link: "/diff/" },
          ],
        },
        ...buildDiffSidebar(),
      ],
      "/": [
        {
          text: "Docs",
          items: [
            { text: "Home", link: "/" },
            { text: "Diff", link: "/diff/" },
          ],
        },
      ],
    },
  },
});
