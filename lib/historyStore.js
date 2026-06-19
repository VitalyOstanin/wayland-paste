// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GdkPixbuf from "gi://GdkPixbuf";

// Promisify the async GIO file methods so they can be awaited. Mutates the
// shared Gio.File.prototype, so other modules get the awaitable versions too.
Gio._promisify(Gio.File.prototype, "load_contents_async");
Gio._promisify(Gio.File.prototype, "replace_contents_async");
// The finish function is the shared new_from_stream_finish, not a *_at_scale_finish.
Gio._promisify(
  GdkPixbuf.Pixbuf,
  "new_from_stream_at_scale_async",
  "new_from_stream_finish",
);

const IMAGE_SAMPLE_BYTES = 32;

// Thumbnail bounds (px). 2x the 48px menu icon so it stays sharp on HiDPI; a
// downscale on a 1x display is sharp too. Aspect ratio is preserved within these.
const THUMBNAIL_MAX_WIDTH = 128;
const THUMBNAIL_MAX_HEIGHT = 96;

// History may hold sensitive clipboard contents, so the directory is owner-only
// and files are restricted to 0o600 explicitly (replace_contents would otherwise
// use the process umask).
const DATA_DIR_MODE = 0o700;
const HISTORY_FILE_MODE = 0o600;

// Accepted image mime types when loading a history.json (treated as untrusted input).
const ALLOWED_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/bmp",
  "image/tiff",
];

// HistoryStore owns the clipboard entries and their on-disk persistence, free of
// any GNOME Shell / St / Clutter dependency. Each entry is one of:
//   { id, type: "text",  text,                        ts }
//   { id, type: "image", mimetype, file, size, thumb, ts }
// The newest entry is at index 0. Image bytes live in files under
// `<dataDir>/images/`, downscaled thumbnails under `<dataDir>/thumbnails/`; the
// JSON stores only the paths. `thumb` is absent until the async thumbnail lands.
export class HistoryStore {
  constructor(dataDir) {
    this._dir = dataDir;
    this._imagesDir = GLib.build_filenamev([dataDir, "images"]);
    this._thumbsDir = GLib.build_filenamev([dataDir, "thumbnails"]);
    this._file = GLib.build_filenamev([dataDir, "history.json"]);
    this._entries = [];
    this._nextId = 1;
    // Single-slot chain that serializes async saves; see saveAsync().
    this._saveChain = Promise.resolve();
    // Set by the indicator's owner; called with an entry once its thumbnail is
    // written, so an already-shown item can swap its full-size icon for it.
    this.onThumbReady = null;
  }

  get entries() {
    return this._entries;
  }

