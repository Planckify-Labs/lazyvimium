/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PAGE = `<body style="height: 6000px; margin: 0">
  <input id="field">
  <p>lazyvimium</p>
</body>`;

async function openPage(body = PAGE) {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," + encodeURIComponent(`<!doctype html>${body}`)
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

function scrollY(browser) {
  return SpecialPowers.spawn(browser, [], () => content.scrollY);
}

function statuslineText() {
  return document.getElementById("lazyvimium-statusline")?.textContent ?? "";
}

add_task(async function test_actor_matches_web_pages() {
  const tab = await openPage();
  ok(
    tab.linkedBrowser.browsingContext.currentWindowGlobal.getActor(
      "LazyvimiumKeys"
    ),
    "the key actor runs in web content processes"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_window_frame_follows_mode() {
  const tab = await openPage();
  const colors = () =>
    ["zen-browser-background", "zen-toolbar-background"]
      .map(id => getComputedStyle(document.getElementById(id), "::after"))
      .map(style => style.backgroundColor)
      .join("|");

  await TestUtils.waitForCondition(
    () => statuslineText().includes("NORMAL"),
    "normal mode"
  );
  is(
    document.documentElement.style.getPropertyValue(
      "--lazyvimium-mode-background"
    ),
    gZenThemePicker.getGradient([{ c: [252, 167, 234] }]),
    "normal mode colors the window through Zen's theme gradient"
  );
  const normal = colors();

  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#field",
    {},
    tab.linkedBrowser
  );
  await TestUtils.waitForCondition(
    () => colors() != normal,
    "the frame and the sidebar change color in insert mode"
  );

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => colors() == normal,
    "<Esc> brings the normal mode color back"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_j_scrolls_an_inner_pane() {
  const tab = await openPage(
    `<body style="margin: 0; overflow: hidden">
       <div id="pane" style="height: 300px; overflow: auto">
         <div style="height: 3000px"></div>
       </div>
     </body>`
  );
  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => content.document.getElementById("pane").scrollTop > 0
      ),
    "j scrolls the pane when the document cannot scroll"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_j_gg_G_scroll() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;

  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    async () => (await scrollY(browser)) > 0,
    "j scrolls down"
  );

  EventUtils.synthesizeKey("G", { shiftKey: true });
  await TestUtils.waitForCondition(
    async () => (await scrollY(browser)) > 3000,
    "G goes to the bottom"
  );

  EventUtils.synthesizeKey("g");
  EventUtils.synthesizeKey("g");
  await TestUtils.waitForCondition(
    async () => (await scrollY(browser)) == 0,
    "gg goes to the top"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_insert_mode_follows_focus() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;

  await BrowserTestUtils.synthesizeMouseAtCenter("#field", {}, browser);
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    "clicking into a text field enters insert mode"
  );

  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        browser,
        [],
        () => content.document.getElementById("field").value == "j"
      ),
    "j types into the field in insert mode"
  );
  is(await scrollY(browser), 0, "and does not scroll");

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("NORMAL"),
    "<Esc> returns to normal mode"
  );
  const focused = await SpecialPowers.spawn(
    browser,
    [],
    () => content.document.activeElement?.id ?? ""
  );
  isnot(focused, "field", "<Esc> leaves the field");

  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    async () => (await scrollY(browser)) > 0,
    "j scrolls again in normal mode"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_unmapped_keys_reach_the_page() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  await SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.seen = [];
    content.addEventListener("keydown", e =>
      content.wrappedJSObject.seen.push(e.key)
    );
  });

  EventUtils.synthesizeKey("q");
  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    async () => (await scrollY(browser)) > 0,
    "j was handled"
  );
  const seen = await SpecialPowers.spawn(browser, [], () =>
    Array.from(content.wrappedJSObject.seen)
  );
  Assert.deepEqual(seen, ["q"], "the page sees q but not j");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_shift_h_l_switch_tabs() {
  const first = await openPage();
  const second = await openPage();
  const tabs = gBrowser.visibleTabs;
  const index = tabs.indexOf(second);
  const previous = tabs[(index - 1 + tabs.length) % tabs.length];

  EventUtils.synthesizeKey("H", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == previous,
    "<S-h> selects the previous visible tab"
  );

  previous.linkedBrowser.focus();
  EventUtils.synthesizeKey("L", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == second,
    "<S-l> comes back"
  );

  BrowserTestUtils.removeTab(first);
  BrowserTestUtils.removeTab(second);
});

