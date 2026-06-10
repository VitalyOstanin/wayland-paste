# 0004 - Use `@VitalyOstanin` as the uuid namespace

Status: Accepted

## Context

A GNOME Shell extension uuid must be globally unique and is conventionally
namespaced with a domain or account after the `@`. The stem `wayland-paste` is
generic enough to collide with unrelated work.

## Decision

Use `wayland-paste@VitalyOstanin` as the uuid, matching the author's other
extensions (`notification-banner@VitalyOstanin`,
`mute-all-mics@VitalyOstanin`, `maximize-new-windows@VitalyOstanin`, and so on).
The directory name and the GitHub repository name are `wayland-paste`.

## Consequences

- Consistent ownership and layout with the author's other extensions.
- No collision with public extensions that share the `wayland-paste` stem under a
  different namespace.
