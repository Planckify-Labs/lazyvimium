/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LazyvimiumYankRing, MAX_YANK_LENGTH } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumYankRing.sys.mjs"
);

add_task(function test_newest_first() {
  const ring = new LazyvimiumYankRing();
  ring.add("one");
  ring.add("two");
  Assert.deepEqual(
    ring.entries.map(entry => entry.text),
    ["two", "one"]
  );
  Assert.equal(ring.at(1).text, "one");
  Assert.equal(ring.at(2), null);
});

add_task(function test_the_same_text_is_kept_once() {
  const ring = new LazyvimiumYankRing();
  ring.add("one");
  ring.add("two");
  Assert.ok(ring.add("one"), "an older yank moves to the front");
  Assert.deepEqual(
    ring.entries.map(entry => entry.text),
    ["one", "two"]
  );
  Assert.ok(!ring.add("one"), "the newest again changes nothing");
});

add_task(function test_length_and_what_is_not_kept() {
  const ring = new LazyvimiumYankRing({ length: 2 });
  ring.add("a");
  ring.add("b");
  ring.add("c");
  Assert.deepEqual(
    ring.entries.map(entry => entry.text),
    ["c", "b"]
  );
  Assert.ok(!ring.add("   "), "blank text");
  Assert.ok(!ring.add("x".repeat(MAX_YANK_LENGTH + 1)), "too much text");
  Assert.ok(!ring.add(42), "not text");
  Assert.equal(ring.length, 2);
});

add_task(function test_changes_are_reported_and_entries_are_copies() {
  let changes = 0;
  const ring = new LazyvimiumYankRing({ onChange: () => changes++ });
  ring.add("a", { url: "https://example.com/" });
  ring.add("a");
  Assert.equal(changes, 1);
  ring.entries[0].text = "changed";
  Assert.equal(ring.at(0).text, "a", "callers cannot change the ring");
  ring.clear();
  ring.clear();
  Assert.equal(changes, 2);
  Assert.equal(ring.length, 0);
});

add_task(function test_a_saved_ring_is_loaded_sanitized() {
  const ring = new LazyvimiumYankRing({
    length: 2,
    entries: [{ text: "ok", time: 1 }, { text: 5 }, null, { text: "too" }],
  });
  Assert.deepEqual(
    ring.entries.map(entry => entry.text),
    ["ok", "too"]
  );
});
