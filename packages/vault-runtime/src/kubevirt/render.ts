import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { VaultRuntimeSpec } from "../types.js";
import {
  isNetfsSource,
  netfsResolvedPath,
  requireNetfsField,
  vaultDataClaimName,
  vaultDataPersistentVolumeName,
} from "../core/netfs.js";
import {
  vaultRuntimeResourceName,
  vaultRuntimeScopeName,
} from "../core/vault-name.js";

function runtimeScope(vault: VaultRuntimeSpec): string {
  return vaultRuntimeScopeName(vault.userProfile.id, vault.identity.projectName);
}

function vmName(vault: VaultRuntimeSpec): string {
  return vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, "vm");
}

function cloudInitSecretName(vault: VaultRuntimeSpec): string {
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
  vault: VaultRuntimeSpec,
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
  vault: VaultRuntimeSpec,
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

function isPrivateSurfacePort(
  vault: VaultRuntimeSpec,
  port: { name?: string; containerPort: string },
): boolean {
  const surface = vault.integration.privateSurface;
  return Boolean(surface && (
    port.name?.toLowerCase() === surface.id.toLowerCase()
    || String(port.containerPort) === String(surface.port.containerPort)
  ));
}

function privateSurfaceRuntimeDocs(vault: VaultRuntimeSpec): string {
  const surface = vault.integration.privateSurface;
  if (!surface) {
    return "";
  }
  const privatePort = surface.port;
  const scope = runtimeScope(vault);
  const serviceName = vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    surface.id,
  );
  const dataClaim = requireAttachmentVolumeRef(vault, "vaultData");
  const envSecretName = vaultRuntimeResourceName(
    vault.userProfile.id,
    vault.identity.projectName,
    `${surface.id}-env`,
  );
  const envSecret = surface.envFile
    ? [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      `  name: ${envSecretName}`,
      `  namespace: ${scope}`,
      "type: Opaque",
      "data:",
      `  .env: ${Buffer.from(surface.envFile.content ?? "", "utf8").toString("base64")}`,
      "---",
    ]
    : [];
  const secretEnv = surface.secretEnv
    ? [
      "apiVersion: v1",
      "kind: Secret",
      "metadata:",
      `  name: ${vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, surface.secretEnv.resourceSuffix)}`,
      `  namespace: ${scope}`,
      "type: Opaque",
      "data:",
      `  ${surface.secretEnv.key}: ${Buffer.from(surface.secretEnv.value, "utf8").toString("base64")}`,
      "---",
    ]
    : [];
  const secretEnvLines = surface.secretEnv
    ? [
      `        - name: ${surface.secretEnv.name}`,
      "          valueFrom:",
      "            secretKeyRef:",
      `              name: ${vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, surface.secretEnv.resourceSuffix)}`,
      `              key: ${surface.secretEnv.key}`,
    ]
    : [];
  const envLines = surface.env.flatMap(({ name, value }) => [
    `        - name: ${name}`,
    `          value: ${JSON.stringify(value)}`,
  ]);
  const envVolume = surface.envFile
    ? [
      "        - name: private-surface-env",
      `          mountPath: ${surface.envFile.mountPath}`,
      "          subPath: .env",
      "          readOnly: true",
    ]
    : [];
  const secretVolume = surface.envFile
    ? [
      "      - name: private-surface-env",
      "        secret:",
      `          secretName: ${envSecretName}`,
    ]
    : [];
  const networkPolicy = surface.networkPolicy
    ? [
      "---",
      "apiVersion: networking.k8s.io/v1",
      "kind: NetworkPolicy",
      "metadata:",
      `  name: ${vaultRuntimeResourceName(vault.userProfile.id, vault.identity.projectName, `${surface.id}-egress`)}`,
      `  namespace: ${scope}`,
      "spec:",
      "  podSelector:",
      "    matchLabels:",
      `      app: ${serviceName}`,
      "  policyTypes:",
      "  - Egress",
      "  egress:",
      ...(surface.networkPolicy.dns
        ? [
          "  - ports:",
          "    - protocol: UDP",
          "      port: 53",
          "    - protocol: TCP",
          "      port: 53",
        ]
        : []),
      ...(surface.networkPolicy.web
        ? [
          "  - ports:",
          "    - protocol: TCP",
          "      port: 80",
          "    - protocol: TCP",
          "      port: 443",
        ]
        : []),
    ]
    : [];
  return [
    ...secretEnv,
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
    `      - name: ${surface.id}`,
    `        image: ${JSON.stringify(surface.image ?? vault.runtime.baseImage)}`,
    "        command: [\"/bin/sh\", \"-lc\"]",
    "        args:",
    "        - >-",
    `          ${surface.command}`,
    "        securityContext:",
    "          allowPrivilegeEscalation: false",
    "          readOnlyRootFilesystem: true",
    "          capabilities:",
    "            drop:",
    "            - ALL",
    "        resources:",
    "          requests:",
    `            cpu: ${JSON.stringify(surface.resources.cpuRequest)}`,
    `            memory: ${JSON.stringify(surface.resources.memoryRequest)}`,
    `            ephemeral-storage: ${JSON.stringify(surface.resources.ephemeralStorageRequest)}`,
    "          limits:",
    `            cpu: ${JSON.stringify(surface.resources.cpuLimit)}`,
    `            memory: ${JSON.stringify(surface.resources.memoryLimit)}`,
    `            ephemeral-storage: ${JSON.stringify(surface.resources.ephemeralStorageLimit)}`,
    "        ports:",
    `        - name: ${privatePort.name ?? surface.id}`,
    `          containerPort: ${privatePort.containerPort}`,
    "        env:",
    ...secretEnvLines,
    ...envLines,
    "        startupProbe:",
    "          httpGet:",
    `            path: ${surface.readyPath}`,
    `            port: ${privatePort.containerPort}`,
    "          initialDelaySeconds: 2",
    "          timeoutSeconds: 5",
    "          periodSeconds: 5",
    "          failureThreshold: 60",
    "        livenessProbe:",
    "          httpGet:",
    `            path: ${surface.healthPath}`,
    `            port: ${privatePort.containerPort}`,
    "          timeoutSeconds: 5",
    "          periodSeconds: 10",
    "          failureThreshold: 3",
    "        readinessProbe:",
    "          httpGet:",
    `            path: ${surface.readyPath}`,
    `            port: ${privatePort.containerPort}`,
    "          timeoutSeconds: 5",
    "          periodSeconds: 5",
    "          failureThreshold: 3",
    "        volumeMounts:",
    "        - name: vault-data",
    "          mountPath: /vault/project",
    "        - name: private-surface-tmp",
    "          mountPath: /tmp",
    ...envVolume,
    "      volumes:",
    "      - name: vault-data",
    "        persistentVolumeClaim:",
    `          claimName: ${dataClaim}`,
    "      - name: private-surface-tmp",
    "        emptyDir:",
    "          sizeLimit: 128Mi",
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
    `  - name: ${privatePort.name ?? surface.id}`,
    `    port: ${privatePort.containerPort}`,
    `    targetPort: ${privatePort.containerPort}`,
    "    appProtocol: http",
    ...networkPolicy,
    "---",
  ].join("\n");
}

