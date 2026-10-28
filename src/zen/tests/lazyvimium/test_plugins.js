/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LazyvimiumActions } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumActions.sys.mjs"
);
const { LazyvimiumKeymap } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs"
);
const { LazyvimiumPlugins } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumPlugins.sys.mjs"
);

function create() {
  const actions = new LazyvimiumActions();
  const keymap = new LazyvimiumKeymap();
  const plugins = new LazyvimiumPlugins({ actions, keymap });
  return { actions, keymap, plugins };
}

function tabsSpec() {
  return {
    name: "tabs",
    opts: { wrap: true, close: { confirmPinned: true } },
    actions: (plugin, opts) => ({
      "tabs.next": { desc: "Next Tab", run: () => opts.wrap },
      "tabs.close": { desc: "Close Tab", run() {} },
    }),
    keys: [
      ["n", "<S-l>", "tabs.next"],
      [["n", "v"], "<leader>bd", "tabs.close", { desc: "Delete Buffer" }],
    ],
    groups: [["n", "<leader>b", "buffer"]],
  };
}

add_task(function test_load_registers_everything() {
  const { actions, keymap, plugins } = create();
  const report = plugins.load({ specs: [tabsSpec()] });
  Assert.deepEqual(report.loaded, ["tabs"]);
  Assert.ok(actions.has("tabs.next"));
  Assert.equal(actions.get("tabs.next").owner, "tabs");
  Assert.equal(keymap.get("n", "L").rhs, "tabs.next");
  Assert.equal(
    keymap.get("n", "L").desc,
    "Next Tab",
    "desc falls back to the action's"
  );
  Assert.equal(keymap.get("v", "<leader>bd").desc, "Delete Buffer");
  Assert.equal(keymap.groupName("n", ["<Space>", "b"]), "buffer");
});

add_task(function test_specs_from_another_global() {
  const spec = Cu.cloneInto(
    { name: "other", opts: { a: { b: 1 } } },
    Cu.Sandbox(null)
  );
  const { plugins } = create();
  const report = plugins.load({
    specs: [spec],
    overrides: [{ name: "other", opts: { a: { c: 2 } } }],
  });
  Assert.deepEqual(report.loaded, ["other"]);
  Assert.deepEqual(plugins.get("other").opts, { a: { b: 1, c: 2 } });
});

add_task(async function test_user_overrides_merge() {
  const { actions, keymap, plugins } = create();
  plugins.load({
    specs: [tabsSpec()],
    overrides: [
      {
        name: "tabs",
        opts: { wrap: false, close: { extra: 1 } },
        keys: [
          ["n", "<S-l>", false],
          ["n", "gt", "tabs.next"],
        ],
      },
    ],
  });
  Assert.deepEqual(
    plugins.get("tabs").opts,
    { wrap: false, close: { confirmPinned: true, extra: 1 } },
    "opts are deep merged"
  );
  Assert.equal(
    await actions.run("tabs.next", {}),
    false,
    "actions see merged opts"
  );
  Assert.equal(keymap.get("n", "L"), null, "a false rhs removes the key");
  Assert.equal(keymap.get("n", "gt").rhs, "tabs.next");
  Assert.ok(keymap.get("n", "<leader>bd"), "other keys stay");
});

add_task(function test_function_forms() {
  const { keymap, plugins } = create();
  plugins.load({
    specs: [tabsSpec()],
    overrides: [
      {
        name: "tabs",
        opts: (plugin, opts) => {
          opts.wrap = "changed";
        },
        keys: (plugin, keys) => keys.filter(([, lhs]) => lhs != "<S-l>"),
      },
    ],
  });
  Assert.equal(plugins.get("tabs").opts.wrap, "changed");
  Assert.equal(keymap.get("n", "L"), null);
});

