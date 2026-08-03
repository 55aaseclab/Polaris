import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("remote deploy restarts Polaris through a host systemd service", () => {
  const script = fs.readFileSync("scripts/deploy-polaris.sh", "utf8");
  assert.match(script, /systemctl enable "polaris-server@\$\{target_color\}\.service"/);
  assert.match(script, /systemctl restart "polaris-server@\$\{target_color\}\.service"/);
  assert.match(script, /pnpm run build/);
  assert.doesNotMatch(script, /POLARIS_SERVER_UID/);
  assert.doesNotMatch(script, /POLARIS_SERVER_GID/);
});

test("remote provision installs a host Polaris systemd unit", () => {
  const script = fs.readFileSync("scripts/provision-remote.sh", "utf8");
  assert.match(script, /polaris-server@\.service/);
  assert.match(script, /EnvironmentFile=-.*polaris-server-%i\.env/);
  assert.match(script, /ExecStart=\/bin\/bash .*scripts\/run-polaris-server-host\.sh/);
  assert.match(script, /sites-available\/polaris-gateway\.conf/);
  assert.match(script, /proxy_pass \\\$polaris_upstream;/);
});

test("remote provision reuses an existing Docker install instead of forcing docker.io", () => {
  const script = fs.readFileSync("scripts/provision-remote.sh", "utf8");
  assert.match(script, /if ! command -v docker >/);
  assert.match(script, /docker-ce docker-ce-cli containerd\.io docker-compose-plugin/);
  assert.doesNotMatch(script, /apt-get install -y docker\.io docker-compose-plugin nginx/);
});

test("remote provision writes the remote Wanghai data root", () => {
  const script = fs.readFileSync("scripts/provision-remote.sh", "utf8");
  assert.match(script, /POLARIS_WANGHAI_DATA_ROOT/);
  assert.match(script, /'\$\{REMOTE_DATA_ROOT\}\/wanghai'/);
  assert.match(script, /'\$\{REMOTE_DATA_ROOT\}\/wanghai\/cache'/);
});

test("remote provision bootstraps the Wanghai source tree and image", () => {
  const script = fs.readFileSync("scripts/provision-remote.sh", "utf8");
  assert.match(script, /rsync -az --delete --delete-excluded/);
  assert.match(script, /--exclude ".next\*"/);
  assert.match(script, /--exclude "\/workspaces\/\*\*\*"/);
  assert.match(script, /\$\{LOCAL_WANGHAI_DIR\}\//);
  assert.match(script, /\$\{REMOTE_HOST\}:\$\{REMOTE_WANGHAI_DIR\}\//);
  assert.match(script, /build-admin-portal-image\.sh/);
  assert.match(script, /polaris-workspace-prebuilt:latest/);
  assert.match(script, /POLARIS_WANGHAI_VAULT_IMAGE/);
});

test("bluegreen compose keeps only the web stack in Docker", () => {
  const compose = fs.readFileSync("deploy/docker-compose.polaris-bluegreen.yml", "utf8");
  assert.match(compose, /^\s*paseo-app:/m);
  assert.match(compose, /^\s*nginx:/m);
  assert.doesNotMatch(compose, /^\s*polaris-server:/m);
  assert.doesNotMatch(compose, /apps\/polaris\/Dockerfile/);
});

test("host Polaris launcher reads bind host and port from the environment", () => {
  const script = fs.readFileSync("scripts/run-polaris-server-host.sh", "utf8");
  assert.match(script, /POLARIS_SERVER_PORT/);
  assert.match(script, /POLARIS_SERVER_BIND_HOST/);
  assert.match(script, /apps\/polaris\/dist\/scripts\/polaris\.js/);
});

test("bluegreen nginx keeps /paseo assets on the Paseo app", () => {
  const template = fs.readFileSync("docker/nginx/templates/default.conf.template", "utf8");
  assert.match(template, /location = \/paseo \{\s+return 301 \/paseo\/;/m);
  assert.match(template, /location \^~ \/paseo\/ \{\s+proxy_pass http:\/\/paseo_app\/;/m);
  assert.doesNotMatch(template, /location \^~ \/paseo\/ \{\s+return 302 \/hosts;/m);
});
