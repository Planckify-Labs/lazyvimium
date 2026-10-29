/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);

async function openPage(title) {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," +
      encodeURIComponent(
        `<!doctype html><title>${title}</title><body style="height: 3000px">`
      )
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  return tab;
}

function explorer() {
  return Lazyvimium.explorerFor(window);
}

function statuslineText() {
  return document.getElementById("lazyvimium-statusline")?.textContent ?? "";
}

function press(key, options = {}) {
  EventUtils.synthesizeKey(key, options);
}

function pressLeader(keys) {
  press(" ");
  for (const key of keys) {
    press(key);
  }
}

async function focusPage(tab) {
  tab.linkedBrowser.focus();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.activeElement?.blur();
    content.focus();
  });
}

async function openExplorer(tab) {
  await focusPage(tab);
  pressLeader("e");
  await TestUtils.waitForCondition(
    () => explorer().isOpen,
    "<leader>e opens the explorer"
  );
}

function rowOf(tab) {
  return explorer()
    .rows()
    .findIndex(row => row.tabs.includes(tab));
}

function cursorIndex() {
  const element = explorer().row?.element;
  return explorer()
    .rows()
    .findIndex(row => row.element == element);
}

async function moveCursorTo(tab) {
  const delta = rowOf(tab) - cursorIndex();
  if (delta) {
    for (const digit of String(Math.abs(delta))) {
      press(digit);
    }
    press(delta > 0 ? "j" : "k");
  }
  await TestUtils.waitForCondition(
    () => explorer().row?.tabs.includes(tab),
    "the cursor reaches the tab"
  );
}

function byRow(...tabs) {
  return tabs.sort((a, b) => rowOf(a) - rowOf(b));
}

add_task(async function test_explorer_opens_on_the_current_tab() {
  await openPage("a");
  const tab = await openPage("b");
  await openExplorer(tab);
  ok(statuslineText().includes("EXPLORER"), "the statusline shows it");
  ok(tab.hasAttribute("lazyvimium-cursor"), "the cursor is on the tab");
  is(
    document.activeElement?.id,
    "lazyvimium-explorer-focus",
    "keys go to the sidebar"
  );

  press("q");
  await TestUtils.waitForCondition(() => !explorer().isOpen, "q closes it");
  ok(!tab.hasAttribute("lazyvimium-cursor"), "the cursor is gone");
  ok(statuslineText().includes("NORMAL"), "the page is in normal mode");
  press("j");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(tab.linkedBrowser, [], () => content.scrollY > 0),
    "keys reach the page again"
  );
});

add_task(async function test_explorer_moves_and_opens_tabs() {
  const first = await openPage("first");
  const second = await openPage("second");
  const third = await openPage("third");
  await openExplorer(third);

  press("j");
  press("k");
  ok(third.hasAttribute("lazyvimium-cursor"), "j and k move and come back");

  press("g");
  press("g");
  is(cursorIndex(), 0, "gg goes to the first row");
  press("G");
  is(cursorIndex(), explorer().rows().length - 1, "G to the last");

  await moveCursorTo(second);
  press("o");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == second,
    "o opens the tab"
  );
  ok(explorer().isOpen, "and keeps the explorer open");

  await moveCursorTo(first);
  press("KEY_Enter");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == first && !explorer().isOpen,
    "<CR> opens the tab and closes the explorer"
  );
});

add_task(async function test_explorer_tab_operations() {
  const other = await openPage("other");
  const tab = await openPage("target");
  await openExplorer(tab);

  press("p");
  await TestUtils.waitForCondition(() => tab.pinned, "p pins");
  press("p");
  await TestUtils.waitForCondition(() => !tab.pinned, "p again unpins");

  press("e");
  await TestUtils.waitForCondition(
    () => tab.hasAttribute("zen-essential"),
    "e adds to essentials"
  );
  press("e");
  await TestUtils.waitForCondition(
    () => !tab.hasAttribute("zen-essential"),
    "e again removes from essentials"
  );

  press("M", { shiftKey: true });
  await TestUtils.waitForCondition(() => tab.muted, "M mutes");
  press("M", { shiftKey: true });
  await TestUtils.waitForCondition(() => !tab.muted, "M again unmutes");

  await moveCursorTo(tab);
  await SimpleTest.promiseClipboardChange(
    tab.linkedBrowser.currentURI.spec,
    () => press("y")
  );
  ok(true, "y yanks the URL");

  const newTab = before => gBrowser.tabs.find(t => !before.has(t));
  let before = new Set(gBrowser.tabs);
  press("c");
  await TestUtils.waitForCondition(() => newTab(before), "c duplicates");
  const duplicate = newTab(before);

  await moveCursorTo(other);
  const closed = SessionStore.getClosedTabCountForWindow(window);
  press("d");
  await TestUtils.waitForCondition(
    () => !gBrowser.tabs.includes(other),
    "d closes the tab"
  );
  await TestUtils.waitForCondition(
    () => SessionStore.getClosedTabCountForWindow(window) > closed,
    "the closed tab can be reopened"
  );
  before = new Set(gBrowser.tabs);
  press("u");
  await TestUtils.waitForCondition(() => newTab(before), "u reopens it");
  const reopened = newTab(before);

  explorer().close();
  BrowserTestUtils.removeTab(reopened);
  BrowserTestUtils.removeTab(duplicate);
});

