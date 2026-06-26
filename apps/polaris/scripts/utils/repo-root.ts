import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveRepoRoot(importMetaUrl: string): string {
  let current = path.dirname(fileURLToPath(importMetaUrl));
  while (true) {
    const rootPackage = path.join(current, "package.json");
    const polarisPackage = path.join(current, "apps", "polaris", "package.json");
    if (fs.existsSync(rootPackage) && fs.existsSync(polarisPackage)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Unable to resolve repository root from ${importMetaUrl}`);
    }
    current = parent;
  }
}
