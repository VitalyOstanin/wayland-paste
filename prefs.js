// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from "gi://Adw";
import Gdk from "gi://Gdk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

// Minimum visible height (px) of the per-app paste-keybindings editor.
const PER_APP_EDITOR_MIN_HEIGHT = 140;

// An Adw.ActionRow that captures a single keyboard shortcut interactively, like
// the picker in GNOME Settings. Built programmatically (no .ui template) to match
// the rest of these prefs. The pattern (capture-phase key controller, GNOME
// Settings validation rules) follows the author's mute-all-mics extension; the
// validation rules originate from the night-theme-switcher extension:
// https://gitlab.com/rmnvgr/nightthemeswitcher-gnome-shell-extension
const ShortcutRow = GObject.registerClass(
  class WaylandPasteShortcutRow extends Adw.ActionRow {
    // Only one row may listen at a time.
    static _listener = null;

    _init(settings, key, params = {}) {
      super._init(params);

      this._settings = settings;
      this._key = key;
      this._baseSubtitle = this.get_subtitle() ?? "";
      this._listening = false;

      this._shortcutLabel = new Gtk.ShortcutLabel({
        valign: Gtk.Align.CENTER,
        disabled_text: "Disabled",
      });

      this._clearButton = new Gtk.Button({
        icon_name: "edit-clear-symbolic",
        valign: Gtk.Align.CENTER,
        has_frame: false,
        tooltip_text: "Clear shortcut (disable)",
      });
      this._clearButton.connect("clicked", () => {
        this._stopListening();
        this._store(null);
      });

      this.add_suffix(this._shortcutLabel);
      this.add_suffix(this._clearButton);
      this.set_activatable(true);
      this.connect("activated", () => this._toggleListening());

      // The key controller lives on the window root and runs in the capture
      // phase so it sees the combination before focused widgets consume it.
      this._keyController = new Gtk.EventControllerKey();
      this._keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
      this._keyController.connect("key-pressed", this._onKeyPressed.bind(this));
      this._controllerRoot = null;
      this.connect("realize", () => {
        const root = this.get_root();
        if (root) {
          root.add_controller(this._keyController);
          this._controllerRoot = root;
        }
      });

      this._syncFromSettings();
      this._settingsChangedId = this._settings.connect(
        `changed::${key}`,
        () => this._syncFromSettings(),
      );
      this.connect("destroy", () => {
        if (this._settingsChangedId) {
          this._settings.disconnect(this._settingsChangedId);
          this._settingsChangedId = 0;
        }
        if (this._controllerRoot) {
          this._controllerRoot.remove_controller(this._keyController);
          this._controllerRoot = null;
        }
        if (ShortcutRow._listener === this) ShortcutRow._listener = null;
      });
    }

    _syncFromSettings() {
      const accels = this._settings.get_strv(this._key);
      const accel = accels.length ? accels[0] : "";
      this._shortcutLabel.set_accelerator(accel);
      this._clearButton.set_sensitive(accel !== "");
    }

    _store(accel) {
      this._settings.set_strv(this._key, accel ? [accel] : []);
      // _syncFromSettings runs via the changed:: handler.
    }

    _toggleListening() {
      if (this._listening) this._stopListening();
      else this._startListening();
    }

    _startListening() {
      if (ShortcutRow._listener && ShortcutRow._listener !== this)
        ShortcutRow._listener._stopListening();

      this._listening = true;
      ShortcutRow._listener = this;
      this.add_css_class("accent");
      this.set_subtitle(
        "Press the new shortcut — Esc to cancel, Backspace to clear",
      );
    }

    _stopListening() {
      if (!this._listening) return;
      this._listening = false;
      if (ShortcutRow._listener === this) ShortcutRow._listener = null;
      this.remove_css_class("accent");
      this.set_subtitle(this._baseSubtitle);
    }

    _onKeyPressed(_controller, keyval, keycode, state) {
      if (!this._listening) return Gdk.EVENT_PROPAGATE;

      let mask = state & Gtk.accelerator_get_default_mod_mask();
      mask &= ~Gdk.ModifierType.LOCK_MASK;

      if (mask === 0) {
        if (keyval === Gdk.KEY_Escape) {
          this._stopListening();
          return Gdk.EVENT_STOP;
        }
        if (keyval === Gdk.KEY_BackSpace) {
          this._store(null);
          this._stopListening();
          return Gdk.EVENT_STOP;
        }
      }

      if (
        !this._isBindingValid({ mask, keycode, keyval }) ||
        !Gtk.accelerator_valid(keyval, mask)
      )
        return Gdk.EVENT_STOP;

      const accel = Gtk.accelerator_name_with_keycode(
        null,
        keyval,
        keycode,
        mask,
      );
      this._store(accel);
      this._stopListening();
      return Gdk.EVENT_STOP;
    }

    // A combination is valid unless it is a bare letter/digit/script character
    // (or a forbidden navigation key) with no modifier beyond Shift.
    _isBindingValid({ mask, keycode, keyval }) {
      if ((mask === 0 || mask === Gdk.ModifierType.SHIFT_MASK) && keycode !== 0) {
        if (
          (keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
          (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
          (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
          (keyval >= Gdk.KEY_kana_fullstop &&
            keyval <= Gdk.KEY_semivoicedsound) ||
          (keyval >= Gdk.KEY_Arabic_comma && keyval <= Gdk.KEY_Arabic_sukun) ||
          (keyval >= Gdk.KEY_Serbian_dje &&
            keyval <= Gdk.KEY_Cyrillic_HARDSIGN) ||
          (keyval >= Gdk.KEY_Greek_ALPHAaccent &&
            keyval <= Gdk.KEY_Greek_omega) ||
          (keyval >= Gdk.KEY_hebrew_doublelowline &&
            keyval <= Gdk.KEY_hebrew_taf) ||
          (keyval >= Gdk.KEY_Thai_kokai && keyval <= Gdk.KEY_Thai_lekkao) ||
          (keyval >= Gdk.KEY_Hangul_Kiyeog &&
            keyval <= Gdk.KEY_Hangul_J_YeorinHieuh) ||
          (keyval === Gdk.KEY_space && mask === 0) ||
          this._isKeyvalForbidden(keyval)
        )
          return false;
      }
      return true;
    }

    _isKeyvalForbidden(keyval) {
      const forbiddenKeyvals = [
        Gdk.KEY_Home,
        Gdk.KEY_Left,
        Gdk.KEY_Up,
        Gdk.KEY_Right,
        Gdk.KEY_Down,
        Gdk.KEY_Page_Up,
        Gdk.KEY_Page_Down,
        Gdk.KEY_End,
        Gdk.KEY_Tab,
        Gdk.KEY_KP_Enter,
        Gdk.KEY_Return,
        Gdk.KEY_Mode_switch,
      ];
      return forbiddenKeyvals.includes(keyval);
    }
  },
);

export default class WaylandPastePrefs extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new Adw.PreferencesPage();

    this._addHistoryGroup(page, settings);
    this._addPasteGroup(page, settings);
    this._addInterfaceGroup(page, settings);

    window.add(page);
  }

  _addHistoryGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: "History",
      description: "What is recorded and how much. Mirrors Diodon's options.",
    });
    page.add(group);

    group.add(
      this._spinRow(settings, "history-size", "History size", {
        lower: 1,
        upper: 500,
        subtitle: "Number of recent entries to keep",
      }),
    );
    group.add(
      this._switchRow(settings, "use-clipboard", "Track clipboard", {
        subtitle: "Record Ctrl+C / Ctrl+X content",
      }),
    );
    group.add(
      this._switchRow(settings, "use-primary", "Track primary selection", {
        subtitle: "Record text highlighted with the mouse",
      }),
    );
    group.add(
      this._switchRow(
        settings,
        "synchronize-clipboards",
        "Synchronize clipboard and primary",
        { subtitle: "Keep both selections holding the same value" },
      ),
    );
    group.add(
      this._switchRow(
        settings,
        "keep-clipboard-content",
        "Persist history across sessions",
        { subtitle: "Save to disk and restore on next login" },
      ),
    );
    group.add(
      this._switchRow(settings, "add-images", "Store images", {
        subtitle: "Also record copied images, not only text",
      }),
    );

    const filterRow = new Adw.EntryRow({ title: "Ignore pattern (regex)" });
    settings.bind(
      "filter-pattern",
      filterRow,
      "text",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(filterRow);
  }

  _addPasteGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: "Pasting",
      description:
        "Instant paste types the paste shortcut into the previously focused " +
        "window using GNOME Shell's virtual input device, so no Remote Desktop " +
        "dialog appears.",
    });
    page.add(group);

    group.add(
      this._switchRow(settings, "instant-paste", "Paste on selection", {
        subtitle: "Type the paste shortcut after choosing an entry",
      }),
    );

    const defaultAccelRow = new Adw.EntryRow({
      title: "Default paste shortcut",
    });
    settings.bind(
      "default-paste-keybinding",
      defaultAccelRow,
      "text",
      Gio.SettingsBindFlags.DEFAULT,
    );
    group.add(defaultAccelRow);

    // Per-application paste shortcuts: one "WM_CLASS|accelerator" per line.
    // A free-form text area mirrors how the underlying strv is stored and keeps
    // the editor simple; lines are trimmed and empties dropped on save.
    const perAppGroup = new Adw.PreferencesGroup({
      title: "Per-application paste shortcuts",
      description:
        'One "WM_CLASS|accelerator" per line, e.g. "Alacritty|<Shift><Ctrl>v". ' +
        "Used when instant paste targets a matching window (terminals paste " +
        "with Shift+Ctrl+V). Find a window's WM_CLASS with Looking Glass " +
        "(Alt+F2, lg) or xprop.",
    });
    page.add(perAppGroup);

    const textView = new Gtk.TextView({
      monospace: true,
      top_margin: 6,
      bottom_margin: 6,
      left_margin: 6,
      right_margin: 6,
      wrap_mode: Gtk.WrapMode.NONE,
    });
    const buffer = textView.get_buffer();
    buffer.set_text(settings.get_strv("paste-keybindings").join("\n"), -1);

    // Save on every edit; split into lines, trim, drop empties.
    buffer.connect("changed", () => {
      const [start, end] = [buffer.get_start_iter(), buffer.get_end_iter()];
      const text = buffer.get_text(start, end, false);
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const current = settings.get_strv("paste-keybindings");
      if (JSON.stringify(current) !== JSON.stringify(lines))
        settings.set_strv("paste-keybindings", lines);
    });

    const frame = new Gtk.Frame();
    const scroll = new Gtk.ScrolledWindow({
      hscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
      min_content_height: PER_APP_EDITOR_MIN_HEIGHT,
      child: textView,
    });
    frame.set_child(scroll);
    perAppGroup.add(frame);
  }

  _addInterfaceGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: "Interface",
      description:
        "Click the shortcut row, then press the combination. Backspace clears, " +
        "Escape cancels. A plain letter needs a modifier (Super, Ctrl, Alt).",
    });
    page.add(group);

    group.add(
      this._switchRow(settings, "show-indicator", "Show panel indicator", {
        subtitle: "Clipboard icon in the top bar",
      }),
    );

    group.add(
      new ShortcutRow(settings, "toggle-menu", {
        title: "Open history shortcut",
        subtitle: "Click to set, then press a key combination",
      }),
    );

    group.add(
      this._spinRow(settings, "poll-interval-ms", "Poll interval (ms)", {
        lower: 100,
        upper: 5000,
        step: 50,
        subtitle: "How often the clipboard is checked (Wayland has no change signal)",
      }),
    );
  }

  _switchRow(settings, key, title, { subtitle } = {}) {
    const row = new Adw.SwitchRow({ title, ...(subtitle ? { subtitle } : {}) });
    settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }

  _spinRow(settings, key, title, { lower, upper, step = 1, subtitle } = {}) {
    const row = new Adw.SpinRow({
      title,
      ...(subtitle ? { subtitle } : {}),
      adjustment: new Gtk.Adjustment({
        lower,
        upper,
        step_increment: step,
        page_increment: step * 10,
      }),
    });
    settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
    return row;
  }
}