add_task(async function test_explorer_visual_and_picked_selections() {
  const [a, b, c] = byRow(
    await openPage("v1"),
    await openPage("v2"),
    await openPage("v3")
  );
  await openExplorer(a);
  await moveCursorTo(a);

  press("V", { shiftKey: true });
  ok(statuslineText().includes("VISUAL"), "V enters visual mode");
  press("2");
  press("j");
  ok(
    [a, b, c].every(tab => tab.hasAttribute("lazyvimium-selected")),
    "j extends the selection"
  );
  press("M", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => [a, b, c].every(tab => tab.muted),
    "an operation applies to every selected row"
  );
  ok(statuslineText().includes("EXPLORER"), "and leaves visual mode");

  await moveCursorTo(a);
  press("KEY_Tab");
  press("j");
  press("KEY_Tab");
  ok(
    a.hasAttribute("lazyvimium-selected") &&
      !b.hasAttribute("lazyvimium-selected") &&
      c.hasAttribute("lazyvimium-selected"),
    "<Tab> picks single rows"
  );
  press("KEY_Escape");
  ok(
    !a.hasAttribute("lazyvimium-selected") && explorer().isOpen,
    "<Esc> drops the selection first"
  );
  await moveCursorTo(a);
  press("V", { shiftKey: true });
  press("j");
  press("d");
  await TestUtils.waitForCondition(
    () => !gBrowser.tabs.includes(a) && !gBrowser.tabs.includes(b),
    "d closes the selected rows"
  );
  ok(gBrowser.tabs.includes(c), "and only those");
  press("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !explorer().isOpen,
    "<Esc> without a selection closes the explorer"
  );
});

add_task(async function test_explorer_jump_labels() {
  const target = await openPage("jump");
  const tab = await openPage("start");
  await openExplorer(tab);
  press("s");
  const host = target.querySelector(".tab-content");
  await TestUtils.waitForCondition(
    () => host.hasAttribute("lazyvimium-hint"),
    "s labels the rows"
  );
  for (const key of host.getAttribute("lazyvimium-hint")) {
    press(key);
  }
  await TestUtils.waitForCondition(
    () => explorer().row?.tabs.includes(target),
    "typing a label moves the cursor there"
  );
  ok(!host.hasAttribute("lazyvimium-hint"), "and the labels go away");
  explorer().close();
});

