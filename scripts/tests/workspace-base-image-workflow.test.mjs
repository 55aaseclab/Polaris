import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT_DIR = path.resolve(import.meta.dirname, "..", "..");
const WORKFLOW_PATH = path.join(
  ROOT_DIR,
  ".github",
  "workflows",
  "build-workspace-base-image.yml",
);

test("Polaris workspace base workflow publishes the source-owned Dockerfile", () => {
  const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /config\/docker\/vault-prebuilt\.Dockerfile/u);
  assert.match(workflow, /IMAGE_NAME: ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/polaris-workspace-base/u);
  assert.match(workflow, /packages: write/u);
  assert.match(workflow, /id-token: write/u);
  assert.match(workflow, /docker\/build-push-action@v6/u);
  assert.match(workflow, /push: true/u);
  assert.match(workflow, /steps\.build\.outputs\.digest/u);
  assert.match(workflow, /anchore\/sbom-action@4a30bbadbe35d73a1729ee95a9196544192d905e/u);
  assert.match(workflow, /cosign attest --yes --type slsaprovenance/u);
  assert.match(workflow, /cosign attest --yes --type spdxjson/u);
  assert.match(workflow, /cosign sign --yes/u);
  assert.match(workflow, /cosign verify-attestation/u);
  assert.match(workflow, /certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/u);
  assert.doesNotMatch(workflow, /type=raw,value=latest/u);
  assert.doesNotMatch(workflow, /PUBLISH_ATTESTATIONS/u);
});

test("the clean checkout keeps the optional Paseo bundle link without requiring generated state", () => {
  const dockerfile = fs.readFileSync(
    path.join(ROOT_DIR, "config", "docker", "vault-prebuilt.Dockerfile"),
    "utf8",
  );
  const installer = fs.readFileSync(
    path.join(ROOT_DIR, "config", "docker", "base-tools", "install-base-tools.sh"),
    "utf8",
  );

  assert.match(dockerfile, /COPY apps\/paseo\/tool-bundle \/tmp\/paseo-tool-bundle/u);
  assert.match(installer, /if \[ -x "\$PASEO_TOOL_BUNDLE_DIR\/bin\/paseo" \]/u);
  assert.match(installer, /npm install -g --prefix "\$TOOL_PREFIX" @getpaseo\/cli@latest/u);
});