add_task(function test_disabled_and_extras() {
  const { actions, plugins } = create();
  const ublock = {
    name: "ublock",
    extra: true,
    actions: { "ublock.zapper": { desc: "Element Zapper", run() {} } },
    keys: [["n", "<leader>xz", "ublock.zapper"]],
  };
  let report = plugins.load({ specs: [tabsSpec(), ublock] });
  Assert.deepEqual(report.skipped, ["ublock"], "extras are opt-in");
  Assert.ok(!actions.has("ublock.zapper"));

  report = plugins.load({ specs: [tabsSpec(), ublock], extras: ["ublock"] });
  Assert.deepEqual(report.loaded, ["tabs", "ublock"]);
  Assert.ok(actions.has("ublock.zapper"));

  report = plugins.load({
    specs: [tabsSpec(), ublock],
    extras: ["ublock"],
    overrides: [{ name: "tabs", enabled: false }],
  });
  Assert.deepEqual(report.skipped, ["tabs"]);
  Assert.ok(!actions.has("tabs.next"), "reloading drops disabled plugins");
});

add_task(function test_priority_order() {
  const { plugins } = create();
  const order = [];
  const spec = (name, priority) => ({
    name,
    priority,
    setup: () => order.push(name),
  });
  plugins.load({
    specs: [spec("late", 100), spec("default"), spec("early", 10)],
  });
  Assert.deepEqual(order, ["early", "default", "late"]);
});

add_task(function test_setup_is_replaced_not_chained() {
  const { plugins } = create();
  const calls = [];
  plugins.load({
    specs: [
      { name: "tabs", setup: () => calls.push("core") },
      { name: "tabs", setup: (plugin, opts) => calls.push(`user:${opts.a}`) },
      { name: "tabs", opts: { a: 1 } },
    ],
  });
  Assert.deepEqual(calls, ["user:1"]);
});

add_task(function test_failures_are_isolated() {
  const { actions, keymap, plugins } = create();
  const report = plugins.load({
    specs: [
      tabsSpec(),
      {
        name: "broken",
        actions: { "broken.ok": { desc: "Fine", run() {} } },
        keys: [["n", "q", "broken.ok"]],
        setup() {
          throw new Error("setup failed");
        },
      },
      { name: "typo", acitons: {} },
      { opts: {} },
    ],
  });
  Assert.deepEqual(report.loaded, ["tabs"]);
  Assert.deepEqual(report.failed.sort(), ["broken", "typo"]);
  Assert.equal(report.invalid.length, 1, "a spec without a name is reported");
  Assert.ok(!actions.has("broken.ok"), "a failed plugin leaves nothing behind");
  Assert.equal(keymap.get("n", "q"), null);
  Assert.ok(/unknown fields: acitons/.test(plugins.get("typo").error.message));
});

add_task(function test_unload() {
  const { actions, keymap, plugins } = create();
  plugins.load({ specs: [tabsSpec()] });
  plugins.unload("tabs");
  Assert.ok(!actions.has("tabs.next"));
  Assert.equal(keymap.get("n", "L"), null);
  Assert.ok(!plugins.get("tabs").loaded);
});

add_task(function test_keys_to_missing_actions_are_skipped() {
  const { keymap, plugins } = create();
  plugins.load({
    specs: [
      tabsSpec(),
      {
        name: "keymaps",
        priority: 100,
        keys: [
          ["n", "J", "tabs.next"],
          ["n", "<leader>xz", "ublock.zapper"],
        ],
      },
    ],
  });
  Assert.ok(keymap.get("n", "J"));
  Assert.equal(keymap.get("n", "<leader>xz"), null);
  Assert.deepEqual(plugins.get("keymaps").warnings, [
    `"<leader>xz" (n) maps to unknown action "ublock.zapper"`,
  ]);
  Assert.ok(
    plugins.get("keymaps").loaded,
    "a warning does not fail the plugin"
  );
});

add_task(function test_action_removed_with_false() {
  const { actions, plugins } = create();
  plugins.load({
    specs: [tabsSpec()],
    overrides: [{ name: "tabs", actions: { "tabs.close": false } }],
  });
  Assert.ok(actions.has("tabs.next"));
  Assert.ok(!actions.has("tabs.close"));
});