add_task(async function test_explorer_m_opens_the_tab_menu() {
  const target = await openPage("menu");
  const tab = await openPage("start");
  await openExplorer(tab);
  await moveCursorTo(target);
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  press("m");
  await shown;
  is(TabContextMenu.contextTab, target, "the menu is for the cursor's tab");

  press("j");
  await TestUtils.waitForCondition(
    () => menu.querySelector("[_moz-menuactive]"),
    "j moves through the menu"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  press("KEY_Escape");
  await hidden;
  ok(explorer().isOpen, "the explorer stays open behind the menu");
  explorer().close();
});

add_task(async function test_explorer_folders() {
  const inside = await openPage("inside");
  const second = await openPage("second inside");
  const tab = await openPage("outside");
  const folder = gZenFolders.createFolder([inside, second]);
  await TestUtils.waitForCondition(
    () => inside.group == folder && second.group == folder,
    "the folder holds both tabs"
  );
  await openExplorer(tab);

  await moveCursorTo(inside);
  press("z");
  press("c");
  await TestUtils.waitForCondition(() => folder.collapsed, "zc closes it");
  is(explorer().row?.element, folder, "and puts the cursor on the folder");
  press("z");
  press("o");
  await TestUtils.waitForCondition(() => !folder.collapsed, "zo opens it");

  await moveCursorTo(inside);
  press("h");
  await TestUtils.waitForCondition(
    () => folder.collapsed,
    "h closes the folder a tab is in"
  );
  press("l");
  await TestUtils.waitForCondition(
    () => !folder.collapsed,
    "l on a folder opens it"
  );

  await moveCursorTo(second);
  press("<");
  await TestUtils.waitForCondition(
    () => second.group != folder,
    "< takes the tab out of the folder"
  );

  explorer().close();
  await folder.delete();
});

add_task(async function test_explorer_moves_tabs_into_folders() {
  const member = await openPage("member");
  const tab = await openPage("loose");
  const folder = gZenFolders.createFolder([member]);
  await TestUtils.waitForCondition(() => member.group == folder, "folder");
  folder.label = "Reading";
  await openExplorer(tab);
  await moveCursorTo(tab);

  press(">");
  await TestUtils.waitForCondition(
    () => document.getElementById("lazyvimium-picker"),
    "> asks which folder"
  );
  const row = [...document.querySelectorAll(".lazyvimium-picker-item")].find(
    item =>
      item.querySelector(".lazyvimium-picker-label").textContent == "Reading"
  );
  press(row.querySelector(".lazyvimium-picker-key").textContent);
  await TestUtils.waitForCondition(
    () => tab.group == folder,
    "picking a folder moves the tab into it"
  );
  ok(explorer().isOpen, "the explorer stays open");

  const folders = gZenFolders.activeSpaceFolders.length;
  press("A", { shiftKey: true });
  await TestUtils.waitForCondition(
    () =>
      gZenFolders.activeSpaceFolders.length == folders + 1 &&
      document.documentElement.getAttribute("zen-renaming-tab") == "true",
    "A makes a new folder and names it"
  );
  const created = explorer().row?.element;
  press("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !document.documentElement.hasAttribute("zen-renaming-tab"),
    "<Esc> keeps the default name"
  );
  ok(explorer().isOpen, "and the explorer stays open");

  explorer().close();
  await folder.delete();
  if (created?.isZenFolder) {
    await created.delete();
  }
});

add_task(async function test_leader_be_toggles_essentials_from_the_page() {
  const tab = await openPage("essential");
  await focusPage(tab);
  pressLeader("be");
  await TestUtils.waitForCondition(
    () => tab.hasAttribute("zen-essential"),
    "<leader>be adds the current tab to essentials"
  );
  await focusPage(tab);
  pressLeader("be");
  await TestUtils.waitForCondition(
    () => !tab.hasAttribute("zen-essential"),
    "and removes it again"
  );
});

add_task(async function test_leader_tab_r_renames_the_space() {
  const tab = await openPage("space");
  await focusPage(tab);
  press(" ");
  press("KEY_Tab");
  press("r");
  await TestUtils.waitForCondition(
    () => document.documentElement.getAttribute("zen-renaming-tab") == "true",
    "<leader><tab>r renames the space in the sidebar"
  );
  ok(explorer().isOpen, "with the sidebar on screen");
  press("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !explorer().isOpen,
    "which goes away once the name is set or dropped"
  );
});

add_task(async function test_explorer_alt_j_moves_a_row() {
  const [upper, lower] = byRow(await openPage("m1"), await openPage("m2"));
  await openExplorer(upper);
  await moveCursorTo(upper);
  press("j", { altKey: true });
  await TestUtils.waitForCondition(
    () => rowOf(upper) > rowOf(lower),
    "<A-j> moves the tab down past the next one"
  );
  ok(explorer().row?.tabs.includes(upper), "and the cursor goes with it");
  press("k", { altKey: true });
  await TestUtils.waitForCondition(
    () => rowOf(upper) < rowOf(lower),
    "<A-k> moves it back up"
  );
  explorer().close();
});

add_task(async function test_explorer_ctrl_v_splits_with_the_cursor_tab() {
  const other = await openPage("split");
  const tab = await openPage("current");
  await openExplorer(tab);
  await moveCursorTo(other);
  press("v", { ctrlKey: true });
  await TestUtils.waitForCondition(
    () => tab.splitView && other.splitView && !explorer().isOpen,
    "<C-v> splits the current tab with the cursor's"
  );
  gZenViewSplitter.unsplitCurrentView();
});

add_task(async function test_explorer_r_renames_a_tab() {
  const tab = await openPage("before");
  await openExplorer(tab);
  press("r");
  await TestUtils.waitForCondition(
    () => document.documentElement.getAttribute("zen-renaming-tab") == "true",
    "r starts renaming"
  );
  EventUtils.sendString("after");
  press("KEY_Enter");
  await TestUtils.waitForCondition(
    () => tab.label.endsWith("after"),
    "the typed name is set"
  );
  is(
    document.activeElement?.id,
    "lazyvimium-explorer-focus",
    "keys come back to the explorer"
  );
  explorer().close();
});

add_task(async function test_explorer_keeps_leader_keys() {
  const tab = await openPage("leader");
  await openExplorer(tab);
  press(" ");
  press("b");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("+buffer"),
    "<leader>b is the buffer group in the explorer too"
  );
  press("KEY_Escape");
  ok(explorer().isOpen, "<Esc> drops the pending keys first");
  pressLeader("e");
  await TestUtils.waitForCondition(
    () => !explorer().isOpen,
    "<leader>e closes the explorer"
  );
});

