# 0001 - Mirror Diodon's clipboard-manager workflow

Status: Accepted

## Context

Diodon (https://github.com/diodon-dev/diodon) is an X11 clipboard manager: it
keeps a history of recent clipboard and primary-selection entries, shows them in
a menu, and (with instant paste) types the paste shortcut into the focused
window after an entry is chosen. On Wayland its instant paste uses XTest through
XWayland, which GNOME routes through the Remote Desktop portal, raising a
permission dialog and a persistent screen-sharing indicator.

The goal of this extension is the same workflow under Wayland without that
dialog.

## Decision

Reproduce Diodon's feature set and settings as closely as practical: history
size, tracking the clipboard and the primary selection, optional synchronization
of the two, an ignore pattern, optional image entries, persistence, instant
paste, and per-application paste shortcuts. The setting keys are named after
their Diodon counterparts where one exists (see the schema), with a few
Wayland-specific additions (poll interval, menu shortcut, indicator toggle).

## Consequences

- Users coming from Diodon find the same options.
- Some Diodon internals do not map one-to-one (Diodon matches per-app shortcuts
  by executable path; this extension matches by `WM_CLASS`, which is what a
  Shell extension can observe).
- The implementation differs fundamentally in the paste mechanism (see
  [0002](0002-inject-via-virtual-device.md)) and in change detection (see
  [0005](0005-poll-the-clipboard.md)).
