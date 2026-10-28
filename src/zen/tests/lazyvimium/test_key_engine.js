/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LazyvimiumKeymap } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs"
);
const { LazyvimiumKeyEngine } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumKeyEngine.sys.mjs"
);

/**
 * Timers driven by hand, so 'timeoutlen' can be tested without waiting.
 */
class FakeTimers {
  #next = 1;
  #pending = new Map();

  setTimeout = (callback, delay) => {
    const id = this.#next++;
    this.#pending.set(id, { callback, delay });
    return id;
  };

  clearTimeout = id => {
    this.#pending.delete(id);
  };

  get count() {
    return this.#pending.size;
  }

  fire() {
    const entries = [...this.#pending.entries()];
    this.#pending.clear();
    for (const [, { callback }] of entries) {
      callback();
    }
  }
}

function setup(mappings, options = {}) {
  const keymap = new LazyvimiumKeymap();
  for (const [mode, lhs, rhs] of mappings) {
    keymap.set(mode, lhs, rhs);
  }
  const timers = new FakeTimers();
  const matches = [];
  const engine = new LazyvimiumKeyEngine({
    keymap,
    timers,
    timeoutlen: 300,
    onMatch: ({ mapping, count, mode }) =>
      matches.push({ rhs: mapping.rhs, count, mode }),
    ...options,
  });
  return { keymap, engine, timers, matches };
}

const feedAll = (engine, tokens) => tokens.map(token => engine.feed(token));

add_task(function test_single_key() {
  const { engine, matches } = setup([["n", "j", "scroll.down"]]);
  Assert.ok(engine.feed("j"), "a mapped key is used");
  Assert.deepEqual(matches, [{ rhs: "scroll.down", count: null, mode: "n" }]);
});

add_task(function test_unmapped_keys_reach_the_page_in_normal_mode() {
  const { engine, matches } = setup([["n", "j", "scroll.down"]]);
  Assert.ok(!engine.feed("q"), "an unmapped key is left to the page");
  Assert.ok(!engine.feed("<C-c>"), "copy still works");
  Assert.ok(!engine.feed(null));
  Assert.equal(matches.length, 0);
});

add_task(function test_sequence() {
  const { engine, matches, timers } = setup([["n", "gg", "scroll.top"]]);
  Assert.ok(engine.feed("g"));
  Assert.equal(matches.length, 0, "waits for the rest of the sequence");
  Assert.deepEqual(engine.pending.tokens, ["g"]);
  Assert.ok(engine.feed("g"));
  Assert.deepEqual(matches, [{ rhs: "scroll.top", count: null, mode: "n" }]);
  Assert.equal(timers.count, 0, "no timer is left behind");
  Assert.deepEqual(engine.pending.tokens, []);
});

add_task(function test_counts() {
  const { engine, matches } = setup([
    ["n", "j", "scroll.down"],
    ["n", "gg", "scroll.top"],
  ]);
  feedAll(engine, ["1", "2", "j"]);
  feedAll(engine, ["3", "g", "g"]);
  Assert.deepEqual(
    matches.map(m => [m.rhs, m.count]),
    [
      ["scroll.down", 12],
      ["scroll.top", 3],
    ]
  );
});

add_task(function test_zero_is_a_key_unless_counting() {
  const { engine, matches } = setup([
    ["n", "0", "scroll.left"],
    ["n", "j", "scroll.down"],
  ]);
  feedAll(engine, ["0"]);
  feedAll(engine, ["1", "0", "j"]);
  Assert.deepEqual(
    matches.map(m => [m.rhs, m.count]),
    [
      ["scroll.left", null],
      ["scroll.down", 10],
    ]
  );
});

add_task(function test_count_before_unmapped_key_is_dropped() {
  const { engine, matches } = setup([["n", "j", "scroll.down"]]);
  Assert.ok(engine.feed("5"));
  Assert.ok(!engine.feed("q"), "the unmapped key still reaches the page");
  Assert.equal(engine.pending.count, null, "the count is gone");
  engine.feed("j");
  Assert.deepEqual(matches, [{ rhs: "scroll.down", count: null, mode: "n" }]);
});

add_task(function test_timeout_runs_complete_prefix() {
  const { engine, matches, timers } = setup([
    ["n", "<leader>b", "buffer.menu"],
    ["n", "<leader>bd", "tabs.close"],
  ]);
  feedAll(engine, ["<Space>", "b"]);
  Assert.equal(matches.length, 0, "ambiguous: waits for more");
  timers.fire();
  Assert.deepEqual(matches, [{ rhs: "buffer.menu", count: null, mode: "n" }]);
  Assert.deepEqual(engine.pending.tokens, []);
});

add_task(function test_timeout_drops_incomplete_prefix() {
  const { engine, matches, timers } = setup([
    ["n", "<leader>bd", "tabs.close"],
  ]);
  feedAll(engine, ["<Space>", "b"]);
  timers.fire();
  Assert.equal(matches.length, 0);
  Assert.deepEqual(engine.pending.tokens, []);
});

add_task(function test_broken_sequence_runs_prefix_then_key() {
  const { engine, matches } = setup([
    ["n", "g", "go.menu"],
    ["n", "gg", "scroll.top"],
    ["n", "j", "scroll.down"],
  ]);
  feedAll(engine, ["g", "j"]);
  Assert.deepEqual(
    matches.map(m => m.rhs),
    ["go.menu", "scroll.down"],
    "the shorter mapping runs, then the key on its own"
  );
});

add_task(function test_broken_sequence_without_prefix_mapping() {
  const { engine, matches } = setup([
    ["n", "gg", "scroll.top"],
    ["n", "j", "scroll.down"],
  ]);
  const used = feedAll(engine, ["g", "j"]);
  Assert.deepEqual(used, [true, true]);
  Assert.deepEqual(
    matches.map(m => m.rhs),
    ["scroll.down"]
  );
  Assert.ok(engine.feed("g"));
  Assert.ok(!engine.feed("q"), "an unmapped key after a broken prefix passes");
});

add_task(function test_escape_abandons_pending() {
  const { engine, matches, timers } = setup([
    ["n", "<leader>b", "buffer.menu"],
    ["n", "<leader>bd", "tabs.close"],
  ]);
  feedAll(engine, ["3", "<Space>", "b"]);
  Assert.ok(engine.feed("<Esc>"), "<Esc> is used to cancel");
  Assert.equal(timers.count, 0);
  Assert.equal(matches.length, 0, "the prefix mapping does not run");
  Assert.deepEqual(engine.pending, { tokens: [], count: null, group: null });
  Assert.ok(!engine.feed("<Esc>"), "with nothing pending <Esc> passes");
});

add_task(function test_modes() {
  const { engine, matches } = setup([
    ["n", "j", "scroll.down"],
    ["i", "<Esc>", "mode.normal"],
  ]);
  engine.setMode("i");
  Assert.ok(!engine.feed("j"), "typing in insert mode reaches the page");
  Assert.ok(!engine.feed("5"), "no counts in insert mode");
  Assert.ok(engine.feed("<Esc>"));
  Assert.deepEqual(matches, [{ rhs: "mode.normal", count: null, mode: "i" }]);
  Assert.throws(() => engine.setMode("nope"), /unknown mode/);
});

add_task(function test_mode_change_drops_pending() {
  const { engine, timers } = setup([["n", "gg", "scroll.top"]]);
  feedAll(engine, ["4", "g"]);
  engine.setMode("i");
  Assert.deepEqual(engine.pending.tokens, []);
  Assert.equal(engine.pending.count, null);
  Assert.equal(timers.count, 0);
});

add_task(function test_custom_mode_swallows_unmapped() {
  const { engine } = setup([["hint", "a", "hint.pick"]]);
  engine.defineMode("hint", { counts: false, passUnmapped: false });
  engine.setMode("hint");
  Assert.ok(engine.feed("z"), "hint mode keeps stray keys from the page");
});

add_task(function test_state_change_and_group() {
  const changes = [];
  const { engine, keymap } = setup([["n", "<leader>bd", "tabs.close"]], {
    onStateChange: e => changes.push(e.pending),
  });
  keymap.group("n", "<leader>b", "buffer");
  feedAll(engine, ["2", "<Space>", "b"]);
  Assert.deepEqual(changes.at(-1), {
    tokens: ["<Space>", "b"],
    count: 2,
    group: "buffer",
  });
});

add_task(function test_failing_action_keeps_engine_usable() {
  let calls = 0;
  const { engine } = setup([["n", "j", "scroll.down"]], {
    onMatch: () => {
      calls++;
      throw new Error("boom");
    },
  });
  Assert.ok(engine.feed("j"));
  Assert.ok(engine.feed("j"));
  Assert.equal(calls, 2);
});

add_task(function test_wait_for_prefix_like_which_key() {
  const { engine, matches, timers } = setup(
    [
      ["n", "<leader>bd", "tabs.close"],
      ["n", "g", "go.menu"],
      ["n", "gg", "scroll.top"],
    ],
    { waitForPrefix: true }
  );
  engine.feed("<Space>");
  Assert.equal(timers.count, 0, "a pure prefix waits with no timeout");
  engine.feed("b");
  Assert.equal(timers.count, 0, "so does a deeper one");
  engine.feed("d");
  Assert.deepEqual(
    matches.map(m => m.rhs),
    ["tabs.close"]
  );

  engine.feed("g");
  Assert.equal(
    timers.count,
    1,
    "a prefix that is also a mapping still times out"
  );
  timers.fire();
  Assert.deepEqual(
    matches.map(m => m.rhs),
    ["tabs.close", "go.menu"]
  );
});

add_task(function test_backspace_backs_up_one_key() {
  const { engine, matches } = setup(
    [
      ["n", "<leader>bd", "tabs.close"],
      ["n", "<leader>e", "zen.sidebar.toggle"],
    ],
    { waitForPrefix: true }
  );
  engine.feed("<Space>");
  engine.feed("b");
  Assert.ok(engine.feed("<BS>"), "<BS> is used while keys are pending");
  Assert.deepEqual(engine.pending.tokens, ["<Space>"]);
  engine.feed("e");
  Assert.deepEqual(
    matches.map(m => m.rhs),
    ["zen.sidebar.toggle"]
  );

  engine.feed("<Space>");
  engine.feed("<BS>");
  Assert.deepEqual(engine.pending.tokens, [], "back to nothing pending");
  Assert.ok(!engine.feed("<BS>"), "with nothing pending <BS> is the page's");
});