  // Load a saved history asynchronously so enable() does not block on disk I/O.
  // _entries is cleared synchronously, so a clipboard change observed during the
  // await stays at the front and parsed older entries are appended after it.
  // _trim runs after parsing and only drops from the tail, keeping that fresh entry.
  async load(maxSize) {
    this._entries = [];
    try {
      const [bytes] = await Gio.File.new_for_path(
        this._file,
      ).load_contents_async(null);
      this._parse(bytes);
    } catch (err) {
      // A missing file is the normal "no history yet" case; any other error is a
      // real failure that would otherwise silently discard saved history.
      if (!err.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
        logError(err, "[wayland-paste] failed to load history.json");
    }
    if (Number.isInteger(maxSize)) this._trim(maxSize);
  }

  // A corrupt payload yields an empty history. Entries are deduplicated against
  // fresh ones recorded during the load window (see load()) and within the file
  // itself; the file is newest-first, so the first occurrence wins and later
  // equals are skipped.
  _parse(bytes) {
    try {
      const text = new TextDecoder().decode(bytes);
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const seen = new Set(this._entries.map((e) => this._dedupKey(e)));
      for (const e of list) {
        if (e?.type === "text" && typeof e.text === "string") {
          const key = this._dedupKey({ type: "text", text: e.text });
          if (seen.has(key)) continue;
          seen.add(key);
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
          const entry = {
            id: this._nextId++,
            type: "image",
            mimetype: e.mimetype,
            file: e.file,
            size: e.size ?? 0,
            // Restore the dedup fingerprint so the same image is recognised after a restart.
            _sample: typeof e.sample === "string" ? e.sample : undefined,
            ts: e.ts ?? 0,
          };
          if (
            this._isManagedThumbPath(e.thumb) &&
            GLib.file_test(e.thumb, GLib.FileTest.EXISTS)
          )
            entry.thumb = e.thumb;
          const key = this._dedupKey(entry);
          if (seen.has(key)) {
            // Duplicate already kept; delete this orphaned backing file, but only
            // if no kept entry references the same path.
            if (!this._entries.some((k) => k.type === "image" && k.file === entry.file))
              this._deleteBacking(entry);
            continue;
          }
          seen.add(key);
          this._entries.push(entry);
        }
      }
    } catch (err) {
      logError(err, "[wayland-paste] failed to parse history.json");
      this._entries = [];
    }
  }

  // Stable dedup key. The "t:"/"i:" prefixes keep text and image key spaces disjoint.
  _dedupKey(entry) {
    return entry.type === "text"
      ? `t:${entry.text}`
      : `i:${entry.mimetype}:${entry.size}:${entry._sample}`;
  }

  // The image `sample` fingerprint is persisted so dedup keeps working after a restart.
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
              thumb: e.thumb,
              ts: e.ts,
            },
      ),
    });
    return new TextEncoder().encode(payload);
  }

  // Synchronous atomic write, used on disable() where an in-flight async write
  // might not complete. For live-session saves prefer saveAsync().
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

  // Async variant for live-session saves. Writes are funneled through a
  // single-slot chain so overlapping saves do not run concurrent
  // replace_contents_async on the same file, where the last to finish (main-loop
  // order, not call order) would clobber the other. Each link serializes a fresh
  // snapshot; _doSaveAsync never rejects, so a failed write does not break the chain.
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

  addText(text, maxSize) {
    const key = this._dedupKey({ type: "text", text });
    const existing = this._entries.findIndex((e) => this._dedupKey(e) === key);
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

  // Deduplicated by (mimetype, byte length, leading-byte sample); a match is
  // promoted instead of stored again.
  addImage(data, mimetype, maxSize) {
    const size = data.length;
    const sample = this._sample(data);
    const key = this._dedupKey({ type: "image", mimetype, size, _sample: sample });
    const existing = this._entries.findIndex((e) => this._dedupKey(e) === key);
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

    // Write asynchronously; the entry is returned synchronously. Both helpers
    // catch their own errors, so the unawaited promises never reject.
    this._writeImageFile(path, data, entry);
    this._writeThumbnail(data, entry);
    return entry;
  }

  // Decode and downscale the image off the main loop, then save it as a PNG and
  // record its path on the entry. On failure the entry keeps no `thumb` and the
  // menu falls back to the full-size file.
  async _writeThumbnail(data, entry) {
    const path = GLib.build_filenamev([
      this._thumbsDir,
      `thumb-${GLib.get_real_time()}-${entry.id}.png`,
    ]);
    try {
      GLib.mkdir_with_parents(this._thumbsDir, DATA_DIR_MODE);
      const stream = Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(data));
      const pixbuf = await GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(
        stream,
        THUMBNAIL_MAX_WIDTH,
        THUMBNAIL_MAX_HEIGHT,
        true,
        null,
      );
      // The await yielded; the entry may have been evicted or cleared meanwhile.
      if (!this._entries.includes(entry)) {
        GLib.unlink(path);
        return;
      }
      pixbuf.savev(path, "png", [], []);
      this._restrictMode(path);
      entry.thumb = path;
      this.onThumbReady?.(entry);
    } catch (err) {
      logError(err, "[wayland-paste] failed to write thumbnail");
      GLib.unlink(path);
    }
  }

  // The entry was added optimistically by addImage(); if the write fails it is dropped.
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
      // The entry may have left the history before this resolved (its
      // _deleteBacking then ran before the file existed); delete any partial file now.
      this._deleteBacking(entry);
    }
  }

  clear() {
    for (const entry of this._entries) this._deleteBacking(entry);
    this._entries = [];
  }

  // Drop entries beyond the configured size, deleting any backing image files.
  _trim(maxSize) {
    const max = Math.max(1, maxSize | 0);
    while (this._entries.length > max) {
      const entry = this._entries.pop();
      this._deleteBacking(entry);
    }
  }

  // Accept only paths inside our images directory, with no parent-dir escape, so
  // a tampered history.json cannot point read()/delete() at an arbitrary file.
  _isManagedImagePath(p) {
    if (typeof p !== "string" || p.length === 0) return false;
    if (p.includes("..")) return false;
    return p.startsWith(`${this._imagesDir}/`);
  }

  _isManagedThumbPath(p) {
    if (typeof p !== "string" || p.length === 0) return false;
    if (p.includes("..")) return false;
    return p.startsWith(`${this._thumbsDir}/`);
  }

  _deleteBacking(entry) {
    if (entry?.type !== "image") return;
    for (const path of [entry.file, entry.thumb]) {
      if (!path) continue;
      try {
        Gio.File.new_for_path(path).delete(null);
      } catch {
        // The file may already be gone; ignore.
      }
    }
  }

  // Restrict a just-written file to owner-only: replace_contents creates files
  // with the process umask, so set the mode explicitly for sensitive contents.
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

  // Short fingerprint of image bytes for cheap dedup without keeping the whole buffer.
  _sample(data) {
    const n = Math.min(IMAGE_SAMPLE_BYTES, data.length);
    let s = "";
    for (let i = 0; i < n; i++) s += data[i].toString(16).padStart(2, "0");
    return s;
  }
}
