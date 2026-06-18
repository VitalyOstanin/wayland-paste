// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";
import St from "gi://St";

// Preferred image mime types, in the order we try to read them.
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/bmp", "image/tiff"];

// Lower bound on the poll interval (ms). Mirrored by the prefs spin row and the
// gschema range.
const MIN_POLL_INTERVAL_MS = 100;

// Cap on text run through the user ignore-pattern regex per poll, to bound
// worst-case backtracking (GJS offers no regex execution timeout, so a
// pathological pattern on a huge clipboard could otherwise stall the main loop).
const FILTER_MAX_TEST_LEN = 10000;

// Leading image bytes folded into the change-detection signature. Matches the
// HistoryStore dedup granularity so a distinct image sharing mime type and byte
// length with the previous one is not masked.
const IMAGE_SIG_SAMPLE_BYTES = 32;

// ClipboardMonitor polls the clipboard, because Wayland gives extensions no
// change signal. Callers use markSeen() after writing the clipboard themselves
// so the next poll treats that value as already known and does not re-record it.
export class ClipboardMonitor {
  constructor(settings, store, onChanged) {
    this._settings = settings;
    this._store = store;
    this._onChanged = onChanged;
    this._clipboard = St.Clipboard.get_default();
    this._timerId = 0;
    this._filterRe = null;
    this._running = false;
    this._pendingSeeds = 0;
    this._mimeErrorLogged = false;
    this._lastText = { clipboard: null, primary: null };
    this._lastImageSig = { clipboard: null, primary: null };
    this._compileFilter();
  }

  start() {
    this.stop();
    this._running = true;
    // Seed last-seen with current content so it is not re-recorded as "new" on
    // the first tick. The timer is started only after both seeds complete (see
    // _startTimer), so the first tick cannot run before _lastText is populated.
    this._pendingSeeds = 2;
    this._seed(St.ClipboardType.CLIPBOARD, "clipboard");
    this._seed(St.ClipboardType.PRIMARY, "primary");
  }

  // Start the poll timer once seeding is done. Guarded by _running so a seed
  // callback that fires after stop()/disable() does not resurrect the timer.
  _startTimer() {
    if (!this._running || this._timerId) return;
    const interval = this._settings.get_int("poll-interval-ms");
    this._timerId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      Math.max(MIN_POLL_INTERVAL_MS, interval),
      () => {
        this._poll();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  stop() {
    this._running = false;
    if (this._timerId) {
      GLib.source_remove(this._timerId);
      this._timerId = 0;
    }
  }

  // Restart the timer to pick up a changed poll interval. Guard on _running, not
  // _timerId: during the seeding window (between start() and the timer being
  // armed) _timerId is still 0, and a missed restart would drop the new interval.
  restart() {
    if (this._running) this.start();
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

  // Record text we just put on the clipboard so the next poll does not re-record it.
  markSeen(type, text) {
    const slot = type === St.ClipboardType.PRIMARY ? "primary" : "clipboard";
    this._lastText[slot] = text;
    this._lastImageSig[slot] = null;
  }

  // markSeen for an image; `data` is the raw byte array (Uint8Array).
  markSeenImage(type, mime, data) {
    const slot = type === St.ClipboardType.PRIMARY ? "primary" : "clipboard";
    this._lastImageSig[slot] = this._imageSig(mime, data);
    this._lastText[slot] = null;
  }

  // Change-detection signature: mime, byte length and a hex sample of the leading bytes.
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
      } finally {
        this._pendingSeeds--;
        if (this._pendingSeeds <= 0) this._startTimer();
      }
    });
  }

  _poll() {
    if (this._settings.get_boolean("use-clipboard"))
      this._pollSelection(St.ClipboardType.CLIPBOARD, "clipboard");
    if (this._settings.get_boolean("use-primary"))
      this._pollSelection(St.ClipboardType.PRIMARY, "primary");
  }

  _pollSelection(type, slot) {
    this._clipboard.get_text(type, (_cl, text) => {
      // Main-loop callback: wrap the body so a throw is logged, not escaped into the loop.
      try {
        if (text && text.length > 0) {
          if (text === this._lastText[slot]) return;
          this._lastText[slot] = text;
          this._lastImageSig[slot] = null;
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
          this._pollImage(type, slot);
      } catch (err) {
        logError(err, "[wayland-paste] clipboard text poll callback failed");
      }
    });
  }

  _pollImage(type, slot) {
    let mimetypes = [];
    try {
      mimetypes = this._clipboard.get_mimetypes(type) ?? [];
      this._mimeErrorLogged = false;
    } catch (err) {
      // Runs every tick when there is no text; log once so a persistent failure
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
        logError(err, "[wayland-paste] clipboard image poll callback failed");
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
    // Record so the mirrored write is not re-added next tick, and clear the
    // other slot's image signature since it now holds text.
    this.markSeen(otherType, text);
    this._lastImageSig[otherSlot] = null;
  }
}
