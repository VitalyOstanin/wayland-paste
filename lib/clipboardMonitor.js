// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import St from "gi://St";

// Preferred image mime types, in the order we try to read them.
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/bmp", "image/tiff"];

// Cap on text run through the user ignore-pattern regex per change, to bound
// worst-case backtracking (GJS offers no regex execution timeout, so a
// pathological pattern on a huge clipboard could otherwise stall the main loop).
const FILTER_MAX_TEST_LEN = 10000;

// Leading image bytes folded into the change-detection signature. Matches the
// HistoryStore dedup granularity so a distinct image sharing mime type and byte
// length with the previous one is not masked.
const IMAGE_SIG_SAMPLE_BYTES = 32;

// While a mouse or Shift selection is in progress, how often to check whether it
// has ended.
const SELECTION_SETTLE_CHECK_MS = 100;
const SELECTING_MASK =
  Clutter.ModifierType.BUTTON1_MASK | Clutter.ModifierType.SHIFT_MASK;

// ClipboardMonitor reads the clipboard when Mutter's MetaSelection reports a new
// owner, which happens on every copy (Wayland and Xwayland alike). Callers use
// markSeen() after writing the clipboard themselves so the read triggered by
// that write treats the value as already known and does not re-record it.
export class ClipboardMonitor {
  constructor(settings, store, onChanged) {
    this._settings = settings;
    this._store = store;
    this._onChanged = onChanged;
    this._clipboard = St.Clipboard.get_default();
    this._filterRe = null;
    this._running = false;
    this._mimeErrorLogged = false;
    this._lastText = { clipboard: null, primary: null };
    this._lastImageSig = { clipboard: null, primary: null };
    this._selection = null;
    this._ownerChangedId = 0;
    this._primarySettleId = 0;
    this._compileFilter();
  }

  start() {
    this.stop();
    this._running = true;
    // Seed last-seen with current content so it is not recorded as "new" by
    // the first owner change.
    this._seed(St.ClipboardType.CLIPBOARD, "clipboard");
    this._seed(St.ClipboardType.PRIMARY, "primary");

    this._selection = global.display.get_selection();
    this._ownerChangedId = this._selection.connect(
      "owner-changed",
      (_selection, selectionType) => this._onOwnerChanged(selectionType),
    );
  }

  stop() {
    this._running = false;
    if (this._selection && this._ownerChangedId) {
      this._selection.disconnect(this._ownerChangedId);
      this._ownerChangedId = 0;
      this._selection = null;
    }
    if (this._primarySettleId) {
      GLib.source_remove(this._primarySettleId);
      this._primarySettleId = 0;
    }
  }

  // DND owner changes are ignored: drag-and-drop does not touch either slot.
  _onOwnerChanged(selectionType) {
    if (!this._running) return;
    if (
      selectionType === Meta.SelectionType.SELECTION_CLIPBOARD &&
      this._settings.get_boolean("use-clipboard")
    )
      this._readSelection(St.ClipboardType.CLIPBOARD, "clipboard");
    else if (
      selectionType === Meta.SelectionType.SELECTION_PRIMARY &&
      this._settings.get_boolean("use-primary")
    )
      this._readPrimaryWhenSettled();
  }

