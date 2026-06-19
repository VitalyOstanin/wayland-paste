// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit test for HistoryStore image thumbnails. Run: gjs -m tests/thumbnail.test.js
// (or ./tests/run.sh). Unlike historyStore.test.js this exercises the disk path:
// addImage() writes a backing file and an async downscaled thumbnail, so the test
// works in a throwaway temp dir and removes it at the end.

import GLib from "gi://GLib";
import Gio from "gi://Gio";
import GdkPixbuf from "gi://GdkPixbuf";

import { HistoryStore } from "../lib/historyStore.js";

let failures = 0;
let total = 0;

function check(name, cond, extra) {
  total++;
  const mark = cond ? "OK" : "FAIL";
  if (!cond) failures++;
  print(`[${mark}] ${name}${extra ? "  -> " + extra : ""}`);
}

const tmp = GLib.dir_make_tmp("wp-thumb-test-XXXXXX");
const loop = new GLib.MainLoop(null, false);

(async () => {
  try {
    // A 600x300 (2:1) PNG in memory, so the thumbnail must come out 128x64.
    const src = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, false, 8, 600, 300);
    src.fill(0x3366ccff);
    const [, pngBuf] = src.save_to_bufferv("png", [], []);

    const store = new HistoryStore(tmp);
    let readyEntry = null;
    const ready = new Promise((res) => {
      store.onThumbReady = (e) => {
        readyEntry = e;
        res();
      };
    });

    const entry = store.addImage(pngBuf, "image/png", 25);
    check("entry is image", entry.type === "image");
    check("thumb absent before it is written", entry.thumb === undefined);

    await ready;
    check("onThumbReady fired with the same entry", readyEntry === entry);
    check("entry.thumb set", typeof entry.thumb === "string");
    check("thumb stored under thumbnails/", entry.thumb.includes("/thumbnails/"));
    check("thumb file exists", GLib.file_test(entry.thumb, GLib.FileTest.EXISTS));

    const thumbSize = Gio.File.new_for_path(entry.thumb)
      .query_info("standard::size", 0, null)
      .get_size();
    check("thumb smaller than original", thumbSize < pngBuf.length, `${thumbSize} < ${pngBuf.length}`);

    const tpb = GdkPixbuf.Pixbuf.new_from_file(entry.thumb);
    check(
      "thumb downscaled to 128x64 (aspect preserved)",
      tpb.get_width() === 128 && tpb.get_height() === 64,
      `${tpb.get_width()}x${tpb.get_height()}`,
    );

    const mode =
      Gio.File.new_for_path(entry.thumb)
        .query_info("unix::mode", 0, null)
        .get_attribute_uint32("unix::mode") & 0o777;
    check("thumb is owner-only (0600)", mode === 0o600, "0" + mode.toString(8));

    // Persist and reload: the thumb path survives a restart.
    store.save();
    const reloaded = new HistoryStore(tmp);
    await reloaded.load(25);
    const e2 = reloaded.entries.find((x) => x.type === "image");
    check("reloaded entry keeps thumb", !!e2 && e2.thumb === entry.thumb);

    // clear() removes both the backing image and the thumbnail.
    const imgPath = entry.file;
    const thumbPath = entry.thumb;
    store.clear();
    check("image file removed on clear", !GLib.file_test(imgPath, GLib.FileTest.EXISTS));
    check("thumb file removed on clear", !GLib.file_test(thumbPath, GLib.FileTest.EXISTS));
  } catch (err) {
    failures++;
    total++;
    print(`[FAIL] exception  -> ${err}\n${err.stack ?? ""}`);
  } finally {
    GLib.spawn_command_line_sync(`rm -rf ${GLib.shell_quote(tmp)}`);
    print(`\n${total - failures}/${total} passed`);
    print(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
    loop.quit();
    if (failures > 0) imports.system.exit(1);
  }
})();

loop.run();
