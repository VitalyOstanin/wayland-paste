# 0006 - Declare and verify support for GNOME 45-50

Status: Accepted

## Context

The author's extensions target the current span of GNOME Shell versions that use
the ESM extension API (45 introduced ESM). GNOME's Meta/Shell/Clutter/St API is
not stable across major versions, so support must be verified, not assumed.

## Decision

`metadata.json` declares `shell-version` 45 through 50. Every symbol the
extension uses is verified against each declared version using the local upstream
checkouts:

- `/home/vyt/devel/gnome/gnome-shell`
- `/home/vyt/devel/gnome/mutter`

with `git grep <ref>` without switching the working tree. New GNOME versions are
added only after re-running the verification.

## Consequences

- The extension uses feature detection, not version-number branching.
- Adding a version is a checklist: confirm the branch exists, verify the API
  surface, then add the number to `shell-version`.
- The verified API surface is recorded in `CLAUDE.md`.