add_task(async function test_explorer_colors_the_window_blue() {
  const tab = await openPage("blue");
  await openExplorer(tab);
  is(
    document.documentElement.style.getPropertyValue(
      "--lazyvimium-mode-background"
    ),
    gZenThemePicker.getGradient([{ c: [130, 170, 255] }]),
    "the frame takes the explorer's color"
  );
  explorer().close();
});

add_task(async function test_leader_bj_picks_a_tab_from_the_page() {
  const target = await openPage("picked");
  const tab = await openPage("page");
  await focusPage(tab);
  pressLeader("bj");
  const host = target.querySelector(".tab-content");
  await TestUtils.waitForCondition(
    () => host.hasAttribute("lazyvimium-hint"),
    "<leader>bj labels the tabs"
  );
  for (const key of host.getAttribute("lazyvimium-hint")) {
    press(key);
  }
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == target && !explorer().isOpen,
    "typing a label selects that tab and puts the sidebar away"
  );
});

add_task(async function test_leader_bm_opens_the_menu_of_the_current_tab() {
  const tab = await openPage("menu page");
  await focusPage(tab);
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  pressLeader("bm");
  await shown;
  is(TabContextMenu.contextTab, tab, "the menu is for the current tab");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  press("KEY_Escape");
  await hidden;
  await TestUtils.waitForCondition(
    () => !explorer().isOpen,
    "the sidebar is put away with the menu"
  );
});

function toolbar() {
  return Lazyvimium.toolbarFor(window);
}

async function openToolbar(tab) {
  await focusPage(tab);
  pressLeader("m");
  await TestUtils.waitForCondition(
    () => toolbar().isOpen && toolbar().item,
    "<leader>m puts a cursor on the toolbar"
  );
}

// Zen's single toolbar layout keeps the buttons at the top of the sidebar;
// the other one in a bar above the page.
async function setSingleToolbar(single) {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.view.use-single-toolbar", single]],
  });
  await TestUtils.waitForCondition(
    () => document.documentElement.hasAttribute("zen-single-toolbar") == single,
    `the ${single ? "single" : "multiple"} toolbar layout`
  );
}

add_task(async function test_leader_m_moves_through_the_toolbar() {
  for (const single of [true, false]) {
    await setSingleToolbar(single);
    await checkToolbarMoves();
    await SpecialPowers.popPrefEnv();
  }
});