add_task(async function test_tab_keys_treat_a_split_as_one_tab() {
  const opened = [];
  for (let i = 0; i < 4; i++) {
    opened.push(await openPage());
  }
  const [left, right] = opened.slice(1, 3);
  gZenViewSplitter.splitTabs([left, right], "vsep", 1);
  await TestUtils.waitForCondition(
    () => right.splitView && gBrowser.selectedTab == right,
    "split"
  );
  const tabs = gBrowser.visibleTabs;
  const first = Math.min(tabs.indexOf(left), tabs.indexOf(right));
  const before = tabs[first - 1];
  const after = tabs[first + 2];
  gBrowser.selectedTab = before;
  before.linkedBrowser.focus();

  const press = async (key, tab, message) => {
    EventUtils.synthesizeKey(key, { shiftKey: true });
    await TestUtils.waitForCondition(
      () => gBrowser.selectedTab == tab,
      message
    );
    tab.linkedBrowser.focus();
  };
  await press("L", right, "<S-l> goes to the split, on the pane used last");
  await press("L", after, "<S-l> again leaves the split for the next tab");
  await press("H", right, "<S-h> comes back to the split");
  await press("H", before, "and <S-h> again skips its other pane");

  pressLeader("`");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == right,
    "<leader>` goes back to the split, on the pane used last"
  );
  right.linkedBrowser.focus();
  EventUtils.synthesizeKey("h", { ctrlKey: true });
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == left,
    "<C-h> moves to the other pane"
  );
  left.linkedBrowser.focus();
  pressLeader("`");
  await TestUtils.waitForCondition(
    () => gBrowser.selectedTab == before,
    "<leader>` leaves the split for the tab before it, not the other pane"
  );

  gZenViewSplitter.unsplitCurrentView();
  for (const tab of opened) {
    BrowserTestUtils.removeTab(tab);
  }
});

