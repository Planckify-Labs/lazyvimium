/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { assignLabels, findMatches, ignoresCase, JUMP_LABELS } =
  ChromeUtils.importESModule(
    "resource:///modules/lazyvimium/core/LazyvimiumJumpLabels.sys.mjs"
  );

add_task(function test_smartcase() {
  Assert.ok(ignoresCase("abc"));
  Assert.ok(!ignoresCase("aBc"));
  Assert.deepEqual(
    findMatches("Foo foo", "foo").map(match => match.index),
    [0, 4],
    "a lowercase pattern ignores case"
  );
  Assert.deepEqual(
    findMatches("Foo foo", "Foo").map(match => match.index),
    [0],
    "an uppercase one does not"
  );
  Assert.deepEqual(findMatches("anything", ""), [], "no pattern, no match");
});

add_task(function test_matches_report_the_next_character() {
  Assert.deepEqual(findMatches("log in, login", "log"), [
    { index: 0, next: " " },
    { index: 8, next: "i" },
  ]);
  Assert.deepEqual(findMatches("ends log", "log"), [{ index: 5, next: "" }]);
});

add_task(function test_labels_skip_the_next_characters() {
  const labels = assignLabels(3, { skip: ["a", "S", "d"] });
  Assert.deepEqual(labels, ["f", "g", "h"], "a, s and d may follow a match");
  for (const label of labels) {
    Assert.ok(!"asd".includes(label));
  }
});

add_task(function test_labels_run_out() {
  const labels = assignLabels(30);
  Assert.equal(labels.filter(Boolean).length, JUMP_LABELS.length);
  Assert.deepEqual(labels.slice(JUMP_LABELS.length), [null, null, null, null]);
  Assert.equal(new Set(labels.filter(Boolean)).size, JUMP_LABELS.length);
});

add_task(function test_labels_stay_with_their_target() {
  // Targets 0 and 2 stay as the pattern grows; they keep their labels, and
  // a label that became unsafe is replaced.
  const labels = assignLabels(2, { previous: ["k", "a"], skip: ["a"] });
  Assert.equal(labels[0], "k");
  Assert.notEqual(labels[1], "a", "a label that may now follow is not kept");
  Assert.ok(labels[1]);
  Assert.notEqual(labels[1], "k");
});
