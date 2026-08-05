import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { VaultSpec } from "../../core/vault.js";
import { resolveConfiguredPaseoAppBaseUrl } from "../../core/pairing-url.js";
import { resolveRepoRoot } from "../../utils/repo-root.js";
import { kubevirtProbePassword } from "./probe-access.js";
import {
  isNetfsSource,
  netfsResolvedPath,
  requireNetfsField,
  vaultDataClaimName,
  vaultDataPersistentVolumeName,
} from "../../core/netfs.js";
import {
  vaultRuntimeResourceName,
  vaultRuntimeScopeName,
} from "../../core/vault-name.js";
import {
  WANGHAI_PROFILE_ENV_FILE_KEY,
  WANGHAI_PROFILE_ENV_MOUNT_PATH,
} from "../../config/scaffold.js";
import {
  deriveWanghaiVaultAssertionSecret,
  requireWanghaiGatewayMasterSecret,
} from "../../security/wanghai-assertions.js";
import { sanitizeIntegratedWanghaiEnv } from "../../security/wanghai-runtime-env.js";
import { configuredWanghaiFrameAncestors } from "../../portal/wanghai-gateway.js";
import { writeGeneratedManifest } from "../../output/write-generated.js";

const REPO_ROOT = resolveRepoRoot(import.meta.url);
const GENERATED_KUBEVIRT_DIR = path.join(REPO_ROOT, "config", "generated", "kubevirt");
const FALLBACK_KUBEVIRT_DIR = path.join(REPO_ROOT, "config", "kubevirt", "templates");
const WANGHAI_RESOURCE_LIMITS = {
  requestCpu: "100m",
  requestMemory: "128Mi",
  requestEphemeralStorage: "128Mi",
  limitCpu: "500m",
  limitMemory: "512Mi",
  limitEphemeralStorage: "512Mi",
} as const;
const WANGHAI_PID_LIMIT = 128;

function runtimeScope(vault: VaultSpec): string {
  return vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
}

function vmName(vault: VaultSpec): string {
  return vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, "vm");
}

function cloudInitSecretName(vault: VaultSpec): string {
  return vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    "vm-cloudinit",
  );
}

