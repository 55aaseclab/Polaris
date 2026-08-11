import {
  addDomainPack,
  listDomainPacks,
  removeDomainPack,
} from "../../config/domain-packs.js";
import { logInfo } from "../../utils/log.js";

function usage(): never {
  throw new Error(
    "Usage: pnpm --dir apps/polaris run polaris -- pack <add|list|remove> ...",
  );
}

function parseVersionFlag(argv: string[]): string | undefined {
  const index = argv.findIndex((value) => value === "--version");
  if (index === -1) {
    return undefined;
  }
  const version = argv[index + 1]?.trim();
  if (!version || argv.some((value, offset) => value === "--version" && offset !== index)) {
    usage();
  }
  return version;
}

export async function packCommand(argv: string[]): Promise<void> {
  const [action, ...rest] = argv;
  if (action === "add") {
    const inputPath = rest[0]?.trim();
    if (!inputPath || rest.length !== 1) {
      throw new Error(
        "Usage: pnpm --dir apps/polaris run polaris -- pack add <file.ord|pack-directory>",
      );
    }
    const result = await addDomainPack(import.meta.url, inputPath);
    logInfo("cli", "domain-pack-added", {
      id: result.pack.id,
      version: result.pack.version,
      status: result.pack.status,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (action === "list") {
    if (rest.length > 0) {
      usage();
    }
    const packs = listDomainPacks(import.meta.url);
    process.stdout.write(`${JSON.stringify({ packs }, null, 2)}\n`);
    return;
  }

  if (action === "remove") {
    const id = rest[0]?.trim();
    const version = parseVersionFlag(rest);
    const positional = rest.filter((value) => value !== "--version" && value !== version);
    if (!id || positional.length !== 1) {
      throw new Error(
        "Usage: pnpm --dir apps/polaris run polaris -- pack remove <domain> [--version <x.y.z>]",
      );
    }
    const pack = await removeDomainPack(import.meta.url, id, version);
    logInfo("cli", "domain-pack-removed", {
      id: pack.id,
      version: pack.version,
    });
    process.stdout.write(`${JSON.stringify({ pack }, null, 2)}\n`);
    return;
  }

  usage();
}
