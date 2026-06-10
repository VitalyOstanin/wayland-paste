// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";
import St from "gi://St";

// Preferred image mime types, in the order we try to read them.
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/bmp", "image/tiff"];

// ClipboardMonitor polls the clipboard, because Wayland gives extensions no
// change signal. On each tick it reads CLIPBOARD and/or PRIMARY (per settings),
// detects changes against the last seen value, applies the ignore filter, and
// pushes new content into the HistoryStore. It also optionally keeps the two
// selections in sync.
//
// To avoid recording our own writes (when an entry is pasted we set the
// clipboard ourselves), callers use markSeen() so the next poll treats that
// value as already known.
export class ClipboardMonitor {
  constructor(settings, store, onChanged) {
    this._settings = settings;
    this._store = store;
    this._onChanged = onChanged; // called after the history changes
    this._clipboard = St.Clipboard.get_default();
    this._timerId = 0;
    this._filterRe = null;
    this._running = false;
    this._pendingSeeds = 0;
    this._mimeErrorLogged = false;
    // Last seen text per selection, to detect changes.
    this._lastText = { clipboard: null, primary: null };
    this._lastImageSig = { clipboard: null, primary: null };
    this._compileFilter();
  }

  start() {
    this.stop();
    this._running = true;
    // Seed last-seen with the current clipboard so existing content is not
    // re-recorded as "new" on the first tick. The poll timer is started only
    // after both seed callbacks complete (see _startTimer), so the first tick
    // cannot run before _lastText is populated.
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
      Math.max(100, interval),
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

  // Restart the timer to pick up a changed poll interval.
  restart() {
    if (this._timerId) this.start();
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

  // Re-read the ignore pattern after a settings change.
  refreshFilter() {
    this._compileFilter();
  }

  // Tell the monitor that this text is now the clipboard's content so it is not
  // re-recorded (used after we set the clipboard ourselves on paste).
  markSeen(type, text) {
    const slot = type === St.ClipboardType.PRIMARY ? "primary" : "clipboard";
    this._lastText[slot] = text;
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
      // This callback runs from the GLib main loop with no error parameter and
      // no outer try/catch; an unhandled throw would escape into the loop. Wrap
      // the body so a failure is logged instead.
      try {
        if (text && text.length > 0) {
          if (text === this._lastText[slot]) return;
          this._lastText[slot] = text;
          this._lastImageSig[slot] = null;
          if (this._filterRe && this._filterRe.test(text)) return;
          this._store.addText(text, this._settings.get_int("history-size"));
          this._maybeSynchronize(type, text);
          this._onChanged?.();
          return;
        }
        // No text. Try an image if enabled.
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
      this._mimeErrorLogged = false; // reset on a successful read
    } catch (err) {
      // Runs on every tick when there is no text; log once (deduplicated) so a
      // persistent failure is not silently swallowed but also does not flood the
      // journal.
      if (!this._mimeErrorLogged) {
        logError(err, "[wayland-paste] failed to read clipboard mimetypes");
        this._mimeErrorLogged = true;
      }
      return;
    }
    const mime = IMAGE_MIMES.find((m) => mimetypes.includes(m));
    if (!mime) return;

    this._clipboard.get_content(type, mime, (_cl, bytes) => {
      // Main-loop callback with no error parameter; wrap the body (see
      // _pollSelection) so a throw is logged rather than escaping the loop.
      try {
        if (!bytes) return;
        const data = bytes.get_data?.();
        if (!data || data.length === 0) return;

        const sig = `${mime}:${data.length}`;
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
    // Record so the mirrored write is not re-added on the next tick. Also clear
    // the other selection's image signature: it now holds text, so a later copy
    // of the previously seen image there must not be treated as already seen.
    this.markSeen(otherType, text);
    this._lastImageSig[otherSlot] = null;
  }
}
