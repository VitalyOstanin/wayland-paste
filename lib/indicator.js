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

// The panel button and its history menu. Keyboard and mouse both work: the menu
// is a standard PopupMenu (arrow keys navigate items, Enter activates, click
// activates), with a search entry on top that filters the list and forwards Down
// / Enter into the results.
export const ClipboardIndicator = GObject.registerClass(
  class WaylandPasteIndicator extends PanelMenu.Button {
    _init(store, callbacks) {
      super._init(0.0, "Wayland Paste");

      this._store = store;
      this._onActivate = callbacks.onActivate;
      this._onClear = callbacks.onClear;
      this._onOpen = callbacks.onOpen;
      this._onClose = callbacks.onClose;
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
      this._entry.clutter_text.connect("key-press-event", (_a, event) =>
        this._onEntryKeyPress(event),
      );
      this._searchItem.add_child(this._entry);
      this.menu.addMenuItem(this._searchItem);

      // Section holding the (filtered) list of entries.
      this._listSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._listSection);

      // Footer: clear history.
      this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
      this._clearItem = new PopupMenu.PopupMenuItem("Clear history");
      this._clearItem.connect("activate", () => this._onClear?.());
      this.menu.addMenuItem(this._clearItem);

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

    // Rebuild immediately if one is pending, so keyboard navigation acts on the
    // current filter rather than the pre-keystroke list.
    _flushRebuild() {
      if (this._rebuildTimerId) {
        this._cancelRebuild();
        this._rebuild(this._entry.get_text());
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

    // Down moves focus into the list; Enter activates the first visible entry.
    _onEntryKeyPress(event) {
      const symbol = event.get_key_symbol();
      // A debounced rebuild may still be pending from the last keystroke; flush
      // it so navigation acts on the list matching the current filter text.
      this._flushRebuild();
      const items = this._listSection._getMenuItems().filter((i) => i.reactive);

      if (symbol === Clutter.KEY_Down) {
        if (items.length > 0) {
          global.stage.set_key_focus(items[0].actor ?? items[0]);
          items[0].active = true;
        }
        return Clutter.EVENT_STOP;
      }
      if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
        if (items.length > 0) {
          items[0].activate(event);
          return Clutter.EVENT_STOP;
        }
        // Empty list: intentionally fall through to EVENT_PROPAGATE so Enter is
        // not swallowed (unlike Down, which always stops). No-op by design.
      }
      return Clutter.EVENT_PROPAGATE;
    }

    // Refresh the list if the menu is currently open (history changed underneath).
    refresh() {
      if (this.menu.isOpen) this._rebuild(this._entry.get_text());
    }
  },
);
