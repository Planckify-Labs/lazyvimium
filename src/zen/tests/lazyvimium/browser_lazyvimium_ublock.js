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

add_task(async function test_no_keys_of_its_own() {
  for (const lhs of ["<leader>xx", "<leader>xz", "<leader>xj"]) {
    Assert.equal(Lazyvimium.keymap.get("n", lhs), null, `${lhs} is not mapped`);
  }
  Assert.equal(
    Lazyvimium.keymap.get("n", "<leader>x")?.rhs,
    "extensions.pick",
    "extensions are reached through one picker"
  );
  Assert.ok(Lazyvimium.actions.has("ublock.zapper"), "the actions stay");
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

function pickerRow(label) {
  return [...document.querySelectorAll(".lazyvimium-picker-item")].find(row =>
    row.querySelector(".lazyvimium-picker-label").textContent.includes(label)
  );
}

add_task(async function test_the_popup_has_labels() {
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: {
      name: "Picker Stand-in",
      browser_specific_settings: { gecko: { id: "picker@example.com" } },
      browser_action: { default_popup: "popup.html" },
    },
    files: {
      "popup.html": `<!DOCTYPE html><meta charset="utf-8">
        <body style="margin:0;width:200px;height:100px">
        <button id="go" style="display:block">Go</button>
        <input id="field" style="display:block">
        <div id="hand" style="cursor:pointer;width:50px;height:20px">Hand</div>
        <script src="popup.js"></script>`,
      "popup.js": `
        document.getElementById("go").onclick = () =>
          browser.test.sendMessage("pressed");
        const labelsOf = () =>
          [...document.querySelectorAll("span[style*='ui-monospace']")].map(
            span => span.textContent
          );
        const timer = setInterval(() => {
          if (labelsOf().length) {
            clearInterval(timer);
            browser.test.sendMessage("labels", labelsOf());
          }
        }, 50);
        document.getElementById("field").onfocus = () =>
          setTimeout(() => browser.test.sendMessage("focused", labelsOf()), 300);`,
    },
  });
  await extension.startup();

  const done = Lazyvimium.run("extensions.pick");
  await TestUtils.waitForCondition(
    () => pickerRow("Picker Stand-in"),
    "the picker lists the extension"
  );
  pickerRow("Picker Stand-in").click();
  await done;

  Assert.deepEqual(
    await extension.awaitMessage("labels"),
    ["a", "d", "f"],
    "the button, the field and the clickable div are labelled in order, with letters vim leaves free"
  );
  EventUtils.synthesizeKey("a");
  await extension.awaitMessage("pressed");
  ok(true, "typing a label presses its control");

  EventUtils.synthesizeKey("d");
  Assert.deepEqual(
    await extension.awaitMessage("focused"),
    [],
    "a field in focus gets the typing, not labels"
  );

  await extension.unload();
});
