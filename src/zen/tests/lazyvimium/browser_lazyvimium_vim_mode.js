/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { CustomizableUI } = ChromeUtils.importESModule(
  "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs"
);

const PREF = "lazyvimium.enabled";

function statusline() {
  return document.getElementById("lazyvimium-statusline");
}

function switchButton() {
  return document.querySelector(
    "#lazyvimium-vim-mode-button .lazyvimium-vim-mode"
  );
}

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(PREF);
  document.documentElement.removeAttribute("zen-welcome-stage");
});

const WIDGET = "lazyvimium-vim-mode-button";
const SINGLE_TOOLBAR = "zen.view.use-single-toolbar";

add_task(async function test_switch_has_room_in_either_layout() {
  ok(
    Services.prefs.getBoolPref(SINGLE_TOOLBAR),
    "Zen starts with its single toolbar"
  );
  const foot = CustomizableUI.getWidgetIdsInArea("zen-sidebar-foot-buttons");
  Assert.equal(
    CustomizableUI.getPlacementOfWidget(WIDGET)?.area,
    "zen-sidebar-foot-buttons",
    "there the switch is in the row below the sidebar, where there is room"
  );
  Assert.equal(
    foot.indexOf(WIDGET) + 1,
    foot.indexOf("zen-create-new-button"),
    "right before +"
  );
  const button = switchButton();
  ok(button, "it is built");
  Assert.equal(button.getAttribute("role"), "switch");
  Assert.equal(button.getAttribute("aria-checked"), "true", "on by default");
  Assert.equal(button.textContent, "vim");
  ok(
    !document
      .getElementById("zen-toggle-compact-mode")
      .hasAttribute("overflowedItem"),
    "and it pushes none of Zen's buttons out of the row above"
  );

  Services.prefs.setBoolPref(SINGLE_TOOLBAR, false);
  Assert.equal(
    CustomizableUI.getPlacementOfWidget(WIDGET)?.area,
    CustomizableUI.AREA_NAVBAR,
    "with Zen's multiple toolbars it moves to the top bar"
  );
  Services.prefs.clearUserPref(SINGLE_TOOLBAR);
  Assert.equal(
    CustomizableUI.getPlacementOfWidget(WIDGET)?.area,
    "zen-sidebar-foot-buttons",
    "and back"
  );

  CustomizableUI.addWidgetToArea(WIDGET, "zen-sidebar-top-buttons");
  Services.prefs.setBoolPref(SINGLE_TOOLBAR, false);
  Assert.equal(
    CustomizableUI.getPlacementOfWidget(WIDGET)?.area,
    "zen-sidebar-top-buttons",
    "a place the user picked is left alone"
  );
  Services.prefs.clearUserPref(SINGLE_TOOLBAR);
  CustomizableUI.addWidgetToArea(
    WIDGET,
    "zen-sidebar-foot-buttons",
    CustomizableUI.getWidgetIdsInArea("zen-sidebar-foot-buttons").indexOf(
      "zen-create-new-button"
    )
  );
});

add_task(async function test_switch_turns_vim_mode_off_and_on() {
  const defaults = Services.prefs.getDefaultBranch("");
  ok(
    defaults.getBoolPref("zen.view.compact.hide-toolbar"),
    "vim mode's compact layout is the default while it is on"
  );

  switchButton().click();
  ok(!Services.prefs.getBoolPref(PREF), "a click turns vim mode off");
  Assert.equal(switchButton().getAttribute("aria-checked"), "false");
  Assert.equal(statusline().style.display, "none", "no mode indicator");
  ok(
    !document.documentElement.hasAttribute("lazyvimium-mode"),
    "nor a mode color on the window"
  );
  ok(
    !defaults.getBoolPref("zen.view.compact.hide-toolbar"),
    "and Zen's own layout defaults are back"
  );

  switchButton().click();
  ok(Services.prefs.getBoolPref(PREF), "another click turns it back on");
  Assert.equal(switchButton().getAttribute("aria-checked"), "true");
  Assert.equal(statusline().style.display, "flex");
  ok(defaults.getBoolPref("zen.view.compact.hide-toolbar"));
});

add_task(async function test_onboarding_looks_like_plain_zen() {
  const root = document.documentElement;
  root.setAttribute("zen-welcome-stage", "true");
  await TestUtils.waitForCondition(
    () => statusline().style.display == "none",
    "no mode indicator during the onboarding"
  );
  ok(!root.hasAttribute("lazyvimium-mode"), "and no mode color");

  gBrowser.selectedBrowser.focus();
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("e");
  await new Promise(resolve => setTimeout(resolve, 300));
  ok(
    !Lazyvimium.explorerFor(window).isOpen,
    "vim mode's keys wait until the onboarding is over"
  );

  root.removeAttribute("zen-welcome-stage");
  await TestUtils.waitForCondition(
    () => statusline().style.display == "flex",
    "the mode indicator comes back after it"
  );
  ok(root.hasAttribute("lazyvimium-mode"));
});

// A click on the switch must leave the keys with vim mode, not with the
// switch: Space after it is <leader>, not another click.
add_task(async function test_clicking_the_switch_leaves_the_keys_to_vim() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<title>switch</title>"
  );
  Services.prefs.setBoolPref(PREF, false);
  EventUtils.synthesizeMouseAtCenter(switchButton(), {});
  await TestUtils.waitForCondition(
    () => Services.prefs.getBoolPref(PREF),
    "the click turns vim mode on"
  );
  isnot(
    document.activeElement,
    switchButton(),
    "the switch does not keep the focus"
  );
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("e");
  await TestUtils.waitForCondition(
    () => Lazyvimium.explorerFor(window).isOpen,
    "<leader>e opens the explorer"
  );
  ok(Services.prefs.getBoolPref(PREF), "and Space left vim mode on");
  Lazyvimium.explorerFor(window).close();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_sidebar_toggle_keeps_the_single_toolbar() {
  const expanded = "zen.view.sidebar-expanded";
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref(expanded);
    Services.prefs.clearUserPref(SINGLE_TOOLBAR);
  });
  Services.prefs.setBoolPref(SINGLE_TOOLBAR, true);
  Services.prefs.setBoolPref(expanded, true);

  await Lazyvimium.run("zen.sidebar.toggle");
  ok(!Services.prefs.getBoolPref(expanded), "the sidebar collapses");
  await Lazyvimium.run("zen.sidebar.toggle");
  ok(Services.prefs.getBoolPref(expanded), "and expands again");
  ok(
    Services.prefs.getBoolPref(SINGLE_TOOLBAR),
    "with the URL bar still in the sidebar"
  );
});

add_task(async function test_layout_reset_returns_to_the_defaults() {
  const prefs = [
    [SINGLE_TOOLBAR, false],
    ["zen.view.compact.hide-tabbar", false],
    ["zen.view.compact.hide-toolbar", false],
    ["zen.view.sidebar-expanded", false],
  ];
  const defaults = Services.prefs.getDefaultBranch("");
  for (const [name, value] of prefs) {
    Services.prefs.setBoolPref(name, value);
  }

  await Lazyvimium.run("zen.layout.reset");
  for (const [name] of prefs) {
    ok(
      !Services.prefs.prefHasUserValue(name),
      `${name} is back to its default`
    );
    Assert.equal(
      Services.prefs.getBoolPref(name),
      defaults.getBoolPref(name),
      `${name} reads its default`
    );
  }
  await TestUtils.waitForCondition(
    () => !document.documentElement.hasAttribute("zen-compact-animating"),
    "compact mode settles"
  );
});
