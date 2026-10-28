/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LazyvimiumKeys } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs"
);

function event(key, init = {}) {
  return {
    key,
    code: init.code ?? "",
    ctrlKey: !!init.ctrl,
    altKey: !!init.alt,
    metaKey: !!init.meta,
    shiftKey: !!init.shift,
    isComposing: !!init.composing,
    getModifierState: name => name == "AltGraph" && !!init.altGraph,
  };
}

add_task(function test_parse_plain_sequences() {
  Assert.deepEqual(LazyvimiumKeys.parse("gg"), ["g", "g"]);
  Assert.deepEqual(LazyvimiumKeys.parse("G"), ["G"]);
  Assert.deepEqual(LazyvimiumKeys.parse("-"), ["-"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<leader>|"), ["<Space>", "|"]);
});

add_task(function test_parse_leader() {
  Assert.deepEqual(LazyvimiumKeys.parse("<leader>bd"), ["<Space>", "b", "d"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<Leader>ff", { leader: "," }), [
    ",",
    "f",
    "f",
  ]);
  Assert.deepEqual(
    LazyvimiumKeys.parse("<leader><tab><tab>"),
    ["<Space>", "<Tab>", "<Tab>"],
    "named keys are case-insensitive and canonical"
  );
});

add_task(function test_parse_modifiers() {
  Assert.deepEqual(LazyvimiumKeys.parse("<C-d>"), ["<C-d>"]);
  Assert.deepEqual(
    LazyvimiumKeys.parse("<C-D>"),
    ["<C-d>"],
    "<C-D> is <C-d> as in vim"
  );
  Assert.deepEqual(LazyvimiumKeys.parse("<c-s-d>"), ["<C-S-d>"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<S-h>"), ["H"], "<S-h> is H");
  Assert.deepEqual(LazyvimiumKeys.parse("<A-j>"), ["<A-j>"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<M-j>"), ["<A-j>"], "M is Alt");
  Assert.deepEqual(LazyvimiumKeys.parse("<S-C-x>"), ["<C-S-x>"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<S-Tab>"), ["<S-Tab>"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<C-Up>"), ["<C-Up>"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<C-->"), ["<C-->"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<F5>"), ["<F5>"]);
});

add_task(function test_parse_special_characters() {
  Assert.deepEqual(LazyvimiumKeys.parse("<lt>"), ["<lt>"]);
  Assert.deepEqual(LazyvimiumKeys.parse("<"), ["<lt>"]);
  Assert.deepEqual(
    LazyvimiumKeys.parse("<foo>"),
    ["<lt>", "f", "o", "o", ">"],
    "an unknown name is typed literally"
  );
  Assert.deepEqual(LazyvimiumKeys.parse("<Bar>"), ["|"]);
  Assert.deepEqual(LazyvimiumKeys.parse("a b"), ["a", "<Space>", "b"]);
  Assert.throws(() => LazyvimiumKeys.parse(""), /cannot be empty/);
});

add_task(function test_from_event_printable() {
  Assert.equal(LazyvimiumKeys.fromEvent(event("j")), "j");
  Assert.equal(LazyvimiumKeys.fromEvent(event("G", { shift: true })), "G");
  Assert.equal(LazyvimiumKeys.fromEvent(event("!", { shift: true })), "!");
  Assert.equal(LazyvimiumKeys.fromEvent(event("|", { shift: true })), "|");
  Assert.equal(LazyvimiumKeys.fromEvent(event(" ")), "<Space>");
  Assert.equal(LazyvimiumKeys.fromEvent(event("<", { shift: true })), "<lt>");
});

add_task(function test_from_event_chords() {
  Assert.equal(
    LazyvimiumKeys.fromEvent(event("d", { ctrl: true, code: "KeyD" })),
    "<C-d>"
  );
  Assert.equal(
    LazyvimiumKeys.fromEvent(
      event("D", { ctrl: true, shift: true, code: "KeyD" })
    ),
    "<C-S-d>"
  );
  Assert.equal(
    LazyvimiumKeys.fromEvent(event("∆", { alt: true, code: "KeyJ" })),
    "<A-j>",
    "Alt combinations use the physical key"
  );
  Assert.equal(
    LazyvimiumKeys.fromEvent(event("Tab", { shift: true })),
    "<S-Tab>"
  );
  Assert.equal(
    LazyvimiumKeys.fromEvent(
      event("@", { ctrl: true, alt: true, altGraph: true })
    ),
    "@",
    "AltGr produces a plain character"
  );
});

add_task(function test_from_event_named_and_ignored() {
  Assert.equal(LazyvimiumKeys.fromEvent(event("Escape")), "<Esc>");
  Assert.equal(LazyvimiumKeys.fromEvent(event("Enter")), "<CR>");
  Assert.equal(LazyvimiumKeys.fromEvent(event("F5")), "<F5>");
  Assert.equal(LazyvimiumKeys.fromEvent(event("Shift", { shift: true })), null);
  Assert.equal(
    LazyvimiumKeys.fromEvent(event("Control", { ctrl: true })),
    null
  );
  Assert.equal(LazyvimiumKeys.fromEvent(event("Dead")), null);
  Assert.equal(LazyvimiumKeys.fromEvent(event("a", { composing: true })), null);
  Assert.equal(LazyvimiumKeys.fromEvent(event("AudioVolumeUp")), null);
});

add_task(function test_event_and_notation_agree() {
  const pairs = [
    ["<C-d>", event("d", { ctrl: true, code: "KeyD" })],
    ["<S-h>", event("H", { shift: true })],
    ["<Esc>", event("Escape")],
    ["<leader>", event(" ")],
    ["<C-Space>", event(" ", { ctrl: true })],
  ];
  for (const [notation, keyEvent] of pairs) {
    Assert.deepEqual(
      LazyvimiumKeys.parse(notation),
      [LazyvimiumKeys.fromEvent(keyEvent)],
      `${notation} matches its event`
    );
  }
});

add_task(function test_count_digits() {
  Assert.ok(LazyvimiumKeys.isCountDigit("5", false));
  Assert.ok(!LazyvimiumKeys.isCountDigit("0", false), "0 cannot start a count");
  Assert.ok(LazyvimiumKeys.isCountDigit("0", true), "0 continues a count");
  Assert.ok(!LazyvimiumKeys.isCountDigit("j", true));
});
