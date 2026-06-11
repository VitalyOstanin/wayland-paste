// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";
import Gio from "gi://Gio";

// Promisify the async GIO file methods used across the extension so they can be
// awaited. This mutates the shared Gio.File.prototype; since this module is
// imported before the rest of the extension runs, awaiting these methods works
// in other modules too (e.g. extension.js loading an image onto the clipboard).
Gio._promisify(Gio.File.prototype, "load_contents_async");
Gio._promisify(Gio.File.prototype, "replace_contents_async");

// Number of leading image bytes hashed into the dedup fingerprint (_sample).
const IMAGE_SAMPLE_BYTES = 32;

// Permissions for the data directory and the persisted files. The history may
// hold sensitive clipboard contents (passwords etc.), so the directory is
// owner-only and the files are restricted to 0o600 explicitly (replace_contents
// has no mode parameter and would otherwise create them with the process umask).
const DATA_DIR_MODE = 0o700;
const HISTORY_FILE_MODE = 0o600;

// Image mime types accepted when loading a persisted history. A tampered or
// stale history.json is treated as untrusted input.
const ALLOWED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/bmp",
  "image/tiff",
];

// HistoryStore owns the list of clipboard entries and their on-disk
// persistence. It is intentionally free of any GNOME Shell / St / Clutter
// dependency so the history logic can be reasoned about on its own.
//
// Each entry is one of:
//   { id, type: "text",  text,                 ts }
//   { id, type: "image", mimetype, file, size, ts }
//
// The newest entry is at index 0. Image bytes are written to files under
// `<dataDir>/images/`; the JSON only stores the path, so the history file stays
// small. clear()/trim remove the backing files for dropped image entries.
export class HistoryStore {
  constructor(dataDir) {
    this._dir = dataDir;
    this._imagesDir = GLib.build_filenamev([dataDir, "images"]);
    this._file = GLib.build_filenamev([dataDir, "history.json"]);
    this._entries = [];
    this._nextId = 1;
    // Single-slot chain that serializes async saves: see saveAsync().
    this._saveChain = Promise.resolve();
  }

  get entries() {
    return this._entries;
  }

  // --- persistence ---------------------------------------------------------

  // Load a previously saved history asynchronously, so the GNOME Shell main
  // loop is not blocked on disk I/O at enable(). Missing or unreadable files
  // yield an empty history rather than throwing, so a corrupt file never blocks
  // startup. Returns a Promise that resolves once loading finishes (the caller
  // refreshes the menu then). this._entries is cleared synchronously here, so a
  // clipboard change observed before the load resolves is preserved: the parsed
  // older entries are appended after it.
  //
  // maxSize bounds the loaded history: a file saved with a larger history-size,
  // or hand-edited, must not exceed the current limit. _trim runs after parsing
  // and only ever drops from the tail, so a fresh entry recorded during the
  // await stays at the front.
  async load(maxSize) {
    this._entries = [];
    try {
      const [bytes] = await Gio.File.new_for_path(
        this._file,
      ).load_contents_async(null);
      this._parse(bytes);
    } catch (err) {
      // A missing file is the normal "no history yet" case: keep the empty
      // history silently. Any other error (permissions, I/O, out of memory) is
      // a real failure that would otherwise silently discard saved history, so
      // surface it. (не проверено в runtime: точный класс GIO-ошибки и наличие
      // err.matches под текущей версией GJS подтверждается только прогоном.)
      if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
        logError(err, "[wayland-paste] failed to load history.json");
    }
    if (Number.isInteger(maxSize)) this._trim(maxSize);
  }