// APZ scrolls <Space>, PageDown and the arrows asynchronously unless the
// focused page has a key listener that could cancel them (see
// HasNonPassiveNonSystemGroupListenersForUntrustedKeyEvents). Synthesized
// keys bypass APZ, so check that the page carries such a listener instead.
add_task(async function test_page_keeps_apz_from_scrolling_mapped_keys() {
  const tab = await openPage();
  const hasListener = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    Services.els
      .getListenerInfoFor(content.window)
      .some(
        info =>
          info.type == "keydown" &&
          info.allowsUntrusted &&
          !info.inSystemEventGroup
      )
  );
  ok(hasListener, "APZ sees a key listener on the page and defers to it");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pending_keys_show_in_statusline() {
  const tab = await openPage();
  EventUtils.synthesizeKey("3");
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("b");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("3<Space>b +buffer"),
    "the count, the keys and the which-key group are shown"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !statuslineText().includes("<Space>"),
    "<Esc> clears them"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_slash_opens_find_in_page() {
  const tab = await openPage();
  EventUtils.synthesizeKey("/");
  await TestUtils.waitForCondition(
    () => gBrowser.getCachedFindBar(tab)?.hidden === false,
    "/ opens the find bar"
  );
  gBrowser.getCachedFindBar(tab).close(true);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_leader_comma_lists_tabs() {
  const { UrlbarShared } = ChromeUtils.importESModule(
    "chrome://browser/content/urlbar/UrlbarShared.mjs"
  );
  const tab = await openPage();
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey(",");
  await TestUtils.waitForCondition(
    () => gURLBar.searchMode?.source == UrlbarShared.RESULT_SOURCE.TABS,
    "<leader>, opens the urlbar searching open tabs"
  );
  gURLBar.searchMode = null;
  gURLBar.handleRevert();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_gi_focuses_the_first_input() {
  const tab = await openPage();
  EventUtils.synthesizeKey("g");
  EventUtils.synthesizeKey("i");
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => content.document.activeElement?.id == "field"
      ),
    "gi focuses the input"
  );
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    "and enters insert mode"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_p_opens_the_clipboard_url() {
  const tab = await openPage();
  const url = "https://example.com/browser/";
  SpecialPowers.clipboardCopyString(url);
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  EventUtils.synthesizeKey("p");
  await loaded;
  is(tab.linkedBrowser.currentURI.spec, url, "p opens the clipboard URL here");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_p_refuses_non_web_urls() {
  const tab = await openPage();
  const before = tab.linkedBrowser.currentURI.spec;
  SpecialPowers.clipboardCopyString("javascript:document.title='pwned'");
  EventUtils.synthesizeKey("p");
  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    async () => (await scrollY(tab.linkedBrowser)) > 0,
    "the next key still works"
  );
  is(tab.linkedBrowser.currentURI.spec, before, "nothing was loaded");
  const title = await SpecialPowers.spawn(
    tab.linkedBrowser,
    [],
    () => content.document.title
  );
  isnot(title, "pwned", "the javascript: URL did not run");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_autofocus_does_not_trap_keys_in_insert_mode() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," +
      encodeURIComponent(
        `<!doctype html>
         <body style="height: 6000px">
           <input id="search" autofocus>
           <script>
             window.seen = [];
             addEventListener("keydown", e =>
               seen.push((e.ctrlKey ? "C-" : "") + e.key));
           </script>
         </body>`
      )
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  tab.linkedBrowser.focus();

  await TestUtils.waitForCondition(
    () => statuslineText().includes("NORMAL"),
    "a page focusing a field on load does not put it in insert mode"
  );
  EventUtils.synthesizeKey("k", { accelKey: true });
  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    async () => (await scrollY(tab.linkedBrowser)) > 0,
    "j scrolls, so the page is in normal mode"
  );
  const seen = await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    Array.from(content.wrappedJSObject.seen)
  );
  Assert.deepEqual(
    seen,
    [],
    "<C-k> and j never reach the page, so Firefox's Ctrl+K does not run"
  );

  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.getElementById("search").focus()
  );
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    "focusing the field later still enters insert mode"
  );
  BrowserTestUtils.removeTab(tab);
});

function picker() {
  return document.getElementById("lazyvimium-picker");
}

function pressLeader(keys) {
  EventUtils.synthesizeKey(" ");
  for (const key of keys) {
    EventUtils.synthesizeKey(key);
  }
}

