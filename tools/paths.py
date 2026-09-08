"""Shared, dependency-free paths for Polaris tool-managed scopes."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path


WORKSPACE_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,62}$")
COLLECTION_SCOPE = Path("acquisition/customer-data-collection")
REACHING_OUT_SCOPE = Path("acquisition/reaching-out")


class WorkspacePathError(ValueError):
    """A Polaris workspace root, ID, or managed scope is invalid."""


@dataclass(frozen=True)
class CollectionPaths:
    root: Path
    workspace: str
    scope: Path

    @property
    def case(self) -> Path:
        return self.scope / "case"

    @property
    def inputs(self) -> Path:
        return self.scope / "inputs"

    @property
    def work(self) -> Path:
        return self.scope / "work"

    @property
    def runs(self) -> Path:
        return self.scope / "runs"

    @property
    def outputs(self) -> Path:
        return self.scope / "outputs"

    @property
    def input_json(self) -> Path:
        return self.inputs / "input.json"


def workspace_root(value: str | None = None) -> Path:
    configured = value or os.environ.get("POLARIS_LITERATURE_WORKSPACES_ROOT")
    if not configured:
        raise WorkspacePathError(
            "--workspaces-root is required unless "
            "POLARIS_LITERATURE_WORKSPACES_ROOT is set"
        )
    root = Path(configured).expanduser().resolve()
    if not root.is_dir() or root.is_symlink():
        raise WorkspacePathError(f"workspace root does not exist: {root}")
    return root


def collection_paths(workspace: str, root: str | None = None) -> CollectionPaths:
    if not WORKSPACE_ID_PATTERN.fullmatch(workspace):
        raise WorkspacePathError(
            "workspace ID must match ^[a-z][a-z0-9-]{0,62}$"
        )
    base = workspace_root(root)
    workspace_entry = base / workspace
    if workspace_entry.is_symlink():
        raise WorkspacePathError(f"workspace is a symbolic link: {workspace_entry}")
    workspace_path = workspace_entry.resolve()
    if workspace_path.parent != base:
        raise WorkspacePathError(f"workspace resolves outside root: {workspace_path}")
    scope_entry = workspace_path / COLLECTION_SCOPE
    if scope_entry.is_symlink():
        raise WorkspacePathError(f"collection scope is a symbolic link: {scope_entry}")
    scope = scope_entry.resolve()
    if scope.parent.parent != workspace_path:
        raise WorkspacePathError("collection scope resolves outside workspace")
    if not scope.is_dir():
        raise WorkspacePathError(
            f"customer-data-collection scope does not exist: {scope}"
        )
    return CollectionPaths(root=base, workspace=workspace, scope=scope)