  // Parse the serialized history payload into this._entries. A corrupt payload
  // yields an empty history rather than throwing.
  _parse(bytes) {
    try {
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
      for (const e of list) {
        if (e?.type === "text" && typeof e.text === "string") {
          this._entries.push({
            id: this._nextId++,
            type: "text",
            text: e.text,
            ts: e.ts ?? 0,
          });
        } else if (
          e?.type === "image" &&
          this._isManagedImagePath(e.file) &&
          ALLOWED_IMAGE_MIMES.includes(e.mimetype) &&
          GLib.file_test(e.file, GLib.FileTest.EXISTS)
        ) {
          this._entries.push({
            id: this._nextId++,
            type: "image",
            mimetype: e.mimetype,
            file: e.file,
            size: e.size ?? 0,
            // Restore the dedup fingerprint so a copy of the same image after a
            // restart is recognised as a duplicate instead of stored again.
            _sample: typeof e.sample === "string" ? e.sample : undefined,
            ts: e.ts ?? 0,
          });
        }
      }
    } catch (err) {
      logError(err, "[wayland-paste] failed to parse history.json");
      this._entries = [];
    }
  }

  // Serialize the current history to the on-disk JSON payload (bytes). The image
  // `sample` fingerprint is persisted so dedup keeps working after a restart.
  _serialize() {
    const payload = JSON.stringify({
      version: 1,
      entries: this._entries.map((e) =>
        e.type === "text"
          ? { type: "text", text: e.text, ts: e.ts }
          : {
              type: "image",
              mimetype: e.mimetype,
              file: e.file,
              size: e.size,
              sample: e._sample,
              ts: e.ts,
            },
      ),
    });
    return new TextEncoder().encode(payload);
  }

  // Write the current history to disk atomically (replace, not append).
  // Synchronous: used on disable(), where the shell is already tearing down and
  // an in-flight async write might not complete. For user-triggered saves in a
  // live session prefer saveAsync().
  save() {
    try {
      GLib.mkdir_with_parents(this._dir, DATA_DIR_MODE);
      const file = Gio.File.new_for_path(this._file);
      file.replace_contents(
        this._serialize(),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
      );
      this._restrictMode(this._file);
    } catch (err) {
      logError(err, "[wayland-paste] failed to save history.json");
    }
  }

  // Asynchronous variant for live-session saves (e.g. clearing history), so the
  // GNOME Shell main loop is not blocked on disk I/O.
  //
  // Writes are funneled through a single-slot chain (this._saveChain): two
  // overlapping saves must not run concurrent replace_contents_async on the same
  // file, because their completion order is decided by the main loop, not the
  // call order, and the last to finish would clobber the other. Each link
  // serializes a fresh snapshot when it runs, so the final on-disk state matches
  // the latest history even after a burst of saves. _doSaveAsync never rejects
  // (it logs its own errors), so a failed write does not break the chain.
  saveAsync() {
    this._saveChain = this._saveChain.then(() => this._doSaveAsync());
    return this._saveChain;
  }

  async _doSaveAsync() {
    let bytes;
    try {
      GLib.mkdir_with_parents(this._dir, DATA_DIR_MODE);
      bytes = this._serialize();
    } catch (err) {
      logError(err, "[wayland-paste] failed to prepare history.json");
      return;
    }
    try {
      await Gio.File.new_for_path(this._file).replace_contents_async(
        bytes,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
      );
      this._restrictMode(this._file);
    } catch (err) {
      logError(err, "[wayland-paste] failed to save history.json (async)");
    }
  }

  // --- mutation ------------------------------------------------------------

  // Add or promote a text entry. If the same text already exists it is moved to
  // the front (no duplicate). Returns the entry.
  addText(text, maxSize) {
    const existing = this._entries.findIndex(
      (e) => e.type === "text" && e.text === text,
    );
    if (existing >= 0) {
      const [entry] = this._entries.splice(existing, 1);
      entry.ts = GLib.get_real_time();
      this._entries.unshift(entry);
      this._trim(maxSize);
      return entry;
    }
    const entry = {
      id: this._nextId++,
      type: "text",
      text,
      ts: GLib.get_real_time(),
    };
    this._entries.unshift(entry);
    this._trim(maxSize);
    return entry;
  }

