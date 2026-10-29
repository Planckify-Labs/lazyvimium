/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LAZYVIMIUM_SPECS, parseUserConfig } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { LazyvimiumActions } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumActions.sys.mjs"
);
const { LazyvimiumKeymap } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs"
);
const { LazyvimiumPlugins } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumPlugins.sys.mjs"
);

function loadBuiltins(extraSpecs = []) {
  const actions = new LazyvimiumActions();
  const keymap = new LazyvimiumKeymap();
  const plugins = new LazyvimiumPlugins({ actions, keymap });
  const report = plugins.load({ specs: [...LAZYVIMIUM_SPECS, ...extraSpecs] });
  return { actions, keymap, plugins, report };
}

add_task(function test_builtin_specs_load_cleanly() {
  const { plugins, report } = loadBuiltins();
  Assert.deepEqual(report.failed, []);
  Assert.deepEqual(report.invalid, []);
  for (const plugin of plugins.list()) {
    Assert.deepEqual(
      plugin.warnings,
      [],
      `${plugin.name} maps only to actions that exist`
    );
  }
});

add_task(function test_lazyvim_defaults() {
  const { keymap } = loadBuiltins();
  // Every implemented key from the agreed LazyVim keymap table.
  const expected = {
    i: "input.first",
    I: "mode.insert",
    "]i": "input.next",
    "[i": "input.prev",
    j: "scroll.down",
    k: "scroll.up",
    h: "scroll.left",
    l: "scroll.right",
    gg: "scroll.top",
    G: "scroll.bottom",
    "<C-d>": "scroll.halfPageDown",
    "<C-u>": "scroll.halfPageUp",
    "<C-f>": "scroll.pageDown",
    "<C-b>": "scroll.pageUp",
    "/": "search.page",
    n: "search.next",
    N: "search.prev",
    "<C-o>": "history.back",
    "<C-i>": "history.forward",
    yy: "yank.url",
    p: "url.paste",
    P: "url.pasteNewTab",
    r: "page.reload",
    u: "tabs.undoClose",
    "-": "url.up",
    gi: "input.last",

    "<S-h>": "tabs.prev",
    "<S-l>": "tabs.next",
    "[b": "tabs.prev",
    "]b": "tabs.next",
    "[B": "tabs.movePrev",
    "]B": "tabs.moveNext",
    "<leader>bb": "tabs.alternate",
    "<leader>`": "tabs.alternate",
    "<leader>bd": "tabs.close",
    "<leader>bo": "tabs.closeOthers",
    "<leader>br": "tabs.closeRight",
    "<leader>bl": "tabs.closeLeft",
    "<leader>bp": "tabs.togglePin",
    "<leader>bP": "tabs.closeUnpinned",
    "<leader>bj": "tabs.pick",
    "<leader>bm": "tabs.menu",
    "<leader>be": "tabs.toggleEssential",
    "<leader>bR": "tabs.rename",
    "<leader>bc": "tabs.duplicate",
    "<leader>bu": "tabs.unload",
    "<leader>bM": "tabs.toggleMute",
    "<leader>bf": "tabs.moveToFolder",
    R: "page.hardReload",

    "<leader><tab><tab>": "spaces.new",
    "<leader><tab>]": "spaces.next",
    "<leader><tab>[": "spaces.prev",
    "<leader><tab>f": "spaces.first",
    "<leader><tab>l": "spaces.last",
    "<leader><tab>d": "spaces.close",
    "<leader><tab>r": "spaces.rename",
    "<leader><tab>i": "spaces.icon",
    "<leader><tab>t": "spaces.theme",
    "<leader><tab>u": "spaces.unload",
    gt: "spaces.next",
    gT: "spaces.prev",

    "<C-h>": "splits.focusLeft",
    "<C-j>": "splits.focusDown",
    "<C-k>": "splits.focusUp",
    "<C-l>": "splits.focusRight",
    "<leader>-": "splits.horizontal",
    "<leader>|": "splits.vertical",
    "<leader>wd": "splits.close",
    "<leader>wo": "splits.only",
    "<leader>oo": "library.toggle",
    "<leader>oh": "library.history",
    "<leader>od": "library.downloads",
    "<leader>os": "library.spaces",
    "<leader>om": "library.media",
    "<leader>ob": "library.boosts",
    "<leader>or": "library.routing",

    "<leader><space>": "find.anything",
    "<leader>ff": "find.anything",
    "<leader>,": "find.tabs",
    "<leader>fb": "find.tabs",
    "<leader>fr": "find.recent",
    "<leader>fn": "tabs.new",
    "<leader>/": "search.web",

    "<leader>?": "whichkey.show",
    "<leader>e": "explorer.toggle",
    "<leader>E": "zen.sidebar.toggle",
    "<leader>m": "toolbar.open",
    "<leader>uc": "zen.compactMode.toggle",
    "<leader>ub": "ui.toggleDark",
    "<leader>uz": "ui.readerMode",
    "<leader>un": "ui.dismissNotifications",
    "<leader>qq": "session.quit",
    "<leader>qs": "session.restore",
    "<leader>qm": "window.minimize",
    "<leader>qM": "window.toggleMaximize",
    "<leader>qw": "window.close",
  };
  for (const [lhs, rhs] of Object.entries(expected)) {
    Assert.equal(keymap.get("n", lhs)?.rhs, rhs, lhs);
  }
  const explorer = {
    j: "explorer.down",
    k: "explorer.up",
    gg: "explorer.first",
    G: "explorer.last",
    "<C-d>": "explorer.halfPageDown",
    "<C-u>": "explorer.halfPageUp",
    "<CR>": "explorer.open",
    l: "explorer.open",
    o: "explorer.preview",
    h: "explorer.collapse",
    za: "explorer.foldToggle",
    zo: "explorer.foldOpen",
    zc: "explorer.foldClose",
    zR: "explorer.foldOpenAll",
    zM: "explorer.foldCloseAll",
    Z: "explorer.foldCloseAll",
    s: "explorer.jump",
    "/": "explorer.find",
    a: "explorer.add",
    A: "explorer.addFolder",
    d: "explorer.delete",
    u: "tabs.undoClose",
    r: "explorer.rename",
    c: "explorer.duplicate",
    y: "explorer.yank",
    Y: "explorer.yankMarkdown",
    p: "explorer.togglePin",
    e: "explorer.toggleEssential",
    ">": "explorer.moveToFolder",
    "<lt>": "explorer.moveOutOfFolder",
    "<A-j>": "explorer.moveDown",
    "<A-k>": "explorer.moveUp",
    "<C-v>": "explorer.splitVertical",
    "<C-s>": "explorer.splitHorizontal",
    R: "explorer.reload",
    U: "explorer.unload",
    M: "explorer.toggleMute",
    m: "explorer.menu",
    "<Tab>": "explorer.toggleSelect",
    V: "explorer.visual",
    gt: "spaces.next",
    gT: "spaces.prev",
    "?": "whichkey.show",
    q: "explorer.quit",
    "<Esc>": "explorer.escape",
    "<leader>e": "explorer.quit",
  };
  for (const [lhs, rhs] of Object.entries(explorer)) {
    Assert.equal(keymap.get("e", lhs)?.rhs, rhs, `${lhs} in the explorer`);
  }
  const toolbar = {
    h: "toolbar.left",
    l: "toolbar.right",
    0: "toolbar.first",
    $: "toolbar.last",
    "<CR>": "toolbar.press",
    m: "toolbar.menu",
    s: "toolbar.jump",
    i: "toolbar.urlbar",
    q: "toolbar.quit",
    "<Esc>": "toolbar.quit",
    "<leader>m": "toolbar.quit",
  };
  for (const [lhs, rhs] of Object.entries(toolbar)) {
    Assert.equal(keymap.get("t", lhs)?.rhs, rhs, `${lhs} in the toolbar`);
  }
  Assert.equal(keymap.get("i", "<Esc>")?.rhs, "mode.normal");
  Assert.equal(keymap.get("i", "<C-j>")?.rhs, "input.next");
  Assert.equal(keymap.get("i", "<C-k>")?.rhs, "input.prev");
  Assert.equal(keymap.get("i", "<C-w>")?.rhs, "edit.deleteWordBackward");
  Assert.equal(keymap.get("i", "<C-u>")?.rhs, "edit.deleteToLineStart");
  Assert.equal(keymap.get("i", "<C-h>")?.rhs, "edit.deleteCharBackward");
  Assert.equal(keymap.groupName("n", ["<Space>", "b"]), "buffer");
});

