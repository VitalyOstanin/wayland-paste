// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

import { HistoryStore } from "./lib/historyStore.js";
import { ClipboardMonitor } from "./lib/clipboardMonitor.js";
import { Paster } from "./lib/paster.js";
import { ClipboardIndicator } from "./lib/indicator.js";

// PASTE_DELAY_MS: wait for the modal grab to release before returning focus.
// ACTIVATE_SETTLE_MS: after returning focus, wait for it to land before typing.
const PASTE_DELAY_MS = 120;
const ACTIVATE_SETTLE_MS = 80;

const KEYBINDING = "toggle-menu";

export default class WaylandPasteExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._clipboard = St.Clipboard.get_default();
    this._pasteDelayId = 0;
    this._injectDelayId = 0;
    this._pendingTarget = undefined; // set on activate, consumed on menu close
    this._target = null;

    const dataDir = GLib.build_filenamev([
      GLib.get_user_data_dir(),
      "wayland-paste",
    ]);
    this._store = new HistoryStore(dataDir);
    // load() is async; refresh the menu once it resolves. The .catch guards a
    // throw from refresh() so it does not escape as an unhandled rejection.
    if (this._settings.get_boolean("keep-clipboard-content"))
      this._store
        .load(this._settings.get_int("history-size"))
        .then(() => this._indicator?.refresh())
        .catch((err) =>
          logError(err, "[wayland-paste] failed to refresh after history load"),
        );

    this._paster = new Paster();

    this._monitor = new ClipboardMonitor(this._settings, this._store, () =>
      this._indicator?.refresh(),
    );
    this._monitor.start();

    this._indicator = new ClipboardIndicator(this._store, this._settings, {
      onActivate: (entry) => this._onActivate(entry),
      onClear: () => this._onClear(),
      onOpen: () => this._onMenuOpen(),
      onClose: () => this._onMenuClosed(),
      onSettings: () => this.openPreferences(),
    });
    Main.panel.addToStatusArea(this.uuid, this._indicator);
    this._applyIndicatorVisibility();

    this._bindShortcut();

    // connectObject owned by `this`; disable() drops it with disconnectObject(this).
    this._settings.connectObject(
      "changed",
      (_s, key) => this._onSettingChanged(key),
      this,
    );
  }

  disable() {
    this._settings?.disconnectObject(this);

    this._unbindShortcut();

    if (this._pasteDelayId) {
      GLib.source_remove(this._pasteDelayId);
      this._pasteDelayId = 0;
    }

    if (this._injectDelayId) {
      GLib.source_remove(this._injectDelayId);
      this._injectDelayId = 0;
    }

    if (this._monitor) {
      this._monitor.stop();
      this._monitor = null;
    }

    // Persist before tearing down, if enabled.
    if (this._store && this._settings?.get_boolean("keep-clipboard-content"))
      this._store.save();
    this._store = null;

    if (this._paster) {
      this._paster.destroy();
      this._paster = null;
    }

    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    this._clipboard = null;
    this._settings = null;
    this._pendingTarget = undefined;
    this._target = null;
  }

  _onMenuOpen() {
    // The modal grab does not change the Meta focus window, so this captures
    // the real paste target.
    this._target = global.display.focus_window ?? null;
  }

  _onActivate(entry) {
    // If the clipboard write fails, do not arm a paste: it would type stale
    // content and leave history and clipboard out of sync.
    try {
      if (entry.type === "text") {
        this._clipboard.set_text(St.ClipboardType.CLIPBOARD, entry.text);
        this._monitor?.markSeen(St.ClipboardType.CLIPBOARD, entry.text);
        this._store.addText(entry.text, this._settings.get_int("history-size"));
      } else if (entry.type === "image") {
        this._setImageClipboard(entry);
      }
    } catch (err) {
      logError(err, "[wayland-paste] failed to set clipboard for paste");
      return;
    }

    this._pendingTarget = this._settings.get_boolean("instant-paste")
      ? (this._target ?? null)
      : undefined;
    // Activating the item closes the menu; _onMenuClosed() schedules the paste.
  }

  _onMenuClosed() {
    const pending = this._pendingTarget;
    this._pendingTarget = undefined;

    if (pending === undefined) {
      // Closed without pasting (Escape, click-away). open-state-changed fires
      // synchronously inside PopupMenu.close(), where PopupMenuManager restores
      // focus from its own handler of the same signal and would override a focus
      // change made here; an idle callback runs after that emission completes.
      if (this._pasteDelayId) GLib.source_remove(this._pasteDelayId);
      this._pasteDelayId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
        this._pasteDelayId = 0;
        this._focusTarget(this._target);
        return GLib.SOURCE_REMOVE;
      });
      return;
    }

    // Wait for the modal grab to release, then return focus and paste.
    if (this._pasteDelayId) GLib.source_remove(this._pasteDelayId);
    this._pasteDelayId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      PASTE_DELAY_MS,
      () => {
        this._pasteDelayId = 0;
        this._focusAndInject(pending);
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  // Return keyboard focus to the target window. Re-activating an already-focused
  // window forces a focus-out/in cycle that some apps treat as a swallowed
  // keypress, so only activate if focus differs.
  _focusTarget(target) {
    global.stage.set_key_focus(null);
    if (target && target !== global.display.focus_window) {
      try {
        Main.activateWindow(target);
      } catch (err) {
        logError(err, "[wayland-paste] failed to activate paste target");
      }
    }
  }

  _focusAndInject(target) {
    this._focusTarget(target);

    if (this._injectDelayId) GLib.source_remove(this._injectDelayId);
    this._injectDelayId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      ACTIVATE_SETTLE_MS,
      () => {
        this._injectDelayId = 0;
        this._injectPaste(target);
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _injectPaste(target) {
    const wmClasses = target
      ? [target.get_wm_class?.(), target.get_wm_class_instance?.()].filter(
          Boolean,
        )
      : [];
    const accel = Paster.resolveAccelerator(
      this._settings.get_strv("paste-keybindings"),
      wmClasses,
      this._settings.get_string("default-paste-keybinding"),
    );
    this._paster.injectAccelerator(accel);
  }

  async _setImageClipboard(entry) {
    // Async read so the main loop is not blocked on disk I/O; the body is
    // guarded so this fire-and-forget call never rejects.
    try {
      const [contents] = await Gio.File.new_for_path(
        entry.file,
      ).load_contents_async(null);
      // The await yielded; disable() may have nulled these fields meanwhile.
      if (!this._clipboard || !this._store) return;
      this._clipboard.set_content(
        St.ClipboardType.CLIPBOARD,
        entry.mimetype,
        GLib.Bytes.new(contents),
      );
      // Mark our own write as seen so the next poll does not re-record it.
      this._monitor?.markSeenImage(
        St.ClipboardType.CLIPBOARD,
        entry.mimetype,
        contents,
      );
      this._store.addImage(
        contents,
        entry.mimetype,
        this._settings.get_int("history-size"),
      );
    } catch (err) {
      logError(err, "[wayland-paste] failed to set image clipboard for paste");
    }
  }

  _onClear() {
    this._store.clear();
    if (this._settings.get_boolean("keep-clipboard-content"))
      this._store.saveAsync();
    this._indicator?.refresh();
  }

  _onSettingChanged(key) {
    switch (key) {
      case "poll-interval-ms":
        this._monitor?.restart();
        break;
      case "filter-pattern":
        this._monitor?.refreshFilter();
        break;
      case "show-indicator":
        this._applyIndicatorVisibility();
        break;
      case "menu-max-rows":
        // An open menu re-measures on its next open.
        this._indicator?.refresh();
        break;
      case KEYBINDING:
        this._rebindShortcut();
        break;
      default:
        break;
    }
  }

  _applyIndicatorVisibility() {
    const show = this._settings.get_boolean("show-indicator");
    if (this._indicator?.container) this._indicator.container.visible = show;
  }

  _bindShortcut() {
    Main.wm.addKeybinding(
      KEYBINDING,
      this._settings,
      Meta.KeyBindingFlags.NONE,
      Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
      () => this._indicator?.menu.toggle(),
    );
  }

  _unbindShortcut() {
    Main.wm.removeKeybinding(KEYBINDING);
  }

  _rebindShortcut() {
    // addKeybinding reads the accelerator once; re-register to pick up changes.
    this._unbindShortcut();
    this._bindShortcut();
  }
}