function existingPersistentVolumeClaimName(
  vault: VaultRuntimeSpec,
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

function buildPersistentVolumeClaimDocs(vault: VaultRuntimeSpec): string {
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

function replacePlaceholders(text: string, vault: VaultRuntimeSpec): string {
  const scope = runtimeScope(vault);
  const virtualMachineName = vmName(vault);
  const cloudInitName = cloudInitSecretName(vault);
  const paseoAppBaseUrl = vault.integration.paseoAppBaseUrl;
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
  const publicDeclaredPorts = declaredPorts.filter((port) => !isPrivateSurfacePort(vault, port));
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
  const privateSurfaceService = privateSurfaceRuntimeDocs(vault);
  return text
    .replaceAll(
      "__PERSISTENT_VOLUME_CLAIMS__",
      `${buildPersistentVolumeClaimDocs(vault)}\n`,
    )
    .replaceAll("__SERVICE_PORTS__", renderedServicePorts)
    .replaceAll("__INTERFACE_PORTS__", renderedInterfacePorts)
    .replaceAll("__PRIVATE_SURFACE_SERVICE__", privateSurfaceService)
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

export function renderKubevirtVault(vault: VaultRuntimeSpec): string {
  if (vault.profile.assetBaseName !== "morpheus") {
    throw new Error(`Vault backend 'kubevirt-vm' does not have built-in templates for profile '${vault.profile.name}' yet`);
  }
  const generatedDir = vault.integration.kubevirtTemplates.generatedDir
    ?? vault.integration.kubevirtTemplates.fallbackDir;
  const fallbackDir = vault.integration.kubevirtTemplates.fallbackDir;
  const cloudinitPath = path.join(
    generatedDir,
    `${vault.profile.assetBaseName}-vm-cloudinit-secret.yaml`,
  );
  const vmPath = path.join(
    generatedDir,
    `${vault.profile.assetBaseName}.yaml`,
  );
  const cloudinitTemplate = replacePlaceholders(
    readTemplate(
      cloudinitPath,
      path.join(fallbackDir, "vm-cloudinit-secret.yaml"),
    ),
    vault,
  );
  const vmTemplate = replacePlaceholders(
    readTemplate(vmPath, path.join(fallbackDir, "vm.yaml")),
    vault,
  );
  const codexAuth = vault.runtime.authFiles.find((item) => item.key === "codex-auth.json")?.content;
  const codexConfig = vault.runtime.authFiles.find((item) => item.key === "codex-config.toml")?.content;
  let renderedCloudinit = cloudinitTemplate
    .replace("__CODEX_AUTH_JSON_B64__", Buffer.from(codexAuth ?? "{}", "utf8").toString("base64"))
    .replace("__CODEX_CONFIG_TOML_B64__", Buffer.from(codexConfig ?? "", "utf8").toString("base64"))
    .replace("__CLAUDE_SETTINGS_JSON_B64__", Buffer.from("{}", "utf8").toString("base64"))
    .replace("__PROBE_PASSWORD__", vault.integration.kubevirtProbePassword);
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
