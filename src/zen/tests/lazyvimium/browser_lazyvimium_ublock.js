/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { LazyvimiumUblock } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/ublock/LazyvimiumUblock.sys.mjs"
);
const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { ExtensionTestCommon } = ChromeUtils.importESModule(
  "resource://testing-common/ExtensionTestCommon.sys.mjs"
);

const PREF = "lazyvimium.ublock.enabled";
const GECKO = { gecko: { id: "uBlock0@raymondhill.net" } };

// The test profile turns the install off; its default would download uBO.
const ENABLED = Services.prefs.getBoolPref(PREF);
registerCleanupFunction(() => {
  Services.prefs.setBoolPref(PREF, ENABLED);
});

// A stand-in for uBlock Origin, installed for real, so that the test never
// downloads it.
async function installStandIn() {
  const file = ExtensionTestCommon.generateXPI({
    manifest: { browser_specific_settings: GECKO },
  });
  const install = await AddonManager.getInstallForFile(file);
  const addon = await install.install();
  registerCleanupFunction(async () => {
    await (await LazyvimiumUblock.getAddon())?.uninstall();
    await IOUtils.remove(file.path);
  });
  return addon;
}

add_task(async function test_keys_in_the_block_group() {
  for (const [lhs, id] of [
    ["<leader>xx", "ublock.popup"],
    ["<leader>xz", "ublock.zapper"],
    ["<leader>xp", "ublock.picker"],
    ["<leader>xl", "ublock.logger"],
    ["<leader>xd", "ublock.dashboard"],
    ["<leader>xr", "ublock.relax"],
    ["<leader>xc", "ublock.toggleCosmetic"],
    ["<leader>xj", "ublock.toggleJavascript"],
  ]) {
    Assert.equal(Lazyvimium.keymap.get("n", lhs)?.rhs, id, `${lhs} runs ${id}`);
  }
});

add_task(async function test_actions_run_ublock_commands() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: GECKO,
      browser_action: { default_title: "uBlock Origin" },
      commands: {
        _execute_browser_action: {},
        "launch-element-zapper": {},
        "relax-blocking-mode": {},
      },
    },
    background() {
      browser.commands.onCommand.addListener(name =>
        browser.test.sendMessage("command", name)
      );
      browser.browserAction.onClicked.addListener(() =>
        browser.test.sendMessage("clicked")
      );
      browser.test.sendMessage("ready");
    },
  });
  await extension.startup();
  await extension.awaitMessage("ready");

  await Lazyvimium.run("ublock.zapper");
  Assert.equal(
    await extension.awaitMessage("command"),
    "launch-element-zapper",
    "the zapper is uBO's own command"
  );
  await Lazyvimium.run("ublock.relax");
  Assert.equal(await extension.awaitMessage("command"), "relax-blocking-mode");
  await Lazyvimium.run("ublock.popup");
  await extension.awaitMessage("clicked");
  ok(true, "the popup action is uBO's toolbar button");

  await extension.unload();
});

add_task(async function test_a_toast_without_ublock() {
  await Lazyvimium.run("ublock.zapper");
  await TestUtils.waitForCondition(
    () =>
      document.querySelector(
        "#zen-toast-container [data-l10n-id='lazyvimium-ublock-missing-toast']"
      ),
    "a toast says uBO is missing"
  );
});

add_task(async function test_removed_stays_removed() {
  LazyvimiumUblock.init();
  const addon = await installStandIn();
  Services.prefs.setBoolPref(PREF, true);
  await LazyvimiumUblock.sync();
  ok(await LazyvimiumUblock.getAddon(), "an installed uBO is kept");

  await addon.uninstall();
  await TestUtils.waitForCondition(
    () => !Services.prefs.getBoolPref(PREF),
    "removing it turns lazyvimium's install off, so it is not installed again"
  );
});

add_task(async function test_turned_down_in_the_onboarding() {
  await installStandIn();
  Services.prefs.setBoolPref(PREF, true);

  await LazyvimiumUblock.setEnabled(false);
  ok(!(await LazyvimiumUblock.getAddon()), "NO removes uBO");
  ok(!Services.prefs.getBoolPref(PREF), "and keeps it removed");
});
