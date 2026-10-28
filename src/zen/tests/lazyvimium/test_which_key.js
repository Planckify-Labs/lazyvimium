/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LazyvimiumKeymap } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs"
);
const { whichKeyItems, breadcrumb, sortItems, formatKey } =
  ChromeUtils.importESModule(
    "resource:///modules/lazyvimium/ui/LazyvimiumWhichKey.sys.mjs"
  );

function keymap() {
  const map = new LazyvimiumKeymap();
  map.set("n", "<leader>bd", "tabs.close", { desc: "Delete Tab" });
  map.set("n", "<leader>bb", "tabs.alternate", { desc: "Switch to Other Tab" });
  map.set("n", "<leader>e", "zen.sidebar.toggle", { desc: "Toggle Sidebar" });
  map.set("n", "<leader>E", "x.y", { desc: "Upper" });
  map.set("n", "<leader>|", "splits.vertical", { desc: "Split Window Right" });
  map.set("n", "<leader><tab>]", "spaces.next", { desc: "Next Space" });
  map.set("n", "<leader>gx", "a.b", { desc: "One" });
  map.set("n", "<leader>gy", "a.c", { desc: "Two" });
  map.group("n", "<leader>b", "buffer");
  map.group("n", "<leader><tab>", "spaces");
  return map;
}

add_task(function test_items_under_the_leader() {
  const items = whichKeyItems(keymap(), "n", ["<Space>"]);
  Assert.deepEqual(
    items.map(({ label, desc, group }) => [label, desc, group]),
    [
      ["e", "Toggle Sidebar", false],
      ["E", "Upper", false],
      ["|", "Split Window Right", false],
      ["b", "buffer", true],
      ["g", "2 keymaps", true],
      ["TAB", "spaces", true],
    ],
    "which-key order: mappings, then groups; words before symbols; " +
      "lowercase first; unnamed groups count their keymaps"
  );
});

add_task(function test_items_in_a_group_and_breadcrumb() {
  const map = keymap();
  const items = whichKeyItems(map, "n", ["<Space>", "b"]);
  Assert.deepEqual(
    items.map(item => [item.label, item.desc]),
    [
      ["b", "Switch to Other Tab"],
      ["d", "Delete Tab"],
    ]
  );
  Assert.equal(breadcrumb(map, "n", ["<Space>", "b"]), "SPC » b +buffer");
  Assert.equal(breadcrumb(map, "n", ["<Space>"]), "SPC");
  Assert.equal(whichKeyItems(map, "n", ["<Space>", "e"]), null);
  Assert.equal(whichKeyItems(map, "n", ["q"]), null);
});

add_task(function test_natural_sort_and_key_labels() {
  const sorted = sortItems(
    ["10", "2", "<C-a>", "a", "A", "1"].map(key => ({ key, group: false }))
  ).map(item => item.key);
  Assert.deepEqual(sorted, ["1", "2", "10", "a", "A", "<C-a>"]);
  Assert.equal(formatKey("<Space>"), "SPC");
  Assert.equal(formatKey("<C-d>"), "<C-d>");
});
