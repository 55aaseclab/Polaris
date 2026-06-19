#!/usr/bin/env python3

import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from scripts.agentctl import (
    AgentConfig,
    AgentAuthFile,
    AgentError,
    PlainEnvVar,
    ServicePort,
    apply_saved_project,
    apply_project_manifest,
    agent_label_for_cmd,
    build_paseo_runtime_cleanup_line,
    build_ssh_keygen_line,
    build_paseo_bootstrap_line,
    gather_agent_auth_files,
    is_valid_project_name,
    load_project_config,
    sanitize_codex_config_toml,
    restore_files,
    snapshot_files,
)


class UserStoryGraphTest(unittest.TestCase):
    PROJECT = "sample-agent"

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="agentctl-user-story-")
        self.addCleanup(self.tempdir.cleanup)
        self.original_spec_roots = dict(__import__("scripts.agentctl", fromlist=[""]).BACKEND_SPEC_ROOTS)
        self.original_generated_roots = dict(__import__("scripts.agentctl", fromlist=[""]).BACKEND_GENERATED_ROOTS)
        self.spec_dir = Path(self.tempdir.name) / "config" / "gvisor" / "specs"
        self.generated_dir = Path(self.tempdir.name) / "config" / "gvisor" / "generated"
        self.kubevirt_spec_dir = Path(self.tempdir.name) / "config" / "kubevirt" / "specs"
        self.kubevirt_generated_dir = Path(self.tempdir.name) / "config" / "kubevirt" / "generated"
        self.spec_dir.mkdir(parents=True, exist_ok=True)
        self.generated_dir.mkdir(parents=True, exist_ok=True)
        self.kubevirt_spec_dir.mkdir(parents=True, exist_ok=True)
        self.kubevirt_generated_dir.mkdir(parents=True, exist_ok=True)

        import scripts.agentctl as agentctl

        agentctl.BACKEND_SPEC_ROOTS["pod"] = self.spec_dir
        agentctl.BACKEND_GENERATED_ROOTS["pod"] = self.generated_dir
        agentctl.BACKEND_SPEC_ROOTS["kubevirt-vm"] = self.kubevirt_spec_dir
        agentctl.BACKEND_GENERATED_ROOTS["kubevirt-vm"] = self.kubevirt_generated_dir

    def tearDown(self) -> None:
        import scripts.agentctl as agentctl

        agentctl.BACKEND_SPEC_ROOTS.clear()
        agentctl.BACKEND_SPEC_ROOTS.update(self.original_spec_roots)
        agentctl.BACKEND_GENERATED_ROOTS.clear()
        agentctl.BACKEND_GENERATED_ROOTS.update(self.original_generated_roots)

    def make_config(self, **overrides: Any) -> AgentConfig:
        defaults: dict[str, Any] = {
            "project_name": self.PROJECT,
            "backend_kind": "pod",
            "backend_spec_files": [],
            "runtime_class": "kata-qemu",
            "base_image": "debian:trixie-slim",
            "cpu": "2",
            "memory": "4Gi",
            "storage": "20Gi",
            "cpu_request": "",
            "memory_request": "",
            "storage_request": "",
            "agent": "None",
            "agent_cmd": "",
            "agent_args": "",
            "privileged": False,
            "docker_enabled": False,
            "persist_state": False,
            "all_packages": "",
            "bootstrap_profile": "full",
            "install_rustup": False,
            "git_core_editor": "",
            "git_user_name": "",
            "git_user_email": "",
            "unbounded_resources": False,
            "plain_env_vars": [],
            "auth_files": [],
            "expose_service": False,
            "service_mode": "nodeport",
            "service_ports": [],
            "service_host": "",
            "service_path": "/",
        }
        defaults.update(overrides)
        return AgentConfig(**defaults)

    def make_agent_config(self, **overrides: Any) -> AgentConfig:
        return self.make_config(
            agent=agent_label_for_cmd("multi"),
            agent_cmd="multi",
            **overrides,
        )

    def test_file_snapshot_restore_rolls_back_new_and_existing_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            existing = Path(tmpdir) / "existing.txt"
            new_file = Path(tmpdir) / "new.yaml"
            existing.write_text("before\n")

            snapshots = snapshot_files([existing, new_file])

            existing.write_text("after\n")
            new_file.write_text("created\n")

            restore_files(snapshots)

            self.assertEqual(existing.read_text(), "before\n")
            self.assertFalse(new_file.exists())

    def test_project_name_validation_matches_user_group_constraints(self) -> None:
        valid = ("morpheus", "morpheus2", "morpheus-dev", "a", "a1")
        invalid = ("", "2morpheus", "-morpheus", "morpheus-", "Morph", "morpheus_dev", "m" * 33)
        for name in valid:
            with self.subTest(name=name):
                self.assertTrue(is_valid_project_name(name))
        for name in invalid:
            with self.subTest(name=name):
                self.assertFalse(is_valid_project_name(name))

    def test_sanitize_codex_config_removes_trusted_projects(self) -> None:
        source = """model_provider = "openai"
[projects."/home/debian/Projects/foo"]
trust_level = "trusted"

[projects."/tmp"]
trust_level = "trusted"

[tui.model_availability_nux]
"gpt-5.5" = 4
"""
        rendered = sanitize_codex_config_toml(source)
        self.assertIn('model_provider = "openai"', rendered)
        self.assertIn("[tui.model_availability_nux]", rendered)
        self.assertNotIn('[projects."/home/debian/Projects/foo"]', rendered)
        self.assertNotIn('trust_level = "trusted"', rendered)

    def test_agent_config_round_trip(self) -> None:
        cfg = self.make_agent_config(
            cpu="12",
            memory="12Gi",
            storage="80Gi",
            cpu_request="4",
            memory_request="8Gi",
            storage_request="20Gi",
            persist_state=True,
            all_packages="bat bubblewrap curl git nodejs npm python3 ripgrep sudo wget",
            plain_env_vars=[PlainEnvVar("FOO", "bar")],
            auth_files=[
                AgentAuthFile(
                    key="codex-auth.json",
                    mount_path=f"/home/{self.PROJECT}/.codex/auth.json",
                    content='{"auth_mode":"chatgpt"}',
                )
            ],
            expose_service=True,
            service_mode="ingress",
            service_ports=[ServicePort("8080", "30800")],
            service_host="app.example.test",
            service_path="/demo",
        )

        loaded = AgentConfig.from_config_dict(cfg.to_config_dict())

        for field_name in (
            "project_name",
            "backend_kind",
            "runtime_class",
            "base_image",
            "cpu",
            "memory",
            "storage",
            "cpu_request",
            "memory_request",
            "storage_request",
            "agent_cmd",
            "agent_args",
            "persist_state",
            "bootstrap_profile",
            "all_packages",
            "git_core_editor",
            "git_user_name",
            "git_user_email",
            "service_mode",
            "service_host",
            "service_path",
        ):
            with self.subTest(field=field_name):
                self.assertEqual(getattr(loaded, field_name), getattr(cfg, field_name))
        self.assertEqual(loaded.plain_env_vars[0].name, "FOO")
        self.assertEqual(loaded.auth_files[0].key, "codex-auth.json")
        self.assertTrue(loaded.expose_service)
        self.assertEqual([(item.container_port, item.node_port) for item in loaded.service_ports], [("8080", "30800")])

    def test_pod_backend_rejects_workspace_paths(self) -> None:
        cfg = self.make_agent_config(
            auth_files=[
                AgentAuthFile(
                    key="bad.json",
                    mount_path="/workspace/.codex/auth.json",
                    content="{}",
                )
            ]
        )

        with self.assertRaises(AgentError):
            cfg.validate()

    def test_kubevirt_backend_requires_spec_files(self) -> None:
        cfg = self.make_config(
            backend_kind="kubevirt-vm",
            backend_spec_files=[],
        )

        with self.assertRaises(AgentError):
            cfg.validate()

    def test_apply_rejects_kubevirt_backend(self) -> None:
        cfg = self.make_config(
            backend_kind="kubevirt-vm",
            backend_spec_files=["config/kubevirt/morpheus-vm.yaml"],
        )

        with self.assertRaises(AgentError):
            apply_project_manifest(cfg)

    def test_kubevirt_backend_renders_vm_manifest_bundle(self) -> None:
        repo_root = Path(__file__).resolve().parent.parent
        (self.kubevirt_generated_dir / "morpheus-vm-cloudinit-secret.yaml").write_text(
            (repo_root / "config" / "kubevirt" / "generated" / "morpheus-vm-cloudinit-secret.yaml").read_text()
        )
        (self.kubevirt_generated_dir / "morpheus.yaml").write_text(
            (repo_root / "config" / "kubevirt" / "generated" / "morpheus.yaml").read_text()
        )
        cfg = self.make_config(
            project_name="morpheus",
            backend_kind="kubevirt-vm",
            backend_spec_files=["config/kubevirt/specs/morpheus.agent.yaml"],
            auth_files=[
                AgentAuthFile(
                    key="codex-auth.json",
                    mount_path="/root/.codex/auth.json",
                    content='{"auth_mode":"chatgpt"}',
                ),
                AgentAuthFile(
                    key="claude-settings.json",
                    mount_path="/root/.claude/settings.json",
                    content='{"token":"abc"}',
                ),
            ],
        )

        rendered = cfg.yaml_text()

        self.assertIn("kind: Secret", rendered)
        self.assertIn("name: morpheus-vm-cloudinit", rendered)
        self.assertIn("kind: VirtualMachine", rendered)
        self.assertIn("name: morpheus-vm", rendered)
        self.assertIn('{"auth_mode":"chatgpt"}', rendered)

    def test_auth_files_are_copied_in_bootstrap_not_k8s_secret(self) -> None:
        cfg = self.make_agent_config(
            auth_files=[
                AgentAuthFile(
                    key="codex-auth.json",
                    mount_path=f"/home/{self.PROJECT}/.codex/auth.json",
                    content='{"auth_mode":"chatgpt"}',
                ),
                AgentAuthFile(
                    key="claude-settings.json",
                    mount_path=f"/home/{self.PROJECT}/.claude/settings.json",
                    content='{"token":"abc"}',
                ),
            ]
        )

        rendered = cfg.yaml_text()

        self.assertNotIn("kind: Secret", rendered)
        self.assertNotIn("secretName:", rendered)
        self.assertNotIn("name: agent-auth", rendered)
        self.assertIn("path.write_bytes(base64.b64decode", rendered)
        self.assertIn(f"/home/{self.PROJECT}/.codex/auth.json", rendered)
        self.assertIn(f"/home/{self.PROJECT}/.claude/settings.json", rendered)

    def test_persisted_codex_state_uses_single_project_pvc_mount(self) -> None:
        cfg = self.make_agent_config(persist_state=True)

        rendered = cfg.yaml_text()

        self.assertIn("  strategy:\n    type: Recreate", rendered)
        self.assertIn(f"mountPath: /home/{self.PROJECT}", rendered)
        self.assertIn(f"claimName: {cfg.project_pvc_name}", rendered)
        self.assertNotIn(f"mountPath: /home/{self.PROJECT}/.paseo", rendered)
        self.assertNotIn("subPath: .paseo", rendered)
        self.assertNotIn("hostPath:", rendered)

    def test_burstable_resources_render_requests_separately_from_limits(self) -> None:
        cfg = self.make_agent_config(
            cpu="12",
            memory="16Gi",
            storage="50Gi",
            cpu_request="4",
            memory_request="8Gi",
            storage_request="20Gi",
        )

        rendered = cfg.yaml_text()

        self.assertIn('          limits:\n            memory: "16Gi"\n            cpu: "12"\n            ephemeral-storage: "50Gi"', rendered)
        self.assertIn('          requests:\n            memory: "8Gi"\n            cpu: "4"\n            ephemeral-storage: "20Gi"', rendered)

    def test_unbounded_resources_omit_container_resource_block(self) -> None:
        cfg = self.make_agent_config(
            unbounded_resources=True,
            cpu="12",
            memory="24Gi",
            storage="50Gi",
            cpu_request="4",
            memory_request="8Gi",
            storage_request="20Gi",
        )

        rendered = cfg.yaml_text()

        self.assertNotIn("        resources:\n", rendered)
        self.assertIn('      storage: "50Gi"', rendered)

    def test_paseo_home_is_rendered_as_env_not_volume_mount(self) -> None:
        cfg = self.make_agent_config(
            plain_env_vars=[PlainEnvVar("FOO", "bar")],
        )

        rendered = cfg.yaml_text()
        volume_mounts_section = rendered.split("        volumeMounts:\n", 1)[1].split("        env:\n", 1)[0]

        self.assertIn("        env:\n", rendered)
        self.assertIn(f'        - name: PASEO_HOME\n          value: "/home/{self.PROJECT}/.paseo"', rendered)
        self.assertNotIn("PASEO_HOME", volume_mounts_section)

    def test_docker_enabled_renders_docker_host_and_bootstrap(self) -> None:
        cfg = self.make_agent_config(
            docker_enabled=True,
            runtime_user="root",
            bootstrap_profile="prebuilt",
        )

        rendered = cfg.yaml_text()

        self.assertIn('        - name: DOCKER_HOST\n          value: "unix:///var/run/docker.sock"', rendered)
        self.assertIn('        - name: DOCKER_BUILDKIT\n          value: "0"', rendered)
        self.assertIn("dockerd --host=unix:///var/run/docker.sock", rendered)

    def test_privileged_runtime_renders_security_context(self) -> None:
        cfg = self.make_agent_config(
            privileged=True,
            runtime_user="root",
        )

        rendered = cfg.yaml_text()

        self.assertIn("        securityContext:\n          privileged: true\n          allowPrivilegeEscalation: true", rendered)
        self.assertIn("          seccompProfile:\n            type: Unconfined", rendered)
        self.assertIn("            - SYS_ADMIN", rendered)

    def test_nodeport_service_is_rendered(self) -> None:
        cfg = self.make_agent_config(
            expose_service=True,
            service_mode="nodeport",
            service_ports=[ServicePort("8080", "30800"), ServicePort("8081", "30801"), ServicePort("8082", "30802")],
        )

        rendered = cfg.yaml_text()

        self.assertIn("kind: Service", rendered)
        self.assertIn("  type: NodePort", rendered)
        self.assertIn("    nodePort: 30800", rendered)
        self.assertIn("    nodePort: 30801", rendered)
        self.assertIn("    nodePort: 30802", rendered)
        self.assertNotIn("kind: Ingress", rendered)

    def test_ingress_service_is_rendered_with_traefik(self) -> None:
        cfg = self.make_agent_config(
            expose_service=True,
            service_mode="ingress",
            service_ports=[ServicePort("8080"), ServicePort("8081"), ServicePort("8082")],
            service_host="app.example.test",
            service_path="/demo",
        )

        rendered = cfg.yaml_text()

        self.assertIn("kind: Service", rendered)
        self.assertIn("  type: ClusterIP", rendered)
        self.assertIn("kind: Ingress", rendered)
        self.assertIn("ingressClassName: traefik", rendered)
        self.assertIn("traefik.ingress.kubernetes.io/router.entrypoints: web", rendered)
        self.assertIn("host: app.example.test", rendered)
        self.assertIn("path: /demo", rendered)
        self.assertIn("              number: 8080", rendered)

    def test_legacy_single_service_port_config_still_loads(self) -> None:
        loaded = AgentConfig.from_config_dict(
            {
                "project": self.PROJECT,
                "runtime": {"class": "kata-qemu", "base_image": "debian:trixie-slim"},
                "resources": {"cpu": "2", "memory": "4Gi", "ephemeral_storage": "20Gi"},
                "agent": {"kind": "multi", "label": "Codex + Claude Code", "args": [], "persist_state": True},
                "tooling": {"bootstrap_profile": "prebuilt", "apt_packages": []},
                "auth": {"files": []},
                "env": {"plain": {}},
                "service": {"enabled": True, "mode": "nodeport", "container_port": "6767", "node_port": "31677", "host": None, "path": "/"},
            }
        )

        self.assertEqual([(item.container_port, item.node_port) for item in loaded.service_ports], [("6767", "31677")])

    def test_claude_config_is_loaded(self) -> None:
        loaded = AgentConfig.from_config_dict(
            {
                "project": self.PROJECT,
                "runtime": {
                    "class": "kata-qemu",
                    "base_image": "debian:trixie-slim",
                },
                "resources": {
                    "cpu": "2",
                    "memory": "4Gi",
                    "ephemeral_storage": "20Gi",
                },
                "agent": {
                    "kind": "multi",
                    "label": "Codex + Claude Code",
                    "permissive": False,
                    "args": [],
                    "persist_state": True,
                },
                "tooling": {
                    "bootstrap_profile": "full",
                    "apt_packages": [],
                    "install_rustup": False,
                },
                "auth": {
                    "files": [
                        {
                            "key": "claude-settings.json",
                            "mount_path": f"/home/{self.PROJECT}/.claude/settings.json",
                            "content": "{}",
                        }
                    ]
                },
            }
        )

        self.assertEqual(loaded.agent_cmd, "multi")
        self.assertEqual(loaded.agent, "Codex + Claude Code")
        self.assertEqual(loaded.auth_files[0].key, "claude-settings.json")

    def test_gather_agent_auth_files_reads_repo_local_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            secrets_dir = Path(tmpdir) / "agentctl"
            (secrets_dir / "codex").mkdir(parents=True)
            (secrets_dir / "claude").mkdir(parents=True)
            (secrets_dir / "codex" / "auth.json").write_text('{"auth_mode":"chatgpt"}')
            (secrets_dir / "codex" / "config.toml").write_text(
                'model_provider = "openai"\n'
                '[projects."/tmp/foo"]\n'
                'trust_level = "trusted"\n'
            )
            (secrets_dir / "claude" / "settings.json").write_text('{"token":"abc"}')

            with patch("scripts.agentctl.SECRETS_DIR", secrets_dir):
                auth_files = gather_agent_auth_files(self.PROJECT)

        self.assertEqual([item.key for item in auth_files], ["codex-auth.json", "codex-config.toml", "claude-settings.json"])
        self.assertEqual(auth_files[0].mount_path, f"/home/{self.PROJECT}/.codex/auth.json")
        self.assertNotIn('trust_level = "trusted"', auth_files[1].content)

    def test_load_project_config_refreshes_auth_files_from_repo_local_secrets(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            output_dir = Path(tmpdir) / "agents"
            secrets_dir = Path(tmpdir) / "agentctl"
            output_dir.mkdir(parents=True)
            (secrets_dir / "codex").mkdir(parents=True)
            (secrets_dir / "claude").mkdir(parents=True)
            (secrets_dir / "codex" / "auth.json").write_text('{"auth_mode":"chatgpt"}')
            (secrets_dir / "codex" / "config.toml").write_text('model_provider = "openai"\n')
            (secrets_dir / "claude" / "settings.json").write_text('{"token":"abc"}')

            stale_cfg = self.make_agent_config(
                auth_files=[
                    AgentAuthFile(
                        key="codex-auth.json",
                        mount_path=f"/home/{self.PROJECT}/.codex/auth.json",
                        content="",
                    ),
                    AgentAuthFile(
                        key="codex-config.toml",
                        mount_path=f"/home/{self.PROJECT}/.codex/config.toml",
                        content="",
                    ),
                ]
            )
            specs_dir = output_dir / "config" / "gvisor" / "specs"
            generated_dir = output_dir / "config" / "gvisor" / "generated"
            specs_dir.mkdir(parents=True, exist_ok=True)
            generated_dir.mkdir(parents=True, exist_ok=True)
            (specs_dir / f"{self.PROJECT}.agent.yaml").write_text(stale_cfg.config_text())

            with (
                patch("scripts.agentctl.BACKEND_SPEC_ROOTS", {"pod": specs_dir, "kubevirt-vm": output_dir / "config" / "kubevirt" / "specs"}),
                patch("scripts.agentctl.BACKEND_GENERATED_ROOTS", {"pod": generated_dir, "kubevirt-vm": output_dir / "config" / "kubevirt" / "generated"}),
                patch("scripts.agentctl.SECRETS_DIR", secrets_dir),
            ):
                loaded = load_project_config(self.PROJECT)

        self.assertEqual(
            [item.key for item in loaded.auth_files],
            ["codex-auth.json", "codex-config.toml", "claude-settings.json"],
        )
        self.assertEqual(loaded.auth_files[0].content, '{"auth_mode":"chatgpt"}')

    def test_minimal_bootstrap_keeps_sudo_passwordless(self) -> None:
        cfg = self.make_config(
            bootstrap_profile="minimal",
        )

        rendered = cfg.build_container_bootstrap_lines()
        self.assertIn("NOPASSWD: ALL", rendered)

    def test_prebuilt_bootstrap_skips_package_and_cli_install(self) -> None:
        cfg = self.make_agent_config(
            bootstrap_profile="prebuilt",
            git_core_editor="vi",
            git_user_name="Qiang Liu",
            git_user_email="cyruscyliu@gmail.com",
        )

        rendered = cfg.build_container_bootstrap_lines()

        self.assertNotIn("apt-get update", rendered)
        self.assertNotIn("npm install -g --prefix /opt/agent-cli @openai/codex", rendered)
        self.assertNotIn("npm install -g --prefix /opt/agent-cli pnpm", rendered)
        self.assertIn("git config --global core.editor vi", rendered)
        self.assertIn("git config --global pull.rebase true", rendered)
        self.assertIn("paseo daemon start", rendered)

    def test_root_prebuilt_bootstrap_repairs_profile_and_pnpm_symlink(self) -> None:
        cfg = self.make_agent_config(
            bootstrap_profile="prebuilt",
            runtime_user="root",
        )

        rendered = cfg.build_container_bootstrap_lines()

        self.assertIn("profile_fix_needed=0", rendered)
        self.assertIn("[ -f /root/.profile ] || profile_fix_needed=1", rendered)
        self.assertIn('if [ "$profile_fix_needed" = 1 ]; then', rendered)
        self.assertIn("touch /root/.profile", rendered)
        self.assertIn("for rc in /root/.profile /root/.bashrc /root/.zshrc; do", rendered)
        self.assertIn("grep -Eq", rendered)
        self.assertIn("awk 'BEGIN{seen=0}", rendered)
        self.assertIn("$0 ~ /\\$HOME\\/root\\/\\.cargo\\/env/", rendered)
        self.assertIn('print ". \\"$HOME/.cargo/env\\""', rendered)
        self.assertIn("readlink /usr/local/bin/pnpm", rendered)
        self.assertIn("ln -sf /opt/agent-cli/bin/pnpm /usr/local/bin/pnpm", rendered)

    def test_paseo_bootstrap_is_enabled_for_agents(self) -> None:
        rendered = build_paseo_bootstrap_line("multi", self.PROJECT, f"/home/{self.PROJECT}")
        self.assertIn(f"rm -f /home/{self.PROJECT}/.paseo/paseo.pid", rendered)
        self.assertIn("paseo daemon start --listen 0.0.0.0:6767", rendered)
        self.assertIn("paseo daemon pair --json", rendered)

    def test_full_bootstrap_pins_paseo_version(self) -> None:
        cfg = self.make_agent_config()

        rendered = cfg.build_container_bootstrap_lines()

        self.assertIn("Paseo-0.1.70-beta.1-amd64.deb", rendered)
        self.assertIn("apt-get install -y /tmp/paseo.deb", rendered)
        self.assertIn("ln -sf /opt/Paseo/resources/bin/paseo /usr/local/bin/paseo", rendered)
        self.assertIn("git config --global pull.rebase true", rendered)

    def test_paseo_runtime_cleanup_removes_only_stale_pid(self) -> None:
        rendered = build_paseo_runtime_cleanup_line(f"/home/{self.PROJECT}")

        self.assertEqual(rendered, f"          rm -f /home/{self.PROJECT}/.paseo/paseo.pid && \\\n")

    def test_full_bootstrap_generates_default_ssh_keypair(self) -> None:
        cfg = self.make_config()

        rendered = cfg.build_container_bootstrap_lines()

        self.assertIn("apt-get install -y \\\n            openssh-client ", rendered)
        self.assertIn(f"mkdir -p /home/{self.PROJECT}/.ssh", rendered)
        self.assertIn("ssh-keygen -q -t ed25519 -C morpheus@agent-vault -N '' -f ~/.ssh/id_ed25519", rendered)

    def test_root_ssh_keygen_line_is_idempotent(self) -> None:
        rendered = build_ssh_keygen_line("root", "/root")

        self.assertIn("chown root:root /root/.ssh", rendered)
        self.assertIn("if [ ! -f /root/.ssh/id_ed25519 ]; then", rendered)
        self.assertIn("ssh-keygen -q -t ed25519 -C morpheus@agent-vault -N '' -f /root/.ssh/id_ed25519", rendered)
        self.assertIn("stat -c %U:%G /root/.ssh/id_ed25519", rendered)
        self.assertIn("chmod 400 /root/.ssh/id_ed25519", rendered)
        self.assertIn("stat -c %U:%G /root/.ssh/id_ed25519.pub", rendered)
        self.assertIn("chmod 644 /root/.ssh/id_ed25519.pub", rendered)
        self.assertIn("for ssh_meta in /root/.ssh/authorized_keys /root/.ssh/known_hosts /root/.ssh/known_hosts.old", rendered)
        self.assertIn("chmod 600 \"$ssh_meta\"", rendered)

    def test_root_agent_dirs_line_normalizes_modes(self) -> None:
        from scripts.agentctl import build_agent_dirs_line

        rendered = build_agent_dirs_line("root", "/root")

        self.assertIn("chown root:root /root /root/.codex /root/.claude /root/.paseo", rendered)
        self.assertIn("chmod 755 /root", rendered)
        self.assertIn("chmod 755 /root/.codex", rendered)
        self.assertIn("chmod 755 /root/.claude", rendered)
        self.assertIn("chmod 700 /root/.paseo", rendered)

    def test_container_identity_uses_project_name(self) -> None:
        cfg = self.make_agent_config()
        rendered = cfg.build_container_bootstrap_lines()
        self.assertEqual(cfg.container_user, self.PROJECT)
        self.assertEqual(cfg.container_home, f"/home/{self.PROJECT}")
        self.assertIn(f"useradd -m -s /bin/bash {self.PROJECT}", rendered)
        self.assertIn(f"{self.PROJECT} ALL=(ALL) NOPASSWD: ALL", rendered)

    def test_full_bootstrap_does_not_include_shell_editor_mux_setup(self) -> None:
        cfg = self.make_agent_config(
            cpu="1",
            memory="2Gi",
            storage="10Gi",
            all_packages="python3",
        )

        rendered = cfg.build_container_bootstrap_lines()
        for legacy_marker in ("setup-zsh.sh", "setup-nvim.sh", "setup-tmux.sh", "usermod -s"):
            with self.subTest(marker=legacy_marker):
                self.assertNotIn(legacy_marker, rendered)

    def test_full_bootstrap_can_set_git_core_editor(self) -> None:
        cfg = self.make_agent_config(git_core_editor="vi")

        rendered = cfg.build_container_bootstrap_lines()

        self.assertIn("git config --global core.editor vi", rendered)

    def test_full_bootstrap_can_set_git_identity(self) -> None:
        cfg = self.make_agent_config(
            git_user_name="Qiang Liu",
            git_user_email="cyruscyliu@gmail.com",
        )

        rendered = cfg.build_container_bootstrap_lines()

        self.assertIn("git config --global user.name 'Qiang Liu'", rendered)
        self.assertIn("git config --global user.email cyruscyliu@gmail.com", rendered)

    def test_pnpm_is_installed_via_npm_not_apt(self) -> None:
        cfg = self.make_agent_config(all_packages="nodejs npm pnpm python3")

        rendered = cfg.build_container_bootstrap_lines()

        self.assertNotIn("apt-get install -y \\\n            openssh-client nodejs npm pnpm python3", rendered)
        self.assertIn("apt-get install -y \\\n            openssh-client nodejs npm python3", rendered)
        self.assertIn("npm install -g --prefix /opt/agent-cli pnpm", rendered)

    def test_readiness_probe_checks_ready_file_and_pvc_mount(self) -> None:
        cfg = self.make_agent_config()

        rendered = cfg.yaml_text()

        self.assertIn('command: ["sh", "-ec", "test -f /tmp/.ready"]', rendered)
        self.assertIn("          timeoutSeconds: 5", rendered)

    def test_apply_saved_project_waits_for_rollout_when_template_changes(self) -> None:
        cfg = self.make_agent_config()

        with (
            patch("scripts.agentctl.load_project_config", return_value=cfg),
            patch("scripts.agentctl.write_project_files"),
            patch("scripts.agentctl.apply_project_manifest"),
            patch("scripts.agentctl.get_deployment_generation", side_effect=["1", "1", "2", "2"]),
            patch("scripts.agentctl.wait_for_deployment_ready", return_value="pod/morpheus-new") as wait_ready,
        ):
            apply_saved_project(self.PROJECT)

        wait_ready.assert_called_once_with(self.PROJECT)


if __name__ == "__main__":
    unittest.main()