add_task(async function test_split_picker_offers_url_and_tabs() {
  await SpecialPowers.pushPrefEnv({
    set: [["zen.theme.acrylic-urlbar", true]],
  });
  const first = await openPage();
  const second = await openPage();

  pressLeader("|");
  await TestUtils.waitForCondition(() => picker(), "<leader>| opens a picker");
  const rows = [...picker().querySelectorAll(".lazyvimium-picker-item")];
  is(
    rows[0].querySelector(".lazyvimium-picker-label").textContent,
    "Open URL…",
    "the first choice opens the urlbar for the new pane"
  );
  is(rows[0].querySelector(".lazyvimium-picker-key").textContent, "/");
  // Headless runs on software WebRender, where Zen marks the window
  // zen-no-acrylic and keeps its glass opaque; check both states.
  const root = document.documentElement;
  const noAcrylic = root.getAttribute("zen-no-acrylic");
  root.removeAttribute("zen-no-acrylic");
  ok(
    getComputedStyle(picker()).backdropFilter.includes("blur(40px)"),
    "the picker has Zen's glass where Zen has acrylic"
  );
  root.setAttribute("zen-no-acrylic", "true");
  is(
    getComputedStyle(picker()).backdropFilter,
    "none",
    "and stays opaque, like the urlbar, where Zen has none"
  );
  if (noAcrylic === null) {
    root.removeAttribute("zen-no-acrylic");
  }

  const row = rows.find(
    r => r.querySelector(".lazyvimium-picker-label").textContent == first.label
  );
  ok(row, "the other tab is offered");
  EventUtils.synthesizeKey(
    row.querySelector(".lazyvimium-picker-key").textContent
  );
  await TestUtils.waitForCondition(
    () => first.splitView && second.splitView,
    "picking a tab splits it next to the current one"
  );
  ok(!picker(), "the picker is gone");

  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("w");
  EventUtils.synthesizeKey("d");
  await TestUtils.waitForCondition(
    () => !first.splitView && !second.splitView,
    "<leader>wd closes the pane, which unsplits a two-pane split"
  );
  ok(
    gBrowser.tabs.includes(first) && gBrowser.tabs.includes(second),
    "both tabs are still open"
  );

  BrowserTestUtils.removeTab(first);
  BrowserTestUtils.removeTab(second);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_leader_wo_unsplits() {
  const first = await openPage();
  const second = await openPage();
  gZenViewSplitter.splitTabs([second, first], "vsep", 0);
  await TestUtils.waitForCondition(() => second.splitView, "split");
  second.linkedBrowser.focus();

  pressLeader("wo");
  await TestUtils.waitForCondition(
    () => !first.splitView && !second.splitView,
    "<leader>wo leaves only the current pane"
  );
  BrowserTestUtils.removeTab(first);
  BrowserTestUtils.removeTab(second);
});

add_task(async function test_split_divides_only_the_current_pane() {
  const left = await openPage(`<title>left</title>${PAGE}`);
  const right = await openPage(`<title>right</title>${PAGE}`);
  const below = await openPage(`<title>below</title>${PAGE}`);
  gZenViewSplitter.splitTabs([left, right], "vsep", 1);
  await TestUtils.waitForCondition(
    () => right.splitView && gBrowser.selectedTab == right,
    "two panes side by side"
  );
  right.linkedBrowser.focus();

  pressLeader("-");
  await TestUtils.waitForCondition(() => picker(), "<leader>- opens a picker");
  const row = [...picker().querySelectorAll(".lazyvimium-picker-item")].find(
    r => r.querySelector(".lazyvimium-picker-label").textContent == "below"
  );
  EventUtils.synthesizeKey(
    row.querySelector(".lazyvimium-picker-key").textContent
  );
  await TestUtils.waitForCondition(
    () => below.splitView && gBrowser.selectedTab == below,
    "the picked tab joins the split and gets the focus"
  );

  const { layoutTree } = gZenViewSplitter._data[gZenViewSplitter.currentView];
  is(layoutTree.direction, "row", "the panes are still side by side");
  is(layoutTree.children[0].tab, left, "the left pane is untouched");
  const column = layoutTree.children[1];
  is(column.direction, "column", "the right pane is divided");
  Assert.deepEqual(
    column.children.map(node => node.tab),
    [right, below],
    "with the picked tab below the current one"
  );

  gZenViewSplitter.unsplitCurrentView();
  for (const tab of [left, right, below]) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_escape_dismisses_the_picker() {
  const first = await openPage();
  const second = await openPage();
  pressLeader("-");
  await TestUtils.waitForCondition(() => picker(), "<leader>- opens a picker");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !picker(), "<Esc> dismisses it");
  ok(!second.splitView, "nothing was split");

  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    async () => (await scrollY(second.linkedBrowser)) > 0,
    "keys go back to the page"
  );
  BrowserTestUtils.removeTab(first);
  BrowserTestUtils.removeTab(second);
});

