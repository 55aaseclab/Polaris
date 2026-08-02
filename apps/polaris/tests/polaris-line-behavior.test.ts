import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import {
  readUserAccessSummary,
  upsertUserMapEntries,
} from "../scripts/portal/user-map.js";
import {
  scaffoldDockerVault,
  scaffoldUserProfileById,
  vaultImageRef,
} from "../scripts/config/scaffold.js";
import { ensureRequiredProfileCredentials } from "../scripts/config/credentials.js";
import { polarisUsersRoot } from "../scripts/utils/paths.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const USERS_ROOT = polarisUsersRoot(import.meta.url);

test("user access summaries preserve both as an entitlement line", async () => {
  const userMapPath = path.join(USERS_ROOT, "user-map.json");
  const originalUserMap = fs.existsSync(userMapPath) ? fs.readFileSync(userMapPath, "utf8") : null;
  const userId = `both-line-${process.pid}-${Date.now()}`;
  try {
    await upsertUserMapEntries({
      authingUsername: `${userId}@example.test`,
      entry: {
        polarisUserId: userId,
        role: "user",
        plan: "pro",
        line: "both",
      },
    });
    assert.equal(readUserAccessSummary(userId)?.line, "both");
  } finally {
    if (originalUserMap === null) {
      fs.rmSync(userMapPath, { force: true });
    } else {
      fs.writeFileSync(userMapPath, originalUserMap, "utf8");
    }
  }
});

test("scaffoldDockerVault ignores a retired user default docker base image", async () => {
  const project = `retired-default-${process.pid}-${Date.now()}`;
  const user = scaffoldUserProfileById({
    id: `retired-default-user-${process.pid}-${Date.now()}`,
    name: "Retired Default User",
    email: `retired-default-${process.pid}-${Date.now()}@polaris.local`,
  });
  ensureRequiredProfileCredentials(user.id);
  const profilePath = path.join(USERS_ROOT, "profiles", `${user.id}.yaml`);
  let outputPath = "";
  try {
    const profile = (yaml.load(fs.readFileSync(profilePath, "utf8")) ?? {}) as Record<string, any>;
    profile.vault_defaults = {
      docker: {
        runtime: {
          base_image: "ttl.sh/retired-default:24h",
        },
      },
    };
    fs.writeFileSync(profilePath, yaml.dump(profile, { lineWidth: 120, noRefs: true }), "utf8");

    outputPath = scaffoldDockerVault(project, user.id, { line: "coding" });
    const doc = (yaml.load(fs.readFileSync(outputPath, "utf8")) ?? {}) as Record<string, any>;
    assert.equal(doc.runtime?.base_image, vaultImageRef(user.id, project));
  } finally {
    if (outputPath) {
      fs.rmSync(path.dirname(outputPath), { recursive: true, force: true });
    }
    fs.rmSync(profilePath, { force: true });
    fs.rmSync(path.join(USERS_ROOT, user.id), { recursive: true, force: true });
  }
});