  // A mouse or Shift selection replaces PRIMARY on every pointer step, so read
  // it once the button and Shift are released, as Diodon does; otherwise every
  // intermediate selection becomes a history entry.
  _readPrimaryWhenSettled() {
    if (this._primarySettleId) return;
    if (!this._isSelecting()) {
      this._readSelection(St.ClipboardType.PRIMARY, "primary");
      return;
    }
    this._primarySettleId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      SELECTION_SETTLE_CHECK_MS,
      () => {
        if (this._isSelecting()) return GLib.SOURCE_CONTINUE;
        this._primarySettleId = 0;
        if (this._settings.get_boolean("use-primary"))
          this._readSelection(St.ClipboardType.PRIMARY, "primary");
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  _isSelecting() {
    const [, , mods] = global.get_pointer();
    return (mods & SELECTING_MASK) !== 0;
  }

  _compileFilter() {
    const pattern = this._settings.get_string("filter-pattern");
    if (!pattern) {
      this._filterRe = null;
      return;
    }
    try {
      this._filterRe = new RegExp(pattern);
    } catch (err) {
      logError(err, `[wayland-paste] invalid filter-pattern: ${pattern}`);
      this._filterRe = null;
    }
  }

  refreshFilter() {
    this._compileFilter();
  }

  // Record text we just put on the clipboard so the next read does not re-record it.
  markSeen(type, text) {
    const slot = type === St.ClipboardType.PRIMARY ? "primary" : "clipboard";
    this._lastText[slot] = text;
    this._lastImageSig[slot] = null;
  }

  markSeenImage(type, mime, data) {
    const slot = type === St.ClipboardType.PRIMARY ? "primary" : "clipboard";
    this._lastImageSig[slot] = this._imageSig(mime, data);
    this._lastText[slot] = null;
  }

  _imageSig(mime, data) {
    const n = Math.min(IMAGE_SIG_SAMPLE_BYTES, data.length);
    let sample = "";
    for (let i = 0; i < n; i++) sample += data[i].toString(16).padStart(2, "0");
    return `${mime}:${data.length}:${sample}`;
  }

  _seed(type, slot) {
    this._clipboard.get_text(type, (_cl, text) => {
      try {
        this._lastText[slot] = text ?? null;
      } catch (err) {
        logError(err, "[wayland-paste] clipboard seed callback failed");
      }
    });
  }

  _readSelection(type, slot) {
    this._clipboard.get_text(type, (_cl, text) => {
      // Main-loop callback: wrap the body so a throw is logged, not escaped into the loop.
      try {
        if (text && text.length > 0) {
          if (text === this._lastText[slot]) return;
          this._lastText[slot] = text;
          this._lastImageSig[slot] = null;
          if (text.length > this._settings.get_int("max-text-length")) return;
          if (
            this._filterRe &&
            this._filterRe.test(text.slice(0, FILTER_MAX_TEST_LEN))
          )
            return;
          this._store.addText(text, this._settings.get_int("history-size"));
          this._maybeSynchronize(type, text);
          this._onChanged?.();
          return;
        }
        if (this._settings.get_boolean("add-images"))
          this._readImage(type, slot);
      } catch (err) {
        logError(err, "[wayland-paste] clipboard text read callback failed");
      }
    });
  }

  _readImage(type, slot) {
    let mimetypes = [];
    try {
      mimetypes = this._clipboard.get_mimetypes(type) ?? [];
      this._mimeErrorLogged = false;
    } catch (err) {
      // Runs on every change without text; log once so a persistent failure
      // is surfaced without flooding the journal.
      if (!this._mimeErrorLogged) {
        logError(err, "[wayland-paste] failed to read clipboard mimetypes");
        this._mimeErrorLogged = true;
      }
      return;
    }
    const mime = IMAGE_MIMES.find((m) => mimetypes.includes(m));
    if (!mime) return;

    this._clipboard.get_content(type, mime, (_cl, bytes) => {
      // Main-loop callback: wrap the body so a throw is logged, not escaped.
      try {
        if (!bytes) return;
        const data = bytes.get_data?.();
        if (!data || data.length === 0) return;

        const sig = this._imageSig(mime, data);
        if (sig === this._lastImageSig[slot]) return;
        this._lastImageSig[slot] = sig;
        this._lastText[slot] = null;

        this._store.addImage(data, mime, this._settings.get_int("history-size"));
        this._onChanged?.();
      } catch (err) {
        logError(err, "[wayland-paste] clipboard image read callback failed");
      }
    });
  }

  _maybeSynchronize(sourceType, text) {
    if (!this._settings.get_boolean("synchronize-clipboards")) return;
    const isClipboard = sourceType === St.ClipboardType.CLIPBOARD;
    const otherType = isClipboard
      ? St.ClipboardType.PRIMARY
      : St.ClipboardType.CLIPBOARD;
    const otherSlot = isClipboard ? "primary" : "clipboard";
    this._clipboard.set_text(otherType, text);
    // Record so the mirrored write is not re-added by its own owner change, and
    // clear the other slot's image signature since it now holds text.
    this.markSeen(otherType, text);
    this._lastImageSig[otherSlot] = null;
  }
}
