/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LazyvimiumActions, LazyvimiumActionError } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumActions.sys.mjs"
);

function nextTab() {
  return {
    desc: "Next Tab",
    params: { count: "number?" },
    agent: "act",
    run: (context, { count = 1 }) => context.moved.push(count),
  };
}

add_task(async function test_register_and_run() {
  const actions = new LazyvimiumActions();
  actions.register("tabs.next", nextTab(), { owner: "tabs" });
  const action = actions.get("tabs.next");
  Assert.equal(action.where, "parent", "parent is the default side");
  Assert.equal(action.owner, "tabs");

  const context = { moved: [] };
  await actions.run("tabs.next", context);
  await actions.run("tabs.next", context, { count: 3 });
  Assert.deepEqual(context.moved, [1, 3]);
});

add_task(function test_invalid_definitions() {
  const actions = new LazyvimiumActions();
  const cases = [
    ["Tabs.next", nextTab(), /not a valid action id/],
    ["tabs", nextTab(), /not a valid action id/],
    ["tabs.next", { ...nextTab(), desc: "" }, /needs a desc/],
    ["tabs.next", { ...nextTab(), run: null }, /needs a run function/],
    ["tabs.next", { ...nextTab(), where: "worker" }, /unknown where/],
    ["tabs.next", { ...nextTab(), agent: true }, /unknown agent access/],
    ["tabs.next", { ...nextTab(), params: { count: "int" } }, /unknown type/],
  ];
  for (const [id, definition, error] of cases) {
    Assert.throws(() => actions.register(id, definition), error);
  }
  Assert.equal(actions.list().length, 0);
});

add_task(async function test_argument_validation() {
  const actions = new LazyvimiumActions();
  actions.register("page.open", {
    desc: "Open URL",
    params: { url: "string", background: "boolean?" },
    run: () => "ok",
  });
  Assert.equal(
    await actions.run("page.open", {}, { url: "https://example.com" }),
    "ok"
  );
  const rejects = async (args, pattern) => {
    await Assert.rejects(actions.run("page.open", {}, args), pattern);
  };
  await rejects({}, /needs "url"/);
  await rejects({ url: 5 }, /must be a string/);
  await rejects({ url: "x", background: "yes" }, /must be a boolean/);
  await rejects({ url: "x", script: "alert(1)" }, /does not take "script"/);
  await rejects([], /must be an object/);
});

add_task(async function test_unknown_action() {
  const actions = new LazyvimiumActions();
  try {
    await actions.run("nope.nothing", {});
    Assert.ok(false, "should have thrown");
  } catch (e) {
    Assert.ok(e instanceof LazyvimiumActionError);
    Assert.equal(e.code, "unknown-action");
  }
});

add_task(function test_number_arguments_must_be_finite() {
  const actions = new LazyvimiumActions();
  actions.register("tabs.next", nextTab());
  Assert.throws(
    () => actions.validate("tabs.next", { count: NaN }),
    /must be a number/
  );
});

add_task(function test_list_and_remove_owner() {
  const actions = new LazyvimiumActions();
  actions.register("tabs.next", nextTab(), { owner: "tabs" });
  actions.register(
    "scroll.down",
    {
      desc: "Scroll Down",
      where: "content",
      module: "resource:///modules/example.sys.mjs",
    },
    { owner: "scroll" }
  );
  Assert.deepEqual(
    actions.list({ agent: true }).map(a => a.id),
    ["tabs.next"],
    "only agent-visible actions"
  );
  Assert.deepEqual(
    actions.list({ owner: "scroll" }).map(a => a.id),
    ["scroll.down"]
  );
  actions.removeOwner("tabs");
  Assert.ok(!actions.has("tabs.next"));
  Assert.ok(actions.has("scroll.down"));
});

add_task(async function test_content_actions() {
  const actions = new LazyvimiumActions();
  const module = "resource:///modules/lazyvimium/plugins/Example.sys.mjs";
  actions.register("scroll.down", {
    desc: "Scroll Down",
    where: "content",
    module,
    params: { count: "number?" },
  });
  Assert.equal(actions.get("scroll.down").module, module);

  const forwarded = [];
  await actions.run(
    "scroll.down",
    { runContent: (action, args) => forwarded.push([action.id, args]) },
    { count: 2 }
  );
  Assert.deepEqual(forwarded, [["scroll.down", { count: 2 }]]);
  await Assert.rejects(actions.run("scroll.down", {}), /no page to run in/);

  Assert.throws(
    () => actions.register("scroll.up", { desc: "Up", where: "content" }),
    /needs a module/
  );
  Assert.throws(
    () =>
      actions.register("scroll.up", {
        desc: "Up",
        where: "content",
        module,
        run() {},
      }),
    /no run function/,
    "content code must live in the module, not in the parent spec"
  );
});

add_task(function test_schema() {
  const actions = new LazyvimiumActions();
  actions.register("page.open", {
    desc: "Open URL",
    params: { url: "string", background: "boolean?" },
    run() {},
  });
  Assert.deepEqual(actions.schema("page.open"), {
    type: "object",
    properties: { url: { type: "string" }, background: { type: "boolean" } },
    required: ["url"],
    additionalProperties: false,
  });
});