async function checkToolbarMoves() {
  const tab = await openPage("toolbar");
  await openToolbar(tab);
  ok(statuslineText().includes("TOOLBAR"), "the statusline shows it");
  is(toolbar().item, PanelUI.menuButton, "starting on the main menu button");
  ok(
    PanelUI.menuButton.hasAttribute("lazyvimium-cursor"),
    "which shows the cursor"
  );

  const items = toolbar().items();
  ok(items.length > 2, "the toolbar has buttons to move through");
  press("0");
  is(toolbar().item, items[0], "0 goes to the first item");
  press("l");
  is(toolbar().item, items[1], "l moves right");
  press("h");
  is(toolbar().item, items[0], "h moves left");
  press("$");
  is(toolbar().item, items.at(-1), "$ goes to the last");

  press("s");
  const target = items[1];
  await TestUtils.waitForCondition(
    () => target.hasAttribute("lazyvimium-hint"),
    "s labels the items"
  );
  for (const key of target.getAttribute("lazyvimium-hint")) {
    press(key);
  }
  await TestUtils.waitForCondition(
    () => toolbar().item == target,
    "typing a label moves the cursor there"
  );

  press("q");
  await TestUtils.waitForCondition(() => !toolbar().isOpen, "q closes it");
  ok(!target.hasAttribute("lazyvimium-cursor"), "the cursor is gone");
  ok(statuslineText().includes("NORMAL"), "the page is in normal mode");
  BrowserTestUtils.removeTab(tab);
}

add_task(async function test_toolbar_i_edits_the_address() {
  const tab = await openPage("address");
  await openToolbar(tab);
  press("i");
  await TestUtils.waitForCondition(
    () => gURLBar.focused && !toolbar().isOpen,
    "i puts the keys in the urlbar"
  );
  gURLBar.blur();
  await focusPage(tab);
});

add_task(async function test_main_menu_with_vim_keys() {
  const tab = await openPage("app menu");
  await openToolbar(tab);
  const shown = BrowserTestUtils.waitForEvent(PanelUI.panel, "popupshown");
  press("KEY_Enter");
  await shown;
  ok(!toolbar().isOpen, "pressing the menu button leaves the toolbar");

  press("j");
  await TestUtils.waitForCondition(
    () => PanelUI.panel.contains(document.activeElement),
    "j moves into the menu's items"
  );
  const first = document.activeElement;
  press("j");
  await TestUtils.waitForCondition(
    () => document.activeElement != first,
    "and j again to the next one"
  );
  press("k");
  await TestUtils.waitForCondition(
    () => document.activeElement == first,
    "k goes back up"
  );
  const hidden = BrowserTestUtils.waitForEvent(PanelUI.panel, "popuphidden");
  press("q");
  await hidden;
});

add_task(async function test_toolbar_m_opens_a_button_menu() {
  const tab = await openPage("button menu");
  await openToolbar(tab);
  const menu = document.getElementById("toolbar-context-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  press("m");
  await shown;
  ok(toolbar().isOpen, "the toolbar stays behind the menu");
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  press("KEY_Escape");
  await hidden;
  press("q");
  await TestUtils.waitForCondition(() => !toolbar().isOpen, "q closes it");
});

add_task(async function test_page_context_menu_takes_vim_keys() {
  const tab = await openPage("context menu");
  await focusPage(tab);
  const menu = document.getElementById("contentAreaContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouse(
    "body",
    20,
    20,
    { type: "contextmenu", button: 2 },
    tab.linkedBrowser
  );
  await shown;
  press("j");
  await TestUtils.waitForCondition(
    () => menu.querySelector("[_moz-menuactive]"),
    "j moves through a page's context menu"
  );
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  press("q");
  await hidden;
  is(
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.scrollY),
    0,
    "and the page never got the j"
  );
});

add_task(async function test_mode_indicator_stays_clear_of_the_sidebar() {
  const statusline = document.getElementById("lazyvimium-statusline");
  for (const right of [false, true]) {
    await SpecialPowers.pushPrefEnv({
      set: [["zen.tabs.vertical.right-side", right]],
    });
    await TestUtils.waitForCondition(
      () => document.documentElement.hasAttribute("zen-right-side") == right,
      `the sidebar is on the ${right ? "right" : "left"}`
    );
    const sidebar = gNavToolbox.getBoundingClientRect();
    const box = statusline.getBoundingClientRect();
    ok(
      box.right <= sidebar.left || box.left >= sidebar.right,
      `with the sidebar on the ${right ? "right" : "left"}, the mode indicator is beside it, not over it`
    );
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_explorer_and_toolbar_take_turns() {
  const tab = await openPage("turns");
  await openExplorer(tab);
  pressLeader("m");
  await TestUtils.waitForCondition(
    () => toolbar().isOpen && !explorer().isOpen,
    "<leader>m in the explorer moves to the toolbar"
  );
  pressLeader("e");
  await TestUtils.waitForCondition(
    () => explorer().isOpen && !toolbar().isOpen,
    "and <leader>e back"
  );
  explorer().close();
});