add_task(async function test_leader_oh_opens_library_history() {
  const tab = await openPage();
  pressLeader("oh");
  await TestUtils.waitForCondition(() => {
    const library = customElements.get("zen-library");
    return (
      library?.isLibrarySlightlyOpen &&
      document.querySelector("zen-library").activeTab == "history"
    );
  }, "<leader>oh opens the library on History");
  const library = customElements.get("zen-library");
  library.toggle("history");
  await TestUtils.waitForCondition(
    () => !library.isLibrarySlightlyOpen,
    "the library closes again"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_split_open_url_uses_an_empty_pane() {
  const first = await openPage();
  const second = await openPage();
  pressLeader("|");
  await TestUtils.waitForCondition(() => picker(), "the picker opens");
  EventUtils.synthesizeKey("/");
  await TestUtils.waitForCondition(
    () => gURLBar.focused && gZenViewSplitter.currentView >= 0,
    "/ splits with an empty pane and opens the urlbar for it"
  );
  ok(second.splitView, "the current tab is one side of the split");

  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !second.splitView && gZenViewSplitter.currentView < 0,
    "dismissing the urlbar removes the empty pane again"
  );
  BrowserTestUtils.removeTab(first);
  BrowserTestUtils.removeTab(second);
});

const FORM = `<body style="margin: 0; height: 4000px">
  <form>
    <input id="name" style="position: absolute; top: 40px; left: 10px">
    <input id="email" style="position: absolute; top: 40px; left: 300px">
    <input type="checkbox" id="agree" style="position: absolute; top: 90px">
    <textarea id="message" style="position: absolute; top: 140px"></textarea>
    <input id="hidden" style="position: absolute; top: 200px; display: none">
    <input id="below" style="position: absolute; top: 3000px">
  </form>
</body>`;

function focusedField(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.document.activeElement?.id ?? ""
  );
}

async function waitForField(browser, id, message) {
  await TestUtils.waitForCondition(
    async () => (await focusedField(browser)) == id,
    message
  );
}

add_task(async function test_i_and_field_jumps() {
  const tab = await openPage(FORM);
  const browser = tab.linkedBrowser;

  EventUtils.synthesizeKey("i");
  await waitForField(browser, "name", "i enters the top-left visible field");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    "in insert mode"
  );

  EventUtils.synthesizeKey("j", { ctrlKey: true });
  await waitForField(browser, "email", "<C-j> goes right along the row");
  EventUtils.synthesizeKey("j", { ctrlKey: true });
  await waitForField(
    browser,
    "message",
    "then down, skipping checkboxes and hidden fields"
  );
  EventUtils.synthesizeKey("j", { ctrlKey: true });
  await waitForField(browser, "below", "and on to fields below the fold");
  ok((await scrollY(browser)) > 0, "which scrolls them into view");
  EventUtils.synthesizeKey("j", { ctrlKey: true });
  await waitForField(browser, "name", "<C-j> wraps around");
  EventUtils.synthesizeKey("k", { ctrlKey: true });
  await waitForField(browser, "below", "<C-k> goes back");
  EventUtils.synthesizeKey("k", { ctrlKey: true });
  await waitForField(browser, "message", "and back again");
  EventUtils.sendString("hello");

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("NORMAL"),
    "<Esc> leaves the field"
  );
  EventUtils.synthesizeKey("g");
  EventUtils.synthesizeKey("i");
  await waitForField(browser, "message", "gi returns to the last used field");
  const caret = await SpecialPowers.spawn(browser, [], () => {
    const field = content.document.getElementById("message");
    return [field.value, field.selectionStart];
  });
  Assert.deepEqual(caret, ["hello", 5], "with the caret after the text");

  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("]");
  EventUtils.synthesizeKey("i");
  await TestUtils.waitForCondition(
    async () => (await focusedField(browser)) != "",
    "]i jumps to a field from normal mode"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_shift_i_and_i_without_fields_pass_keys() {
  const tab = await openPage(
    `<body style="height: 6000px">
       <script>
         window.seen = [];
         addEventListener("keydown", e => seen.push(e.key));
       </script>
     </body>`
  );
  const browser = tab.linkedBrowser;

  EventUtils.synthesizeKey("i");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    "i on a page without fields still enters insert mode"
  );
  EventUtils.synthesizeKey("j");
  EventUtils.synthesizeKey("KEY_Escape");
  EventUtils.synthesizeKey("I", { shiftKey: true });
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    "I enters insert mode without a field"
  );
  EventUtils.synthesizeKey("k");
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("NORMAL"),
    "<Esc> returns to normal mode"
  );
  const seen = await SpecialPowers.spawn(browser, [], () =>
    Array.from(content.wrappedJSObject.seen)
  );
  Assert.deepEqual(seen, ["j", "k"], "insert mode passes keys to the page");
  is(await scrollY(browser), 0, "and they did not scroll");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_insert_mode_editing_keys() {
  const tab = await openPage(
    `<body>
       <input id="field" value="hello world">
       <script>
         window.inputs = 0;
         document.getElementById("field")
           .addEventListener("input", () => inputs++);
       </script>
     </body>`
  );
  const browser = tab.linkedBrowser;
  const value = () =>
    SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("field").value
    );
  const waitForValue = (expected, message) =>
    TestUtils.waitForCondition(
      async () => (await value()) == expected,
      message
    );

  EventUtils.synthesizeKey("g");
  EventUtils.synthesizeKey("i");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    "in the field"
  );

  EventUtils.synthesizeKey("w", { accelKey: true });
  await waitForValue("hello ", "<C-w> deletes the word before the cursor");
  ok(gBrowser.tabs.includes(tab), "and does not close the tab");

  EventUtils.synthesizeKey("u", { ctrlKey: true });
  await waitForValue("", "<C-u> deletes to the start of the line");

  EventUtils.sendString("abc");
  EventUtils.synthesizeKey("h", { ctrlKey: true });
  await waitForValue("ab", "<C-h> deletes the char before the cursor");

  EventUtils.synthesizeKey("z", { accelKey: true });
  await waitForValue("abc", "the edits are undoable like typing");
  const inputs = await SpecialPowers.spawn(
    browser,
    [],
    () => content.wrappedJSObject.inputs
  );
  ok(inputs >= 3, "the page saw input events for the edits");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_ctrl_w_outside_a_field_still_closes_the_tab() {
  const tab = await openPage();
  const closed = BrowserTestUtils.waitForTabClosing(tab);
  EventUtils.synthesizeKey("w", { accelKey: true });
  await closed;
  ok(!gBrowser.tabs.includes(tab), "Ctrl+W keeps its browser meaning");
});

