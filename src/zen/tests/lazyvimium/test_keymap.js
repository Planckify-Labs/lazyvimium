/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LazyvimiumKeymap } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs"
);

add_task(function test_set_get_and_replace() {
  const keymap = new LazyvimiumKeymap();
  keymap.set("n", "<S-l>", "tabs.next", { desc: "Next Tab", owner: "tabs" });
  const mapping = keymap.get("n", "L");
  Assert.equal(mapping.rhs, "tabs.next", "<S-l> and L are the same key");
  Assert.equal(mapping.desc, "Next Tab");

  keymap.set("n", "L", "tabs.last");
  Assert.equal(keymap.get("n", "<S-l>").rhs, "tabs.last", "later set replaces");
  Assert.equal(keymap.list("n").length, 1);
  Assert.equal(keymap.get("i", "L"), null, "modes are separate");
});

add_task(function test_multiple_modes_and_del() {
  const keymap = new LazyvimiumKeymap();
  keymap.set(["n", "v"], "j", "scroll.down");
  Assert.ok(keymap.get("n", "j"));
  Assert.ok(keymap.get("v", "j"));
  keymap.del("v", "j");
  Assert.ok(keymap.get("n", "j"));
  Assert.equal(keymap.get("v", "j"), null);
  Assert.deepEqual(keymap.modes(), ["n"]);
});

add_task(function test_rejects_bad_mappings() {
  const keymap = new LazyvimiumKeymap();
  Assert.throws(() => keymap.set("n", "j", 42), /action id or a function/);
  Assert.throws(() => keymap.set([], "j", "scroll.down"), /at least one mode/);
});

add_task(function test_trie_tracks_changes() {
  const keymap = new LazyvimiumKeymap();
  keymap.set("n", "gg", "scroll.top");
  keymap.set("n", "<leader>bd", "tabs.close");
  let trie = keymap.trie("n");
  Assert.equal(trie.node(["g", "g"]).value.rhs, "scroll.top");
  Assert.equal(trie.node(["g"]).value, null, "g alone is only a prefix");
  Assert.equal(trie.node(["g"]).children.size, 1);
  Assert.equal(trie.node(["x"]), null);

  keymap.set("n", "gt", "spaces.next");
  trie = keymap.trie("n");
  Assert.equal(trie.node(["g"]).children.size, 2, "the trie is rebuilt");
});

add_task(function test_leader_change_reparses() {
  const keymap = new LazyvimiumKeymap();
  keymap.set("n", "<leader>ff", "find.files");
  keymap.group("n", "<leader>f", "file/find");
  keymap.setLeader(",");
  Assert.equal(keymap.get("n", ",ff").rhs, "find.files");
  Assert.equal(keymap.get("n", " ff"), null);
  Assert.equal(keymap.groupName("n", [","]), null);
  Assert.equal(keymap.groupName("n", [",", "f"]), "file/find");
  Assert.equal(keymap.trie("n").node([",", "f", "f"]).value.rhs, "find.files");
});

add_task(function test_remove_owner() {
  const keymap = new LazyvimiumKeymap();
  keymap.set("n", "j", "scroll.down", { owner: "scroll" });
  keymap.set("n", "L", "tabs.next", { owner: "tabs" });
  keymap.group("n", "<leader>b", "buffer", { owner: "tabs" });
  keymap.removeOwner("tabs");
  Assert.ok(keymap.get("n", "j"));
  Assert.equal(keymap.get("n", "L"), null);
  Assert.equal(keymap.groupName("n", ["<Space>", "b"]), null);
  Assert.equal(keymap.trie("n").node(["L"]), null);
});
