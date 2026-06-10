# Architecture Decision Records

This directory records the technical decisions made for the `wayland-paste`
extension, using a lightweight ADR format (Context / Decision / Consequences).

## Index

| ID                                                  | Title                                                       | Status   |
| --------------------------------------------------- | ----------------------------------------------------------- | -------- |
| [0001](0001-mirror-diodon-workflow.md)              | Mirror Diodon's clipboard-manager workflow                  | Accepted |
| [0002](0002-inject-via-virtual-device.md)           | Inject paste via the in-process Clutter virtual device      | Accepted |
| [0003](0003-focus-target-and-paste-timing.md)       | Capture the focus target on open, paste after the menu closes | Accepted |
| [0004](0004-uuid-namespace.md)                      | Use `@VitalyOstanin` as the uuid namespace                  | Accepted |
| [0005](0005-poll-the-clipboard.md)                  | Poll the clipboard (no Wayland change signal)               | Accepted |
| [0006](0006-support-gnome-45-to-50.md)              | Declare and verify support for GNOME 45-50                  | Accepted |
| [0007](0007-resource-cleanup-on-disable.md)         | Restore all touched state on disable                        | Accepted |
| [0008](0008-reuse-shortcut-picker.md)               | Reuse the mute-all-mics shortcut picker for the menu hotkey | Accepted |
