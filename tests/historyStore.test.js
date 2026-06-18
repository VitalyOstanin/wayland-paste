// SPDX-License-Identifier: GPL-2.0-or-later
//
// Юнит-тесты HistoryStore. Запуск: gjs -m tests/historyStore.test.js
// (или ./tests/run.sh). Проверяются дедупликация, вытеснение при заполнении и
// дедупликация на загрузке (_parse), включая гонку load()/поллинг.
//
// Тестируется только текстовый путь и разбор JSON: они не обращаются к диску
// (файловый I/O в HistoryStore только в save/load и при записи изображений),
// поэтому тест не создаёт побочных файлов.

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
// Уникальный фиктивный каталог на тест; HistoryStore не создаёт его до save/load.
let n = 0;
const store = () => new HistoryStore(`/tmp/wp-test-store-${n++}`);

{
  const s = store();
  s.addText("a", 10);
  s.addText("b", 10);
  s.addText("a", 10); // повтор "a"
  check("dedup: длина 2 после a,b,a", s.entries.length === 2, JSON.stringify(texts(s)));
  check("dedup: повтор поднят в начало, порядок [a,b]", JSON.stringify(texts(s)) === '["a","b"]', JSON.stringify(texts(s)));
}

{
  const s = store();
  const max = 3;
  s.addText("a", max);
  s.addText("b", max);
  s.addText("c", max); // [c,b,a] — список заполнен
  check("evict: заполнен [c,b,a]", JSON.stringify(texts(s)) === '["c","b","a"]', JSON.stringify(texts(s)));
  s.addText("d", max); // новая запись при полном списке
  check("evict: длина не превышает max", s.entries.length === max, "len=" + s.entries.length);
  check("evict: новая d в начале", texts(s)[0] === "d", JSON.stringify(texts(s)));
  check("evict: самая старая a вытеснена", !texts(s).includes("a"), JSON.stringify(texts(s)));
  check("evict: итог [d,c,b]", JSON.stringify(texts(s)) === '["d","c","b"]', JSON.stringify(texts(s)));
}

{
  const s = store();
  const max = 3;
  s.addText("a", max);
  s.addText("b", max);
  s.addText("c", max); // [c,b,a]
  s.addText("a", max); // повтор самой старой при полном списке
  check("dedup-full: длина 3", s.entries.length === max, "len=" + s.entries.length);
  check("dedup-full: поднята без потерь, [a,c,b]", JSON.stringify(texts(s)) === '["a","c","b"]', JSON.stringify(texts(s)));
}

{
  // Гонка load()/поллинг: монитор записал свежий "test" во время async-загрузки,
  // затем _parse разбирает файл, в котором "test" тоже сохранён.
  const s = store();
  s.addText("test", 50); // свежая запись из окна загрузки: [test]
  const payload = JSON.stringify({
    version: 1,
    entries: [
      { type: "text", text: "test", ts: 100 }, // дубль свежей записи
      { type: "text", text: "old1", ts: 90 },
      { type: "text", text: "old2", ts: 80 },
    ],
  });
  s._parse(new TextEncoder().encode(payload));
  const t = texts(s);
  check("load-race: одна копия test", t.filter((x) => x === "test").length === 1, JSON.stringify(t));
  check("load-race: порядок [test,old1,old2]", JSON.stringify(t) === '["test","old1","old2"]', JSON.stringify(t));
}

{
  // Дубли внутри самого файла (например, от старой версии) схлопываются;
  // выживает первое (новейшее) вхождение.
  const s = store();
  const payload = JSON.stringify({
    version: 1,
    entries: [
      { type: "text", text: "a", ts: 100 },
      { type: "text", text: "b", ts: 90 },
      { type: "text", text: "a", ts: 80 }, // дубль внутри файла
    ],
  });
  s._parse(new TextEncoder().encode(payload));
  check("file-dedup: [a,b]", JSON.stringify(texts(s)) === '["a","b"]', JSON.stringify(texts(s)));
}

print(`\n${total - failures}/${total} passed`);
print(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
if (failures > 0) imports.system.exit(1);