function whichKey() {
  const popup = document.getElementById("lazyvimium-which-key");
  return popup && !popup.hidden ? popup : null;
}

function whichKeyRows() {
  return [...whichKey().querySelectorAll(".lazyvimium-which-key-item")].map(
    row => [
      row.querySelector(".lazyvimium-which-key-key").textContent,
      row.querySelector(".lazyvimium-which-key-desc").textContent,
    ]
  );
}

add_task(async function test_which_key_popup() {
  await SpecialPowers.pushPrefEnv({ set: [["lazyvimium.timeoutlen", 50]] });
  const tab = await openPage();

  EventUtils.synthesizeKey(" ");
  await TestUtils.waitForCondition(
    () => whichKey(),
    "the popup shows after the leader, though timeoutlen has long passed"
  );
  is(
    whichKey().querySelector(".lazyvimium-which-key-title").textContent,
    "SPC"
  );
  const rows = whichKeyRows();
  ok(
    rows.some(([key, desc]) => key == "e" && desc == "Explorer"),
    "mappings show their desc"
  );
  ok(
    rows.some(([key, desc]) => key == "b" && desc == "+buffer"),
    "groups show their name with a +"
  );
  const firstGroup = rows.findIndex(([, desc]) => desc.startsWith("+"));
  ok(
    rows.slice(firstGroup).every(([, desc]) => desc.startsWith("+")),
    "groups come after mappings, as in which-key"
  );

  EventUtils.synthesizeKey("b");
  await TestUtils.waitForCondition(
    () =>
      whichKey()
        ?.querySelector(".lazyvimium-which-key-title")
        .textContent.includes("+buffer"),
    "the popup follows into the group"
  );
  ok(
    whichKeyRows().some(([key, desc]) => key == "d" && desc == "Delete Tab"),
    "and lists its keys"
  );

  EventUtils.synthesizeKey("KEY_Backspace");
  await TestUtils.waitForCondition(
    () =>
      whichKey()?.querySelector(".lazyvimium-which-key-title").textContent ==
      "SPC",
    "<BS> goes back up one level"
  );

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !whichKey(), "<Esc> closes it");
  BrowserTestUtils.removeTab(tab);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_leader_question_mark_shows_all_keys() {
  const tab = await openPage();
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("?", { shiftKey: true });
  await TestUtils.waitForCondition(
    () =>
      whichKey()?.querySelector(".lazyvimium-which-key-title").textContent ==
      "Keymaps",
    "<leader>? lists every normal mode key"
  );
  ok(
    whichKeyRows().some(([key, desc]) => key == "j" && desc == "Scroll Down"),
    "including plain keys"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => !whichKey(), "the next key closes it");
  BrowserTestUtils.removeTab(tab);
});