  // Add an image entry from raw bytes (a GLib.Bytes-like object exposing
  // get_data()). Deduplicated by (mimetype, byte length, leading-byte sample);
  // an exact-enough match is promoted instead of stored again.
  addImage(data, mimetype, maxSize) {
    const size = data.length;
    const sample = this._sample(data);
    const existing = this._entries.findIndex(
      (e) =>
        e.type === "image" &&
        e.mimetype === mimetype &&
        e.size === size &&
        e._sample === sample,
    );
    if (existing >= 0) {
      const [entry] = this._entries.splice(existing, 1);
      entry.ts = GLib.get_real_time();
      this._entries.unshift(entry);
      this._trim(maxSize);
      return entry;
    }

    try {
      GLib.mkdir_with_parents(this._imagesDir, DATA_DIR_MODE);
    } catch (err) {
      logError(err, "[wayland-paste] failed to create images dir");
      return null;
    }
    const ext = mimetype.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
    const name = `img-${GLib.get_real_time()}-${this._nextId}.${ext}`;
    const path = GLib.build_filenamev([this._imagesDir, name]);

    const entry = {
      id: this._nextId++,
      type: "image",
      mimetype,
      file: path,
      size,
      _sample: sample,
      ts: GLib.get_real_time(),
    };
    this._entries.unshift(entry);
    this._trim(maxSize);

    // Write the bytes asynchronously so the Shell main loop is not blocked on
    // disk I/O. addImage returns the entry synchronously; the write runs in the
    // background. _writeImageFile catches its own errors, so the unawaited
    // promise never rejects.
    this._writeImageFile(path, data, entry);
    return entry;
  }

  // Write an image entry's bytes to its backing file. The entry was added
  // optimistically by addImage(); if the write fails it is dropped, since its
  // backing file would not exist.
  async _writeImageFile(path, data, entry) {
    try {
      await Gio.File.new_for_path(path).replace_contents_async(
        data,
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null,
      );
      this._restrictMode(path);
    } catch (err) {
      logError(err, "[wayland-paste] failed to write image entry");
      const i = this._entries.indexOf(entry);
      if (i >= 0) this._entries.splice(i, 1);
      // The entry may have already left the history (via _trim/clear) before
      // this write resolved, in which case that path's _deleteBacking ran
      // before the file existed. Delete any partially written file by its path
      // so it is not orphaned on disk.
      this._deleteBacking(entry);
    }
  }

  clear() {
    for (const entry of this._entries) this._deleteBacking(entry);
    this._entries = [];
  }

  // --- helpers -------------------------------------------------------------

  // Drop entries beyond the configured size, deleting any backing image files.
  _trim(maxSize) {
    const max = Math.max(1, maxSize | 0);
    while (this._entries.length > max) {
      const entry = this._entries.pop();
      this._deleteBacking(entry);
    }
  }

  // Accept only image paths inside our own images directory, with no parent-dir
  // escape, so a tampered history.json cannot point read()/delete() at an
  // arbitrary file.
  _isManagedImagePath(p) {
    if (typeof p !== "string" || p.length === 0) return false;
    if (p.includes("..")) return false;
    return p.startsWith(`${this._imagesDir}/`);
  }

  _deleteBacking(entry) {
    if (entry?.type !== "image" || !entry.file) return;
    try {
      Gio.File.new_for_path(entry.file).delete(null);
    } catch {
      // The file may already be gone; ignore.
    }
  }

  // Restrict a just-written file to owner-only (HISTORY_FILE_MODE). The data dir
  // is already DATA_DIR_MODE, but replace_contents creates files with the
  // process umask, so set the mode explicitly as defence in depth for the
  // potentially sensitive clipboard contents.
  _restrictMode(path) {
    try {
      Gio.File.new_for_path(path).set_attribute_uint32(
        "unix::mode",
        HISTORY_FILE_MODE,
        Gio.FileQueryInfoFlags.NONE,
        null,
      );
    } catch (err) {
      logError(err, "[wayland-paste] failed to restrict history file mode");
    }
  }

  // A short fingerprint of image bytes for cheap deduplication without keeping
  // the whole buffer in memory.
  _sample(data) {
    const n = Math.min(IMAGE_SAMPLE_BYTES, data.length);
    let s = "";
    for (let i = 0; i < n; i++) s += data[i].toString(16).padStart(2, "0");
    return s;
  }
}
