import fs from "node:fs";
import path from "node:path";
import { listOwnedWorkspaces } from "../../core/portal.js";
import { polarisUsersRoot } from "../../utils/paths.js";

function readRawText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readRawJson(filePath: string): unknown | null {
  const raw = readRawText(filePath);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readRawWorkspace(userId: string, name: string): Record<string, unknown> {
  const root = path.join(polarisUsersRoot(import.meta.url), userId, "workspaces", name);
  return {
    name,
    raw: {
      dockerAgentYaml: readRawText(path.join(root, "docker.agent.yaml")),
      podAgentYaml: readRawText(path.join(root, "pod.agent.yaml")),
      kubevirtAgentYaml: readRawText(path.join(root, "kubevirt.agent.yaml")),
      status: readRawJson(path.join(root, "state", "status.json")),
    },
  };
}

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- workspace list --user <userProfileId>",
  );
}

export async function listCommand(argv: string[]): Promise<void> {
  if (argv[0] !== "--user" || argv.length !== 2) {
    usage();
  }
  const userId = argv[1]?.trim();
  if (!userId) {
    usage();
  }

  process.stdout.write(`${JSON.stringify({
    userId,
    workspaces: listOwnedWorkspaces(userId).map((name) => readRawWorkspace(userId, name)),
  }, null, 2)}\n`);
}