async function setCompactMode(value) {
  const settled = () =>
    !document.documentElement.hasAttribute("zen-compact-animating");
  await TestUtils.waitForCondition(settled, "compact mode settles");
  gZenCompactModeManager.preference = value;
  await TestUtils.waitForCondition(
    () => gZenCompactModeManager.preference == value && settled(),
    `compact mode is ${value}`
  );
}

function sidebarShown() {
  return gZenCompactModeManager.isSidebarPotentiallyOpen();
}

add_task(function test_vim_mode_defaults_to_compact_mode_hiding_both() {
  const defaults = Services.prefs.getDefaultBranch("");
  for (const name of [
    "zen.view.compact.enable-at-startup",
    "zen.view.compact.hide-tabbar",
    "zen.view.compact.hide-toolbar",
  ]) {
    ok(defaults.getBoolPref(name), `${name} defaults to true in vim mode`);
  }
});

add_task(async function test_boot_keeps_the_sidebar_hidden_on_the_empty_tab() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["zen.view.compact.enable-at-startup", true],
      ["zen.view.compact.hide-tabbar", true],
      ["zen.view.compact.hide-toolbar", true],
    ],
  });
  const tabsBefore = [...gBrowser.tabs];
  const win = await BrowserTestUtils.openNewBrowserWindow();
  await win.gZenStartup.promiseInitialized;
  const compact = win.gZenCompactModeManager;
  ok(compact.preference, "the window starts in compact mode");
  const firstTab = win.gBrowser.selectedTab;

  // What Zen's selectEmptyTab() does at startup when no other tab is there
  // to show (the function itself is a no-op while testing).
  const emptyTab = win.gZenWorkspaces._emptyTab;
  win.gBrowser.selectedTab = emptyTab;
  await TestUtils.waitForCondition(
    () => win.gBrowser.selectedTab.hasAttribute("zen-empty-tab"),
    "the empty tab is selected"
  );
  await TestUtils.waitForTick();
  ok(
    !compact.isSidebarPotentiallyOpen(),
    "the sidebar stays hidden on the empty tab while booting"
  );

  // A click through the browser window, the way a real one arrives.
  EventUtils.synthesizeMouseAtCenter(win.gBrowser.selectedBrowser, {}, win);
  win.gBrowser.selectedTab = firstTab;
  win.gBrowser.selectedTab = emptyTab;
  await TestUtils.waitForCondition(
    () => compact.sidebar.hasAttribute("zen-has-empty-tab"),
    "after the first click, the empty tab shows the sidebar as Zen does"
  );

  await BrowserTestUtils.closeWindow(win);
  // Zen's window sync mirrors the new window's tabs into this one.
  for (const tab of gBrowser.tabs) {
    if (!tabsBefore.includes(tab) && !tab.hasAttribute("zen-empty-tab")) {
      BrowserTestUtils.removeTab(tab);
    }
  }
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_explorer_close_hides_sidebar_on_empty_tab() {
  const { Lazyvimium } = ChromeUtils.importESModule(
    "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
  );
  const emptyTab = gZenWorkspaces._emptyTab;
  ok(emptyTab, "Zen has an empty tab");
  const tab = await openPage();
  await setCompactMode(true);
  gBrowser.selectedTab = emptyTab;
  const sidebar = gZenCompactModeManager.sidebar;
  await TestUtils.waitForCondition(
    () => sidebar.hasAttribute("zen-has-empty-tab"),
    "Zen keeps the compact sidebar shown on the empty tab"
  );
  ok(sidebarShown(), "which is how it looked stuck");

  await Lazyvimium.run("explorer.toggle");
  ok(Lazyvimium.explorerFor(window).isOpen, "<leader>e opens the explorer");
  await Lazyvimium.run("explorer.toggle");
  ok(!sidebarShown(), "closing it slides the sidebar out all the same");

  gBrowser.selectedTab = tab;
  BrowserTestUtils.removeTab(tab);
  await setCompactMode(false);
});
