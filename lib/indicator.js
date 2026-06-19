// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import St from "gi://St";

import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

// Max characters of a text entry shown on one menu line.
const LABEL_MAX = 60;

const THUMBNAIL_ICON_SIZE = 48;

const BYTES_PER_KIB = 1024;

// Debounce so a burst of keystrokes or history changes coalesces into one rebuild.
const REBUILD_DEBOUNCE_MS = 80;

function previewText(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > LABEL_MAX
    ? `${oneLine.slice(0, LABEL_MAX - 1)}…`
    : oneLine;
}

// The panel button and its history menu. The menu is mouse-driven; keyboard
// activation is intentionally not wired up — see ADR 0003.
export const ClipboardIndicator = GObject.registerClass(
  class WaylandPasteIndicator extends PanelMenu.Button {
    _init(store, settings, callbacks) {
      super._init(0.0, "Wayland Paste");

      this._store = store;
      this._settings = settings;
      this._onActivate = callbacks.onActivate;
      this._onClear = callbacks.onClear;
      this._onOpen = callbacks.onOpen;
      this._onClose = callbacks.onClose;
      this._onSettings = callbacks.onSettings;
      this._rebuildTimerId = 0;
      this._itemsById = new Map();

      this.add_child(
        new St.Icon({
          icon_name: "edit-paste-symbolic",
          style_class: "system-status-icon",
        }),
      );

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

      // Wrap the list in a ScrollView so a full history does not make the menu
      // taller than the screen. Without it the boxpointer is pushed up to fit
      // the bottom on screen, moving the newest entries above the top edge where
      // they are not visible. The scrollbar only engages because PanelMenu sets
      // a CSS max-height on the top menu actor (see panelMenu _onOpenStateChanged).
      this._listSection = new PopupMenu.PopupMenuSection();
      this._listScroll = new St.ScrollView({
        style_class: "wayland-paste-scroll",
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
        x_expand: true,
        child: this._listSection.actor,
      });
      this._listScroll.clip_to_allocation = true;
      this.menu.box.add_child(this._listScroll);
      // Section is in the ScrollView (added via box.add_child, not
      // menu.addMenuItem), so it has no menu parent; without one, activating an
      // item cannot reach the top menu to close it. Wire the parent explicitly.
      this._listSection._setParent(this.menu);

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
          // change the Meta focus window, so this reports the app window.
          this._onOpen?.();
          // The list is kept current while the menu is closed (see refresh), so
          // it already shows the freshest entry on top. Do NOT rebuild here:
          // PopupMenu.open() sizes and animates the boxpointer before emitting
          // "open-state-changed", so a rebuild run now (sync or deferred) shows
          // the previous list until it lands. Just clear leftover search text
          // (a no-op when already empty) and focus the field.
          this._entry.set_text("");
          // The list is laid out by PopupMenu.open() before this fires, so the
          // first row now has a real height to measure the row cap from.
          this._applyMenuMaxHeight();
          global.stage.set_key_focus(this._entry.clutter_text);
        } else {
          // Reset the filter and restore the full list while hidden, so the next
          // open is correct and current. This rebuild is invisible (menu closing).
          this._entry.set_text("");
          this._cancelRebuild();
          this._rebuild("");
          this._onClose?.();
        }
      });
    }

    _scheduleRebuild() {
      this._cancelRebuild();
      this._rebuildTimerId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        REBUILD_DEBOUNCE_MS,
        () => {
          this._rebuildTimerId = 0;
          // Apply the search filter only while the menu is open; when closed,
          // keep the full list current so the next open shows everything.
          this._rebuild(this.menu.isOpen ? this._entry.get_text() : "");
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

    _rebuild(filter) {
      const needle = (filter ?? "").toLowerCase();
      const matches = this._store.entries.filter((e) => {
        if (!needle) return true;
        if (e.type === "text") return e.text.toLowerCase().includes(needle);
        return "image".includes(needle); // images match the word "image"
      });

      if (matches.length === 0) {
        this._listSection.removeAll();
        this._itemsById.clear();
        const empty = new PopupMenu.PopupMenuItem(
          this._store.entries.length === 0 ? "History is empty" : "No matches",
          { reactive: false, style_class: "wayland-paste-empty" },
        );
        this._listSection.addMenuItem(empty);
        this._applyMenuMaxHeight();
        return;
      }

      // Diff by stable entry id (preserved across promotes): reuse and reorder
      // existing actors, build or destroy only what changed.
      const desired = new Set(matches.map((e) => e.id));

      for (const [id, item] of this._itemsById) {
        if (!desired.has(id)) {
          item.destroy();
          this._itemsById.delete(id);
        }
      }
      // Drop any untracked stray, e.g. the placeholder from an empty state.
      for (const item of this._listSection._getMenuItems())
        if (item._entryId === undefined) item.destroy();

      // Left-to-right placement keeps the [0..i] prefix correct, so a reused
      // actor is always at index >= i and never displaces a placed one.
      matches.forEach((entry, i) => {
        let item = this._itemsById.get(entry.id);
        if (!item) {
          item = this._makeItem(entry);
          item._entryId = entry.id;
          this._itemsById.set(entry.id, item);
          this._listSection.addMenuItem(item, i);
        } else {
          this._listSection.box.set_child_at_index(item, i);
        }
      });

      this._applyMenuMaxHeight();
    }

    // Cap the scroll view to menu-max-rows rows. The per-row pixel height is
    // measured from the first list item so the cap tracks the shell theme;
    // 0 rows (or an unmeasurable row, e.g. before first layout) clears the inline
    // cap, leaving the work-area max-height the shell sets as the only bound.
    _applyMenuMaxHeight() {
      const rows = this._settings?.get_int("menu-max-rows") ?? 0;
      const items = rows > 0 ? this._listSection._getMenuItems() : [];
      if (items.length === 0) {
        this._listScroll.set_style(null);
        return;
      }
      const [, natural] = items[0].get_preferred_height(-1);
      if (natural > 0)
        this._listScroll.set_style(`max-height: ${Math.round(rows * natural)}px`);
      else this._listScroll.set_style(null);
    }

    _makeItem(entry) {
      if (entry.type === "image") {
        const item = new PopupMenu.PopupBaseMenuItem();
        // Prefer the downscaled thumbnail; fall back to the full-size file until
        // the async thumbnail lands (updateThumbnail swaps it in then).
        const icon = new St.Icon({
          gicon: Gio.FileIcon.new(
            Gio.File.new_for_path(entry.thumb ?? entry.file),
          ),
          icon_size: THUMBNAIL_ICON_SIZE,
          style_class: "wayland-paste-thumbnail",
        });
        item._thumbIcon = icon;
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
      item.label.get_clutter_text().set_line_wrap(false);
      item.connect("activate", () => this._onActivate?.(entry));
      return item;
    }

    // Rebuild the list, even while the menu is closed, so opening it shows the
    // freshest entry immediately instead of rebuilding during the open animation
    // (which left the newest entry briefly missing). Routed through the debounce
    // so a burst of history changes coalesces into one rebuild.
    refresh() {
      this._scheduleRebuild();
    }

    // Swap a shown image item's full-size icon for its thumbnail once the store
    // has written it (the item is reused across rebuilds, so it would otherwise
    // keep the fallback icon until rebuilt from scratch).
    updateThumbnail(entry) {
      const item = this._itemsById.get(entry.id);
      if (item?._thumbIcon && entry.thumb)
        item._thumbIcon.gicon = Gio.FileIcon.new(
          Gio.File.new_for_path(entry.thumb),
        );
    }
  },
);
