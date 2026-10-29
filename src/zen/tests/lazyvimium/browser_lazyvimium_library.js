/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

async function openPage(title) {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," +
      encodeURIComponent(`<!doctype html><title>${title}</title>`)
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  tab.linkedBrowser.focus();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.activeElement?.blur();
    content.focus();
  });
  return tab;
}

function view() {
  return Lazyvimium.libraryFor(window);
}

function libraryClass() {
  return customElements.get("zen-library");
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

async function openLibrary(keys) {
  pressLeader(keys);
  await TestUtils.waitForCondition(
    () => view().isOpen && libraryClass().libraryProgress === 1,
    `<leader>${keys} opens the library mode`
  );
}

async function whenClosed() {
  await TestUtils.waitForCondition(
    () => !libraryClass().isLibrarySlightlyOpen && !view().isOpen,
    "the library closes"
  );
}

registerCleanupFunction(async () => {
  await PlacesUtils.history.clear();
  if (libraryClass()?.isLibrarySlightlyOpen) {
    libraryClass().close();
    await whenClosed();
  }
});

add_task(async function test_history_opens_in_its_search_box() {
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits([
    { uri: "https://example.com/one", title: "one" },
    { uri: "https://example.com/two", title: "two" },
    { uri: "https://example.com/three", title: "three" },
  ]);
  const tab = await openPage("history");
  await openLibrary("oh");
  await TestUtils.waitForCondition(
    () => view().inserting,
    "the search box takes the keys"
  );
  ok(statuslineText().includes("INSERT"), "as insert mode");
  await TestUtils.waitForCondition(
    () =>
      view().section?.querySelectorAll(".zen-library-row").length >= 3 &&
      view().item,
    "the visits are listed with a cursor on the first"
  );
  const rows = [...view().section.querySelectorAll(".zen-library-row")];
  is(view().item, rows[0], "the cursor starts at the top");

  press("j", { ctrlKey: true });
  is(view().item, rows[1], "<C-j> moves down while typing");
  ok(view().inserting, "and the keys stay in the search box");
  press("k", { ctrlKey: true });
  is(view().item, rows[0], "<C-k> moves back up");

  press("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !view().inserting && statuslineText().includes("LIBRARY"),
    "<Esc> moves the keys to the list"
  );
  ok(view().isOpen, "the library stays open");
  ok(rows[0].hasAttribute("lazyvimium-cursor"), "which shows the cursor");
  press("j");
  press("j");
  is(view().item, rows[2], "j moves down the list");
  press("g");
  press("g");
  is(view().item, rows[0], "gg goes to the top");
  press("G");
  is(view().item, rows.at(-1), "G to the bottom");

  press("i");
  await TestUtils.waitForCondition(
    () => view().inserting,
    "i goes back to the search box"
  );
  press("KEY_Escape");
  await TestUtils.waitForCondition(() => !view().inserting, "and <Esc> out");

  press("q");
  await whenClosed();
  ok(statuslineText().includes("NORMAL"), "the page is in normal mode");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_y_and_d_on_a_visit() {
  await PlacesUtils.history.clear();
  await PlacesTestUtils.addVisits([
    { uri: "https://example.com/yank", title: "yank" },
    { uri: "https://example.com/forget", title: "forget" },
  ]);
  const tab = await openPage("yank");
  await openLibrary("oh");
  await TestUtils.waitForCondition(
    () => view().section?.querySelectorAll(".zen-library-row").length >= 2,
    "the visits are listed"
  );
  press("KEY_Escape");
  await TestUtils.waitForCondition(() => !view().inserting, "in the list");

  const title = view().item.querySelector(".zen-library-row-title");
  const url = `https://example.com/${title.textContent}`;
  await SimpleTest.promiseClipboardChange(url, () => press("y"));
  ok(true, "y yanks the visit's address");

  const count = view().section.querySelectorAll(".zen-library-row").length;
  press("d");
  await TestUtils.waitForCondition(
    async () => !(await PlacesUtils.history.fetch(url)),
    "d forgets the visit"
  );
  await TestUtils.waitForCondition(
    () => view().section.querySelectorAll(".zen-library-row").length < count,
    "which leaves the list"
  );
  ok(view().item, "the cursor stays on the list");

  press("q");
  await whenClosed();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_sections_and_spaces() {
  const tab = await openPage("spaces");
  await openLibrary("oh");
  press("KEY_Escape");
  await TestUtils.waitForCondition(() => !view().inserting, "in the list");

  press("g");
  press("s");
  await TestUtils.waitForCondition(
    () =>
      view().sectionId == "spaces" &&
      view().item?.classList.contains("zen-library-space-header"),
    "gs goes to Spaces with the cursor on the first space"
  );
  ok(!view().inserting, "which has no search box to type in");
  ok(statuslineText().includes("LIBRARY"), "so its list takes the keys");

  const header = view().item;
  press("l");
  await TestUtils.waitForCondition(
    () => view().item != header,
    "l moves to the next space, or the button that adds one"
  );
  press("h");
  is(view().item, header, "h moves back");

  const sections = [
    ...document.querySelectorAll("zen-library .zen-library-tab"),
  ].map(tab => tab.dataset.section);
  const next = sections[(sections.indexOf("spaces") + 1) % sections.length];
  press("KEY_Tab");
  await TestUtils.waitForCondition(
    () => view().sectionId == next,
    "<Tab> goes to the next section of the rail"
  );
  await TestUtils.waitForCondition(
    () => !view().inserting && view().item,
    "with the keys in its list"
  );
  press("KEY_Tab", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => view().sectionId == "spaces",
    "<S-Tab> back"
  );

  press("KEY_Enter");
  await whenClosed();
  ok(true, "<CR> on a space switches to it and closes the library");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_a_click_on_the_page_hands_it_the_keys() {
  const tab = await openPage("click");
  await openLibrary("oh");
  EventUtils.synthesizeMouseAtCenter(tab.linkedBrowser, {});
  await TestUtils.waitForCondition(
    () => !view().isOpen,
    "a click on the page leaves the library mode"
  );
  ok(libraryClass().isLibraryOpen, "the library stays open");
  libraryClass().close();
  await whenClosed();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_tab_switches_sections_while_searching() {
  const tab = await openPage("tab");
  await openLibrary("oh");
  await TestUtils.waitForCondition(() => view().inserting, "in the search");
  const sections = [
    ...document.querySelectorAll("zen-library .zen-library-tab"),
  ].map(railTab => railTab.dataset.section);
  const next = sections[(sections.indexOf("history") + 1) % sections.length];
  press("KEY_Tab");
  await TestUtils.waitForCondition(
    () => view().sectionId == next,
    "<Tab> in the search box goes to the next section"
  );
  press("KEY_Tab", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => view().sectionId == "history" && view().inserting,
    "<S-Tab> back, to its search box"
  );
  press("KEY_Escape");
  press("q");
  await whenClosed();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_explorer_reaches_the_sidebar_foot() {
  const tab = await openPage("foot");
  pressLeader("e");
  const explorer = Lazyvimium.explorerFor(window);
  await TestUtils.waitForCondition(() => explorer.isOpen, "the explorer");
  const create = document.getElementById("zen-create-new-button");
  const buttons = explorer.footerButtons();
  ok(buttons.includes(create), "the + button is at the foot");

  press("G");
  const last = explorer.row;
  press("j");
  ok(explorer.onFooter, "j past the last row reaches the foot");
  ok(
    explorer.footerButton.hasAttribute("lazyvimium-cursor"),
    "which shows the cursor on its button"
  );
  const others = [...document.querySelectorAll("[lazyvimium-cursor]")].filter(
    element => element != explorer.footerButton
  );
  is(
    others
      .map(element => `${element.localName}#${element.id}.${element.className}`)
      .join(),
    "",
    "and nowhere else"
  );
  for (let i = 0; i < buttons.length; i++) {
    press("l");
  }
  is(explorer.footerButton, buttons.at(-1), "l moves right to the last one");
  press("h");
  is(explorer.footerButton, buttons.at(-2) ?? buttons[0], "h moves left");
  for (let i = 0; i < buttons.length && explorer.footerButton != create; i++) {
    press("l");
  }
  is(explorer.footerButton, create, "the cursor reaches the + button");

  const popup = document.getElementById("zenCreateNewPopup");
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  press("KEY_Enter");
  await shown;
  ok(explorer.isOpen, "<CR> opens the + menu over the explorer");
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  press("q");
  await hidden;

  press("k");
  ok(!explorer.onFooter, "k goes back up");
  is(explorer.row?.element, last.element, "to the last row");
  ok(!create.hasAttribute("lazyvimium-cursor"), "leaving the button");

  press("q");
  await TestUtils.waitForCondition(() => !explorer.isOpen, "q closes it");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_explorer_plus_opens_the_create_menu() {
  const tab = await openPage("plus");
  pressLeader("e");
  const explorer = Lazyvimium.explorerFor(window);
  await TestUtils.waitForCondition(() => explorer.isOpen, "the explorer");
  const popup = document.getElementById("zenCreateNewPopup");
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  press("+");
  await shown;
  ok(true, "+ opens the create menu");
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  press("q");
  await hidden;
  press("q");
  await TestUtils.waitForCondition(() => !explorer.isOpen, "q closes it");
  BrowserTestUtils.removeTab(tab);
});
