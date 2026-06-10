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

// Timing of the paste after the menu closes. The menu is driven by mouse only
// (like an on-screen keyboard): the user clicks an entry, the menu closes, and we
// return keyboard focus to the target window before injecting the paste keys.
//
// PASTE_DELAY_MS     — wait for the modal grab to release before returning focus.
// ACTIVATE_SETTLE_MS — after returning focus, wait for it to land before typing.
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
    this._target = null; // focus window captured when the menu opens

    const dataDir = GLib.build_filenamev([
      GLib.get_user_data_dir(),
      "wayland-paste",
    ]);
    this._store = new HistoryStore(dataDir);
    if (this._settings.get_boolean("keep-clipboard-content"))
      this._store.load();

    this._paster = new Paster();

    this._monitor = new ClipboardMonitor(this._settings, this._store, () =>
      this._indicator?.refresh(),
    );
    this._monitor.start();

    this._indicator = new ClipboardIndicator(this._store, {
      onActivate: (entry) => this._onActivate(entry),
      onClear: () => this._onClear(),
      onOpen: () => this._onMenuOpen(),
      onClose: () => this._onMenuClosed(),
      onSettings: () => this.openPreferences(),
    });
    Main.panel.addToStatusArea(this.uuid, this._indicator);
    this._applyIndicatorVisibility();

    this._bindShortcut();

    this._settingsChangedId = this._settings.connect("changed", (_s, key) =>
      this._onSettingChanged(key),
    );
  }

  disable() {
    if (this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = 0;
    }

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

  // --- menu / paste flow ---------------------------------------------------

  _onMenuOpen() {
    // Remember the window that had focus before the menu grabbed input. The
    // modal grab does not change the Meta focus window, so this is the real
    // paste target.
    this._target = global.display.focus_window ?? null;
  }

  _onActivate(entry) {
    // Put the chosen entry back on the clipboard and promote it in the history.
    // If the clipboard write itself fails, do not arm a paste: it would type the
    // wrong (stale) content, and the history/clipboard would be out of sync.
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

    // Arm a paste for when the menu finishes closing, if instant paste is on.
    this._pendingTarget = this._settings.get_boolean("instant-paste")
      ? (this._target ?? null)
      : undefined;
    // The activated PopupMenuItem closes the menu, which triggers
    // _onMenuClosed() where the paste is scheduled.
  }

  _onMenuClosed() {
    const pending = this._pendingTarget;
    this._pendingTarget = undefined;

    if (pending === undefined) {
      // Closed without pasting (Escape, click-away). The search entry held the
      // keyboard focus on the shell stage. Returning it from this handler does
      // not work: open-state-changed is emitted synchronously inside
      // PopupMenu.close(), and PopupMenuManager pops the modal grab (and restores
      // focus) from its own handler of the same signal — running in the same
      // emission, it overrides our change. One main-loop tick is enough to run
      // after that emission completes, so an idle callback (not a fixed delay) is
      // the minimal correct wait.
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

  // Return keyboard focus to the target window. The menu grab does not change the
  // Meta focus window, so the target is usually already focused and clearing the
  // stage key focus is enough; re-activating an already-focused window forces a
  // focus-out/in cycle that some apps treat as a swallowed keypress, so we only
  // activate if focus differs.
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

  // Return focus to the target window, then inject the paste once focus settles.
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

  _setImageClipboard(entry) {
    // Read the backing file asynchronously so the Shell main loop is not blocked
    // on disk I/O; the clipboard is set in the completion callback. The 120 ms
    // paste delay gives this ample headroom to finish before the keys are sent.
    const file = Gio.File.new_for_path(entry.file);
    file.load_contents_async(null, (obj, res) => {
      let contents;
      try {
        const [ok, data] = obj.load_contents_finish(res);
        if (!ok) return;
        contents = data;
      } catch (err) {
        logError(err, "[wayland-paste] failed to read image entry for paste");
        return;
      }
      const bytes = GLib.Bytes.new(contents);
      this._clipboard.set_content(
        St.ClipboardType.CLIPBOARD,
        entry.mimetype,
        bytes,
      );
      // Mark our own write as seen so the next poll does not re-record it (the
      // text branch does the same via markSeen).
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
    });
  }

  _onClear() {
    this._store.clear();
    if (this._settings.get_boolean("keep-clipboard-content"))
      this._store.saveAsync();
    this._indicator?.refresh();
  }

  // --- settings ------------------------------------------------------------

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

  // --- shortcut ------------------------------------------------------------

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