add_task(function test_clipboard_text_only_opens_web_urls() {
  const { urlFromClipboardText } = ChromeUtils.importESModule(
    "resource:///modules/lazyvimium/plugins/LazyvimiumNavigation.sys.mjs"
  );
  Assert.equal(
    urlFromClipboardText("https://example.com/a?b=1"),
    "https://example.com/a?b=1"
  );
  Assert.ok(
    /^https?:\/\/example\.com\/$/.test(urlFromClipboardText("example.com")),
    "a bare host is fixed up into a web URL"
  );
  Assert.equal(urlFromClipboardText("javascript:alert(1)"), null);
  Assert.equal(urlFromClipboardText("file:///etc/passwd"), null);
  Assert.equal(urlFromClipboardText("data:text/html,hi"), null);
  Assert.equal(urlFromClipboardText("about:config"), null);
  Assert.equal(urlFromClipboardText("one\ntwo"), null, "not multi-line text");
  Assert.equal(urlFromClipboardText(""), null);
});

add_task(function test_zen_commands_are_wrapped() {
  const { actions } = loadBuiltins([
    {
      name: "zen-commands",
      opts: {
        commands: [
          "cmd_zenCompactModeToggle",
          "cmd_zenOpenZenThemePicker",
          "cmd_zenCtxDeleteWorkspace",
          "cmd_zenWorkspaceSwitch1",
          "Browser:Back",
        ],
      },
    },
  ]);
  Assert.ok(actions.has("zen.compactMode.toggle"), "curated name");
  Assert.ok(!actions.has("zen.compactModeToggle"), "no duplicate for curated");
  Assert.equal(
    actions.get("zen.openZenThemePicker")?.desc,
    "Zen: Open Zen Theme Picker"
  );
  Assert.ok(!actions.has("zen.ctxDeleteWorkspace"), "context menu commands");
  Assert.ok(!actions.has("zen.workspaceSwitch1"), "commands needing an event");
  Assert.ok(
    !actions.list({ owner: "zen-commands" }).some(a => a.id.includes("Back")),
    "only Zen's commands"
  );
});

