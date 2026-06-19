// SPDX-License-Identifier: GPL-2.0-or-later
//
// Unit tests for HistoryStore. Run: gjs -m tests/historyStore.test.js
// (or ./tests/run.sh). Cover deduplication, eviction when full and dedup on
// load (_parse), including the load()/polling race.
//
// Only the text path and JSON parsing are tested: they do not touch the disk
// (file I/O in HistoryStore happens only in save/load and when writing images),
// so the test creates no side-effect files.

import { HistoryStore } from "../lib/historyStore.js";

let failures = 0;
let total = 0;

function check(name, cond, extra) {
  total++;
  const mark = cond ? "OK" : "FAIL";
  if (!cond) failures++;
  print(`[${mark}] ${name}${extra ? "  -> " + extra : ""}`);
}

const texts = (s) => s.entries.map((e) => e.text);
// A unique dummy directory per test; HistoryStore does not create it before save/load.
let n = 0;
const store = () => new HistoryStore(`/tmp/wp-test-store-${n++}`);

{
  const s = store();
  s.addText("a", 10);
  s.addText("b", 10);
  s.addText("a", 10); // repeat "a"
  check("dedup: length 2 after a,b,a", s.entries.length === 2, JSON.stringify(texts(s)));
  check("dedup: repeat moved to front, order [a,b]", JSON.stringify(texts(s)) === '["a","b"]', JSON.stringify(texts(s)));
}

{
  const s = store();
  const max = 3;
  s.addText("a", max);
  s.addText("b", max);
  s.addText("c", max); // [c,b,a] — list is full
  check("evict: full [c,b,a]", JSON.stringify(texts(s)) === '["c","b","a"]', JSON.stringify(texts(s)));
  s.addText("d", max); // new entry while list is full
  check("evict: length does not exceed max", s.entries.length === max, "len=" + s.entries.length);
  check("evict: new d at front", texts(s)[0] === "d", JSON.stringify(texts(s)));
  check("evict: oldest a evicted", !texts(s).includes("a"), JSON.stringify(texts(s)));
  check("evict: result [d,c,b]", JSON.stringify(texts(s)) === '["d","c","b"]', JSON.stringify(texts(s)));
}

{
  const s = store();
  const max = 3;
  s.addText("a", max);
  s.addText("b", max);
  s.addText("c", max); // [c,b,a]
  s.addText("a", max); // repeat the oldest while list is full
  check("dedup-full: length 3", s.entries.length === max, "len=" + s.entries.length);
  check("dedup-full: promoted without loss, [a,c,b]", JSON.stringify(texts(s)) === '["a","c","b"]', JSON.stringify(texts(s)));
}

{
  // load()/polling race: the monitor recorded a fresh "test" during the async
  // load, then _parse parses a file where "test" is also stored.
  const s = store();
  s.addText("test", 50); // fresh entry from the load window: [test]
  const payload = JSON.stringify({
    version: 1,
    entries: [
      { type: "text", text: "test", ts: 100 }, // duplicate of the fresh entry
      { type: "text", text: "old1", ts: 90 },
      { type: "text", text: "old2", ts: 80 },
    ],
  });
  s._parse(new TextEncoder().encode(payload));
  const t = texts(s);
  check("load-race: single copy of test", t.filter((x) => x === "test").length === 1, JSON.stringify(t));
  check("load-race: order [test,old1,old2]", JSON.stringify(t) === '["test","old1","old2"]', JSON.stringify(t));
}

{
  // Duplicates within the file itself (for example from an old version) collapse;
  // the first (newest) occurrence survives.
  const s = store();
  const payload = JSON.stringify({
    version: 1,
    entries: [
      { type: "text", text: "a", ts: 100 },
      { type: "text", text: "b", ts: 90 },
      { type: "text", text: "a", ts: 80 }, // duplicate within the file
    ],
  });
  s._parse(new TextEncoder().encode(payload));
  check("file-dedup: [a,b]", JSON.stringify(texts(s)) === '["a","b"]', JSON.stringify(texts(s)));
}

print(`\n${total - failures}/${total} passed`);
print(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
if (failures > 0) imports.system.exit(1);
