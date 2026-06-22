# Set Up k3s Across Multiple Machines

This document restores the k3s cluster setup notes that used to live in the
legacy top-level k3s guide.

## Sandbox Runtimes

Prepare a Debian k3s control-plane host for Kata-backed and gVisor-backed
Polaris sandboxes:

```bash
sudo ./scripts/operations/setup-k3s-sandbox-runtimes.sh
```

What it does:

- installs k3s if needed
- installs Kata Containers
- installs gVisor
- writes the k3s containerd template for sandbox runtimes
- restarts k3s when required
- creates `RuntimeClass` objects for `kata-qemu`, `kata-clh`,
  `kata-qemu-tdx`, and `gvisor`
- runs the Kata and gVisor smoke tests

Verify:

```bash
k3s kubectl get nodes
k3s kubectl get runtimeclass
```

## KubeVirt

Install or update the KubeVirt control plane on the current k3s cluster:

```bash
bash scripts/operations/setup-k3s-kubevirt.sh
```

Optional:

- set `KUBEVIRT_RELEASE` to pin a specific KubeVirt release tag

What it does:

- resolves the latest stable KubeVirt release unless pinned
- applies the KubeVirt operator manifest
- applies `config/kubevirt/kubevirt-cr.yaml`
- enables `EnableVirtioFsStorageVolumes`
- raises the `virtiofs` support-container memory limit for large shared PVCs
- waits for the KubeVirt control plane to report `Available`

Verify:

```bash
kubectl get kubevirt -n kubevirt
kubectl get pods -n kubevirt
```

## CDI

Install or update CDI, which KubeVirt uses for VM disk import and DataVolume
workflows:

```bash
bash scripts/operations/setup-k3s-cdi.sh
```

Optional:

- set `CDI_RELEASE` to pin a specific CDI release tag

What it does:

- applies the CDI operator manifest
- applies the CDI custom resource
- waits for the CDI control plane to report `Available`

Verify:

```bash
kubectl get cdi -n cdi
kubectl get pods -n cdi
```

## Additional Workers

Print the worker join settings on the current k3s server:

```bash
sudo ./scripts/operations/print-k3s-worker-join-info.sh
```

Join an additional `x86_64` Debian host as a sandbox-capable worker:

```bash
export K3S_URL=https://<control-plane-host-or-ip>:6443
export K3S_TOKEN='<server-node-token>'
sudo -E ./scripts/operations/setup-k3s-sandbox-worker.sh
```

Optional:

- set `K3S_NODE_NAME` to override the node name
- set `K3S_NODE_LABELS` to add extra node labels
- set `K3S_AGENT_EXTRA_ARGS` for extra `k3s agent` install flags

What it does:

- installs `k3s-agent` and joins the existing cluster
- installs Kata Containers for `amd64`
- installs gVisor
- writes the containerd template for sandbox runtimes on the worker
- applies default Polaris runtime labels for Kata and gVisor support
- restarts `k3s-agent` when required

Verify:

```bash
kubectl get nodes -o wide
kubectl describe node <worker-name>
```
