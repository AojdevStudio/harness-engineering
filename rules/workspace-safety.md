# Workspace Safety Rules

## Path Containment

Do normalize both workspace root and per-issue workspace paths before use.

Do require every workspace path to remain inside `workspace.root`.

Do not launch Codex unless `cwd` equals the per-issue workspace path.

Reason: path traversal or cwd drift breaks the isolation guarantee that Symphony depends on.

## Workspace Keys

Do derive the workspace directory from `issue.identifier` by replacing every character outside `[A-Za-z0-9._-]` with `_`.

Do not use raw tracker identifiers directly as filesystem paths.

Reason: tracker identifiers are human-facing strings, not safe path components.

## Multi-Worktree Ports

Do use ephemeral ports (`0`) or unique CLI `--port` values when multiple worktrees run the status server.

Do not commit examples that force all worktrees onto the same fixed status-server port.

Reason: fixed local ports collide and can make one worker inspect another worker's status surface.