add_task(function test_parse_user_config() {
  Assert.deepEqual(parseUserConfig({}), { extras: [], overrides: [] });
  const { extras, overrides } = parseUserConfig({
    extras: ["ublock"],
    plugins: [{ name: "scroll", opts: { step: 80 } }],
    keymaps: [["n", "J", "tabs.next"]],
  });
  Assert.deepEqual(extras, ["ublock"]);
  Assert.deepEqual(overrides, [
    { name: "scroll", opts: { step: 80 } },
    { name: "user", priority: 1000, keys: [["n", "J", "tabs.next"]] },
  ]);
  Assert.throws(() => parseUserConfig([]), /must hold an object/);
  Assert.throws(() => parseUserConfig({ extras: [1] }), /list of names/);
  Assert.throws(() => parseUserConfig({ plugins: {} }), /list of specs/);
});

add_task(function test_user_keymaps_override_defaults() {
  const actions = new LazyvimiumActions();
  const keymap = new LazyvimiumKeymap();
  const plugins = new LazyvimiumPlugins({ actions, keymap });
  const { overrides } = parseUserConfig({
    plugins: [{ name: "keymaps", keys: [["n", "<S-l>", false]] }],
    keymaps: [["n", "J", "tabs.next"]],
  });
  plugins.load({ specs: LAZYVIMIUM_SPECS, overrides });
  Assert.equal(keymap.get("n", "<S-l>"), null);
  Assert.equal(keymap.get("n", "J")?.rhs, "tabs.next");
});