function indentBlock(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split(/\r?\n/)
    .filter((line, index, arr) => !(index === arr.length - 1 && line === ""))
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function readTemplate(preferredPath: string, fallbackPath: string): string {
  if (fs.existsSync(preferredPath)) {
    return fs.readFileSync(preferredPath, "utf8");
  }
  return fs.readFileSync(fallbackPath, "utf8");
}

function requireAttachmentVolumeRef(
  vault: VaultSpec,
  attachment:
    | "vaultData"
    | "vaultRuntimeState"
    | "userIdentityState",
): string {
  const source = vault.attachments[attachment].source;
  if (attachment === "vaultData" && isNetfsSource(source)) {
    return vaultDataClaimName(vault);
  }
  if (source.kind !== "persistent-volume" || !source.volumeRef?.trim()) {
    throw new Error(
      `KubeVirt render requires '${vault.attachments[attachment].kind}' to use a dedicated persistent-volume source`,
    );
  }
  return source.volumeRef.trim();
}

function attachmentVolumeSize(
  vault: VaultSpec,
  attachment:
    | "vaultData"
    | "vaultRuntimeState"
    | "userIdentityState",
): string {
  const source = vault.attachments[attachment].source;
  if (source.volumeSize?.trim()) {
    return source.volumeSize.trim();
  }
  switch (attachment) {
    case "vaultData":
      return vault.resources.ephemeralStorage;
    case "vaultRuntimeState":
      return "20Gi";
    case "userIdentityState":
      return "5Gi";
  }
}

function isWanghaiServicePort(port: {
  name?: string;
  containerPort: string;
}): boolean {
  return port.name?.toLowerCase() === "wanghai" || port.containerPort === "9090";
}

function wanghaiGatewayEnvironment(vault: VaultSpec): {
  assertionSecret: string;
  frameAncestors: string;
  tenantId: string;
  vaultId: string;
} {
  return {
    assertionSecret: deriveWanghaiVaultAssertionSecret(
      requireWanghaiGatewayMasterSecret(),
      vault.userProfile.id,
      vault.identity.projectName,
    ),
    frameAncestors: configuredWanghaiFrameAncestors(),
    tenantId: vault.userProfile.id,
    vaultId: vault.identity.projectName,
  };
}

function wanghaiRuntimeDocs(vault: VaultSpec): string {
  const privatePort = vault.connectivity.servicePorts
    .map((port) => ({
      name: port.name?.trim() || "wanghai",
      containerPort: String(port.containerPort),
    }))
    .find(isWanghaiServicePort);
  if (!privatePort) {
    return "";
  }

  const scope = runtimeScope(vault);
  const serviceName = vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    "wanghai",
  );
  const gatewaySecretName = vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    "wanghai-gateway",
  );
  const dataClaim = requireAttachmentVolumeRef(vault, "vaultData");
  const gateway = wanghaiGatewayEnvironment(vault);
  const wanghaiEnv = vault.runtime.authFiles.find(
    (file) => file.key === WANGHAI_PROFILE_ENV_FILE_KEY
      || file.mountPath === WANGHAI_PROFILE_ENV_MOUNT_PATH,
  );
  const envSecretName = vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    "wanghai-env",
  );
  const gatewaySecret = [
    "apiVersion: v1",
    "kind: Secret",
    "metadata:",
    `  name: ${gatewaySecretName}`,
    `  namespace: ${scope}`,
    "type: Opaque",
    "data:",
    `  assertion-secret: ${Buffer.from(gateway.assertionSecret, "utf8").toString("base64")}`,
    "---",
  ];
  const envSecret = wanghaiEnv
    ? [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      `  name: ${envSecretName}`,
      `  namespace: ${scope}`,
      "type: Opaque",
      "data:",
      `  .env: ${Buffer.from(sanitizeIntegratedWanghaiEnv(wanghaiEnv.content ?? ""), "utf8").toString("base64")}`,
      "---",
    ]
    : [];
  const envLines = [
    ["WANGHAI_REPO_ROOT", "/opt/wanghai"],
    ["WANGHAI_RUNTIME_MODE", "polaris"],
    ["WANGHAI_GATEWAY_TENANT_ID", gateway.tenantId],
    ["WANGHAI_GATEWAY_VAULT_ID", gateway.vaultId],
    ["WANGHAI_GATEWAY_FRAME_ANCESTORS", gateway.frameAncestors],
    ["WANGHAI_SUPERVISE_PORTAL", "1"],
    ["HOME", "/tmp/wanghai-home"],
    ["TMPDIR", "/tmp"],
    ["NEXT_TELEMETRY_DISABLED", "1"],
  ].flatMap(([name, value]) => [
    `        - name: ${name}`,
    `          value: ${JSON.stringify(value)}`,
  ]);
  const assertionSecretEnv = [
    "        - name: WANGHAI_GATEWAY_ASSERTION_SECRET",
    "          valueFrom:",
    "            secretKeyRef:",
    `              name: ${gatewaySecretName}`,
    "              key: assertion-secret",
  ];
  const envVolume = wanghaiEnv
    ? [
      "        - name: wanghai-env",
      "          mountPath: /opt/wanghai/.env",
      "          subPath: .env",
      "          readOnly: true",
    ]
    : [];
  const secretVolume = wanghaiEnv
    ? [
      "      - name: wanghai-env",
      "        secret:",
      `          secretName: ${envSecretName}`,
    ]
    : [];
  return [
    ...gatewaySecret,
    ...envSecret,
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${serviceName}`,
    `  namespace: ${scope}`,
    "spec:",
    "  replicas: 1",
    "  strategy:",
    "    type: Recreate",
    "  selector:",
    "    matchLabels:",
    `      app: ${serviceName}`,
    "  template:",
    "    metadata:",
    "      labels:",
    `        app: ${serviceName}`,
    "    spec:",
    "      automountServiceAccountToken: false",
    "      securityContext:",
    "        runAsNonRoot: true",
    "        runAsUser: 1000",
    "        runAsGroup: 1000",
    "        fsGroup: 1000",
    "        fsGroupChangePolicy: OnRootMismatch",
    "        seccompProfile:",
    "          type: RuntimeDefault",
    "      containers:",
    "      - name: wanghai",
    `        image: ${JSON.stringify(vault.runtime.baseImage)}`,
    "        command: [\"/bin/sh\", \"-lc\"]",
    "        args:",
    "        - >-",
    `          mkdir -p /tmp/wanghai-home && ulimit -u ${WANGHAI_PID_LIMIT} && exec /usr/local/bin/wanghai-entrypoint pnpm --dir /opt/wanghai/apps/admin-portal run start --hostname 0.0.0.0 --port ${privatePort.containerPort}`,
    "        securityContext:",
    "          allowPrivilegeEscalation: false",
    "          readOnlyRootFilesystem: true",
    "          capabilities:",
    "            drop:",
    "            - ALL",
    "        resources:",
    "          requests:",
    `            cpu: ${JSON.stringify(WANGHAI_RESOURCE_LIMITS.requestCpu)}`,
    `            memory: ${JSON.stringify(WANGHAI_RESOURCE_LIMITS.requestMemory)}`,
    `            ephemeral-storage: ${JSON.stringify(WANGHAI_RESOURCE_LIMITS.requestEphemeralStorage)}`,
    "          limits:",
    `            cpu: ${JSON.stringify(WANGHAI_RESOURCE_LIMITS.limitCpu)}`,
    `            memory: ${JSON.stringify(WANGHAI_RESOURCE_LIMITS.limitMemory)}`,
    `            ephemeral-storage: ${JSON.stringify(WANGHAI_RESOURCE_LIMITS.limitEphemeralStorage)}`,
    "        ports:",
    `        - name: ${privatePort.name}`,
    `          containerPort: ${privatePort.containerPort}`,
    "        env:",
    ...assertionSecretEnv,
    ...envLines,
    "        startupProbe:",
    "          httpGet:",
    "            path: /wanghai/readyz",
    `            port: ${privatePort.containerPort}`,
    "          initialDelaySeconds: 2",
    "          timeoutSeconds: 5",
    "          periodSeconds: 5",
    "          failureThreshold: 60",
    "        livenessProbe:",
    "          httpGet:",
    "            path: /wanghai/healthz",
    `            port: ${privatePort.containerPort}`,
    "          timeoutSeconds: 5",
    "          periodSeconds: 10",
    "          failureThreshold: 3",
    "        readinessProbe:",
    "          httpGet:",
    "            path: /wanghai/readyz",
    `            port: ${privatePort.containerPort}`,
    "          timeoutSeconds: 5",
    "          periodSeconds: 5",
    "          failureThreshold: 3",
    "        volumeMounts:",
    "        - name: vault-data",
    "          mountPath: /vault/project",
    "        - name: wanghai-tmp",
    "          mountPath: /tmp",
    "        - name: wanghai-next-cache",
    "          mountPath: /opt/wanghai/apps/admin-portal/.next/cache",
    ...envVolume,
    "      volumes:",
    "      - name: vault-data",
    "        persistentVolumeClaim:",
    `          claimName: ${dataClaim}`,
    "      - name: wanghai-tmp",
    "        emptyDir:",
    "          sizeLimit: 128Mi",
    "      - name: wanghai-next-cache",
    "        emptyDir:",
    "          sizeLimit: 64Mi",
    ...secretVolume,
    "---",
    "apiVersion: v1",
    "kind: Service",
    "metadata:",
    `  name: ${serviceName}`,
    `  namespace: ${scope}`,
    "spec:",
    "  type: ClusterIP",
    "  selector:",
    `    app: ${serviceName}`,
    "  ports:",
    `  - name: ${privatePort.name}`,
    `    port: ${privatePort.containerPort}`,
    `    targetPort: ${privatePort.containerPort}`,
    "    appProtocol: http",
    "---",
    "apiVersion: networking.k8s.io/v1",
    "kind: NetworkPolicy",
    "metadata:",
    `  name: ${vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, "wanghai-egress")}`,
    `  namespace: ${scope}`,
    "spec:",
    "  podSelector:",
    "    matchLabels:",
    `      app: ${serviceName}`,
    "  policyTypes:",
    "  - Egress",
    "  egress:",
    "  - ports:",
    "    - protocol: UDP",
    "      port: 53",
    "    - protocol: TCP",
    "      port: 53",
    "  - ports:",
    "    - protocol: TCP",
    "      port: 80",
    "    - protocol: TCP",
    "      port: 443",
    "---",
  ].join("\n");
}

function existingPersistentVolumeClaimName(
  vault: VaultSpec,
  claimName: string,
): string | null {
  const result = spawnSync(
    "kubectl",
    [
      "-n",
      runtimeScope(vault),
      "get",
      "pvc",
      claimName,
      "-o",
      "jsonpath={.metadata.name}",
    ],
    { encoding: "utf8" },
  );
  const name = String(result.stdout || "").trim();
  return result.status === 0 && name ? name : null;
}

function buildPersistentVolumeClaimDocs(vault: VaultSpec): string {
  const docs: string[] = [];
  if (isNetfsSource(vault.attachments.vaultData.source)) {
    const source = vault.attachments.vaultData.source;
    const claimName = vaultDataClaimName(vault);
    if (!existingPersistentVolumeClaimName(vault, claimName)) {
      docs.push([
        "apiVersion: v1",
        "kind: PersistentVolume",
        "metadata:",
        `  name: ${vaultDataPersistentVolumeName(vault)}`,
        "spec:",
        "  accessModes:",
        "  - ReadWriteMany",
        "  capacity:",
        `    storage: ${attachmentVolumeSize(vault, "vaultData")}`,
        "  persistentVolumeReclaimPolicy: Retain",
        "  storageClassName: ''",
        "  mountOptions:",
        ...((source.mountOptions?.length ? source.mountOptions : ["nfsvers=4.1", "hard", "rw"])
          .map((entry) => `  - ${entry}`)),
        "  nfs:",
        `    server: ${requireNetfsField(source.server, "server", "vault-data")}`,
        `    path: ${netfsResolvedPath(source)}`,
        "  claimRef:",
        `    namespace: ${runtimeScope(vault)}`,
        `    name: ${claimName}`,
      ].join("\n"));
      docs.push([
        "apiVersion: v1",
        "kind: PersistentVolumeClaim",
        "metadata:",
        `  name: ${claimName}`,
        `  namespace: ${runtimeScope(vault)}`,
        "spec:",
        "  accessModes:",
        "  - ReadWriteMany",
        "  resources:",
        "    requests:",
        `      storage: ${attachmentVolumeSize(vault, "vaultData")}`,
        "  storageClassName: ''",
        `  volumeName: ${vaultDataPersistentVolumeName(vault)}`,
      ].join("\n"));
    }
  } else {
    docs.push([
      "apiVersion: v1",
      "kind: PersistentVolumeClaim",
      "metadata:",
      `  name: ${requireAttachmentVolumeRef(vault, "vaultData")}`,
      `  namespace: ${runtimeScope(vault)}`,
      "spec:",
      "  accessModes:",
      "  - ReadWriteOnce",
      "  resources:",
      "    requests:",
      `      storage: ${attachmentVolumeSize(vault, "vaultData")}`,
    ].join("\n"));
  }
  for (const attachment of [
    "vaultRuntimeState",
    "userIdentityState",
  ] as const) {
    docs.push([
      "apiVersion: v1",
      "kind: PersistentVolumeClaim",
      "metadata:",
      `  name: ${requireAttachmentVolumeRef(vault, attachment)}`,
      `  namespace: ${runtimeScope(vault)}`,
      "spec:",
      "  accessModes:",
      "  - ReadWriteOnce",
      "  resources:",
      "    requests:",
      `      storage: ${attachmentVolumeSize(vault, attachment)}`,
    ].join("\n"));
  }
  return docs.join("\n---\n");
}

function replacePlaceholders(text: string, vault: VaultSpec): string {
  const scope = runtimeScope(vault);
  const virtualMachineName = vmName(vault);
  const cloudInitName = cloudInitSecretName(vault);
  const paseoAppBaseUrl = resolveConfiguredPaseoAppBaseUrl();
  const rootdiskImage =
    vault.runtime.rootdiskImage || "quay.io/containerdisks/debian:13";
  const memoryGuest =
    vault.resources.memory || "4Gi";
  const memoryRequest =
    vault.resources.memoryRequest || memoryGuest;
  const declaredPorts = vault.connectivity.servicePorts.map((port, index) => ({
    name: port.name?.trim() || `service-${index + 1}`,
    containerPort: String(port.containerPort),
    nodePort: port.nodePort ? String(port.nodePort) : undefined,
  }));
  const publicDeclaredPorts = declaredPorts.filter((port) => !isWanghaiServicePort(port));
  const sshDeclared = publicDeclaredPorts.some((port) => port.containerPort === "22" || port.name === "ssh");
  const servicePorts = sshDeclared
    ? publicDeclaredPorts
    : [...publicDeclaredPorts, { name: "ssh", containerPort: "22" as const, nodePort: undefined }];
  const interfacePorts = servicePorts;
  const renderedServicePorts = servicePorts
    .map((port) => [
      `    - name: ${port.name}`,
      `      port: ${port.containerPort}`,
      `      targetPort: ${port.containerPort}`,
      ...(port.nodePort ? [`      nodePort: ${port.nodePort}`] : []),
    ].join("\n"))
    .join("\n");
  const renderedInterfacePorts = interfacePorts
    .map((port) => [
      `                - port: ${port.containerPort}`,
      "                  protocol: TCP",
    ].join("\n"))
    .join("\n");
  const wanghaiPrivateService = wanghaiRuntimeDocs(vault);
  return text
    .replaceAll(
      "__PERSISTENT_VOLUME_CLAIMS__",
      `${buildPersistentVolumeClaimDocs(vault)}\n`,
    )
    .replaceAll("__SERVICE_PORTS__", renderedServicePorts)
    .replaceAll("__INTERFACE_PORTS__", renderedInterfacePorts)
    .replaceAll("__PRIVATE_WANGHAI_SERVICE__", wanghaiPrivateService)
    .replaceAll("__PROJECT__", scope)
    .replaceAll(`${scope}-vm-cloudinit`, cloudInitName)
    .replaceAll(`${scope}-vm`, virtualMachineName)
    .replaceAll(
      "__VAULT_DATA_VOLUME__",
      requireAttachmentVolumeRef(vault, "vaultData"),
    )
    .replaceAll(
      "__VAULT_RUNTIME_STATE_VOLUME__",
      requireAttachmentVolumeRef(vault, "vaultRuntimeState"),
    )
    .replaceAll(
      "__USER_IDENTITY_STATE_VOLUME__",
      requireAttachmentVolumeRef(vault, "userIdentityState"),
    )
    .replaceAll("__ROOTDISK_IMAGE__", rootdiskImage)
    .replaceAll("__MEMORY_GUEST__", memoryGuest)
    .replaceAll("__MEMORY_REQUEST__", memoryRequest)
    .replaceAll(
      "__PASEO_APP_BASE_URL_ASSIGNMENT__",
      paseoAppBaseUrl
        ? `data.setdefault("app", {})["baseUrl"] = ${JSON.stringify(paseoAppBaseUrl)}; `
        : "",
    );
}

export function renderKubevirtVault(vault: VaultSpec): string {
  if (vault.profile.assetBaseName !== "morpheus") {
    throw new Error(`Vault backend 'kubevirt-vm' does not have built-in templates for profile '${vault.profile.name}' yet`);
  }
  const cloudinitPath = path.join(
    GENERATED_KUBEVIRT_DIR,
    `${vault.profile.assetBaseName}-vm-cloudinit-secret.yaml`,
  );
  const vmPath = path.join(
    GENERATED_KUBEVIRT_DIR,
    `${vault.profile.assetBaseName}.yaml`,
  );
  const cloudinitTemplate = replacePlaceholders(
    readTemplate(
      cloudinitPath,
      path.join(FALLBACK_KUBEVIRT_DIR, "vm-cloudinit-secret.yaml"),
    ),
    vault,
  );
  const vmTemplate = replacePlaceholders(
    readTemplate(vmPath, path.join(FALLBACK_KUBEVIRT_DIR, "vm.yaml")),
    vault,
  );
  const codexAuth = vault.runtime.authFiles.find((item) => item.key === "codex-auth.json")?.content;
  const codexConfig = vault.runtime.authFiles.find((item) => item.key === "codex-config.toml")?.content;
  let renderedCloudinit = cloudinitTemplate
    .replace("__CODEX_AUTH_JSON_B64__", Buffer.from(codexAuth ?? "{}", "utf8").toString("base64"))
    .replace("__CODEX_CONFIG_TOML_B64__", Buffer.from(codexConfig ?? "", "utf8").toString("base64"))
    .replace("__CLAUDE_SETTINGS_JSON_B64__", Buffer.from("{}", "utf8").toString("base64"))
    .replace("__PROBE_PASSWORD__", kubevirtProbePassword(vault));
  const evolutionOutputs = [
    [vault.evolution?.vaultMemoryFile, vault.evolution?.vaultMemoryContent],
    [vault.evolution?.userMemoryFile, vault.evolution?.userMemoryContent],
    [vault.evolution?.sessionSnapshotFile, vault.evolution?.sessionSnapshotContent],
  ] as Array<[string | undefined, string | undefined]>;
  const writes = evolutionOutputs
    .filter(([filePath, content]) => Boolean(filePath && content))
    .map(([filePath, content]) => `      - |\n        cat >${filePath} <<'EOF'\n${indentBlock(content || "", 8)}\n        EOF`)
    .join("\n");
  if (writes) {
    renderedCloudinit = renderedCloudinit.replace(
      "      - chmod 1777 /run/vault/tmp",
      `      - chmod 1777 /run/vault/tmp\n${writes}`,
    );
  }
  return `${renderedCloudinit.trimEnd()}\n---\n${vmTemplate.trimEnd()}\n`;
}

export function renderAndWriteKubevirtVault(vault: VaultSpec): string {
  return writeGeneratedManifest(vault, renderKubevirtVault(vault));
}
