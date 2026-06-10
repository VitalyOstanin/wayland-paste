// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

// How many characters of a text entry to show on one line in the menu.
const LABEL_MAX = 60;

// Pixel size of the thumbnail icon shown for image entries.
const THUMBNAIL_ICON_SIZE = 48;

// Bytes per KiB, for the image-size label.
const BYTES_PER_KIB = 1024;

// Debounce window for rebuilding the filtered list while typing in the search
// box. Rebuilding tears down and recreates every Clutter actor in the list, so
// coalescing keystrokes avoids doing that work on each character.
const REBUILD_DEBOUNCE_MS = 80;

// Collapse whitespace and truncate for a single-line menu label.
function previewText(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > LABEL_MAX
    ? `${oneLine.slice(0, LABEL_MAX - 1)}…`
    : oneLine;
}

// The panel button and its history menu. The menu is mouse-driven (like the
// on-screen keyboard): a search entry on top filters the list as you type, and
// entries are selected by clicking them. Keyboard activation is intentionally not
// wired up — see ADR 0003.
export const ClipboardIndicator = GObject.registerClass(
  class WaylandPasteIndicator extends PanelMenu.Button {
    _init(store, callbacks) {
      super._init(0.0, "Wayland Paste");

      this._store = store;
      this._onActivate = callbacks.onActivate;
      this._onClear = callbacks.onClear;
      this._onOpen = callbacks.onOpen;
      this._onClose = callbacks.onClose;
      this._onSettings = callbacks.onSettings;
      this._rebuildTimerId = 0;

      this.add_child(
        new St.Icon({
          icon_name: "edit-paste-symbolic",
          style_class: "system-status-icon",
        }),
      );

      // Search entry (does not close the menu, keeps focus on typing).
      this._searchItem = new PopupMenu.PopupBaseMenuItem({
        reactive: false,
        can_focus: false,
        style_class: "wayland-paste-search",
      });
      this._entry = new St.Entry({
        hint_text: "Search…",
        can_focus: true,
        x_expand: true,
      });
      this._entry.clutter_text.connect("text-changed", () =>
        this._scheduleRebuild(),
      );
      this._searchItem.add_child(this._entry);
      this.menu.addMenuItem(this._searchItem);

      // Section holding the (filtered) list of entries.
      this._listSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._listSection);

      // Footer: clear history, then open settings.
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this._clearItem = new PopupMenu.PopupMenuItem("Clear history");
      this._clearItem.connect("activate", () => this._onClear?.());
      this.menu.addMenuItem(this._clearItem);
      this._settingsItem = new PopupMenu.PopupMenuItem("Settings");
      this._settingsItem.connect("activate", () => this._onSettings?.());
      this.menu.addMenuItem(this._settingsItem);

      this.menu.connect("open-state-changed", (_menu, open) => {
        if (open) {
          // Record the focus target before navigating; the modal grab does not
          // change the Meta focus window, so this still reports the app window.
          this._onOpen?.();
          this._entry.set_text("");
          this._cancelRebuild(); // set_text queued a debounced rebuild; supersede it
          this._rebuild("");
          // Focus the search entry so typing filters immediately.
          global.stage.set_key_focus(this._entry.clutter_text);
        } else {
          this._cancelRebuild();
          this._onClose?.();
        }
      });
    }

    // Debounce list rebuilds while typing: coalesce rapid keystrokes into one
    // rebuild instead of tearing down and recreating actors on each character.
    _scheduleRebuild() {
      this._cancelRebuild();
      this._rebuildTimerId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        REBUILD_DEBOUNCE_MS,
        () => {
          this._rebuildTimerId = 0;
          this._rebuild(this._entry.get_text());
          return GLib.SOURCE_REMOVE;
        },
      );
    }

    _cancelRebuild() {
      if (this._rebuildTimerId) {
        GLib.source_remove(this._rebuildTimerId);
        this._rebuildTimerId = 0;
      }
    }

    destroy() {
      this._cancelRebuild();
      super.destroy();
    }

    // Rebuild the visible list for the given filter text.
    _rebuild(filter) {
      this._listSection.removeAll();

      const needle = (filter ?? "").toLowerCase();
      const matches = this._store.entries.filter((e) => {
        if (!needle) return true;
        if (e.type === "text") return e.text.toLowerCase().includes(needle);
        return "image".includes(needle); // images match the word "image"
      });

      if (matches.length === 0) {
        const empty = new PopupMenu.PopupMenuItem(
          this._store.entries.length === 0 ? "History is empty" : "No matches",
          { reactive: false, style_class: "wayland-paste-empty" },
        );
        this._listSection.addMenuItem(empty);
        return;
      }

      for (const entry of matches)
        this._listSection.addMenuItem(this._makeItem(entry));
    }

    _makeItem(entry) {
      if (entry.type === "image") {
        const item = new PopupMenu.PopupBaseMenuItem();
        const icon = new St.Icon({
          gicon: Gio.FileIcon.new(Gio.File.new_for_path(entry.file)),
          icon_size: THUMBNAIL_ICON_SIZE,
          style_class: "wayland-paste-thumbnail",
        });
        item.add_child(icon);
        item.add_child(
          new St.Label({
            text: `Image (${Math.round(entry.size / BYTES_PER_KIB)} KiB)`,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
          }),
        );
        item.connect("activate", () => this._onActivate?.(entry));
        return item;
      }

      const item = new PopupMenu.PopupMenuItem(previewText(entry.text));
      // Keep the full text available as a tooltip-like accessible hint.
      item.label.get_clutter_text().set_line_wrap(false);
      item.connect("activate", () => this._onActivate?.(entry));
      return item;
    }

    // Refresh the list if the menu is currently open (history changed
    // underneath). Routed through the debounce so a burst of history changes
    // coalesces into one rebuild instead of rebuilding per change.
    refresh() {
      if (this.menu.isOpen) this._scheduleRebuild();
    }
  },
);
