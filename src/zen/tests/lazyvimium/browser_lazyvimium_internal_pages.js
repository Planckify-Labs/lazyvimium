/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function statuslineText() {
  return document.getElementById("lazyvimium-statusline")?.textContent ?? "";
}

function type(keys) {
  for (const key of keys) {
    EventUtils.synthesizeKey(key, { shiftKey: key != key.toLowerCase() });
  }
}

// How far the page, or the pane it scrolls in, is scrolled.
const scrolled = browser =>
  SpecialPowers.spawn(browser, [], () => {
    let most = content.scrollY;
    for (const element of content.document.querySelectorAll("*")) {
      most = Math.max(most, element.scrollTop);
    }
    return most;
  });

// The labels `s` puts on the page.
const labelsShown = browser =>
  SpecialPowers.spawn(
    browser,
    [],
    () =>
      [...content.document.documentElement.querySelectorAll("div > span")]
        .map(span => span.textContent)
        .filter(text => text && !text.includes(" ")).length
  );

async function focusPage(browser) {
  browser.focus();
  await SpecialPowers.spawn(browser, [], () => {
    content.document.activeElement?.blur();
    content.focus();
  });
}

// Keys that need no room to scroll: modes and jump labels.
async function checkModesAndLabels(browser, label) {
  await focusPage(browser);
  type("i");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    `${label}: i is insert mode`
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("NORMAL"),
    `${label}: <Esc> is normal mode`
  );
  type("s");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(browser)) > 0,
    `${label}: s labels the controls`
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    async () => !(await labelsShown(browser)),
    `${label}: <Esc> drops the labels`
  );
}

// Visual mode labels the words on screen to put the cursor on one.
async function checkVisual(browser, label) {
  await focusPage(browser);
  type("v");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(browser)) > 0,
    `${label}: v labels the words`
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    async () => !(await labelsShown(browser)),
    `${label}: <Esc> drops the labels`
  );
}

async function checkScrolling(browser, label) {
  await focusPage(browser);
  // Some pages fill in after they load.
  await TestUtils.waitForCondition(async () => {
    type("G");
    return (await scrolled(browser)) > 0;
  }, `${label}: G scrolls`);
  type("gg");
  await TestUtils.waitForCondition(
    async () => (await scrolled(browser)) == 0,
    `${label}: gg scrolls back`
  );
}

async function inTab(url, check) {
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  try {
    await check(tab.linkedBrowser, url);
    ok(true, `${url} takes the keys`);
  } catch (e) {
    ok(false, `${url}: ${e}`);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

add_task(async function test_keys_work_on_internal_pages() {
  for (const url of [
    "about:preferences",
    "about:addons",
    "about:config",
    "about:support",
    "about:about",
  ]) {
    await inTab(url, checkModesAndLabels);
    await inTab(url, checkVisual);
  }
  // These are longer than the window.
  for (const url of ["about:preferences", "about:support"]) {
    await inTab(url, checkScrolling);
  }
});

add_task(async function test_keys_reach_into_shadow_roots() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," +
      encodeURIComponent(`<!doctype html>
        <body style="font: 20px sans-serif">
          <p>light words</p><div id="open"></div><div id="closed"></div>
          <script>
            for (const [id, mode, text] of [
              ["open", "open", "shadow words"],
              ["closed", "closed", "hidden words"],
            ]) {
              const root = document.getElementById(id).attachShadow({ mode });
              root.innerHTML = "<p>" + text + "</p><button>" + id + "</button>";
            }
          </script>
        </body>`)
  );
  const browser = tab.linkedBrowser;
  await focusPage(browser);

  type("s");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(browser)) == 2,
    "s labels the buttons in shadow roots, closed ones too"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    async () => !(await labelsShown(browser)),
    "<Esc> drops the labels"
  );

  type("v");
  // Three paragraphs and six words.
  await TestUtils.waitForCondition(
    async () => (await labelsShown(browser)) >= 9,
    "v labels the words in shadow roots"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    async () => !(await labelsShown(browser)),
    "<Esc> drops the labels"
  );

  // Only the closed root has "hidd".
  type("S");
  type("hidd");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(browser)) == 1,
    "S finds a word in a closed shadow root"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_keys_work_on_extension_pages() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { options_ui: { page: "page.html", open_in_tab: true } },
    files: {
      "page.html": `<!doctype html><meta charset="utf-8">
        <body><button>options</button><div style="height: 4000px"></div></body>`,
    },
  });
  await extension.startup();
  const url = `moz-extension://${extension.uuid}/page.html`;
  await inTab(url, checkModesAndLabels);
  await inTab(url, checkScrolling);
  await extension.unload();
});

// A page that is long, with text, a control and a field.
const PARITY_PAGE = `<!doctype html><meta charset="utf-8">
  <body style="margin: 0; font: 20px sans-serif">
    <p id="words">alpha beta gamma</p>
    <button>Press</button> <input id="field">
    <div style="height: 6000px"></div>
  </body>`;

// The scroll once a key has moved it away from where it was, and stopped.
async function scrollAfter(browser, press, before, label) {
  press();
  await TestUtils.waitForCondition(
    async () => (await scrolled(browser)) != before,
    `${label}: scrolls`
  );
  let last = -1;
  await TestUtils.waitForCondition(async () => {
    const now = await scrolled(browser);
    const same = now === last;
    last = now;
    return same;
  }, `${label}: stops scrolling`);
  return last;
}

// Every scrolling key, as on a regular page.
async function checkScrollKeys(browser, label) {
  await focusPage(browser);
  let at = await scrolled(browser);
  for (const [name, press] of [
    ["j", () => type("j")],
    ["<C-d>", () => EventUtils.synthesizeKey("d", { ctrlKey: true })],
    ["<C-f>", () => EventUtils.synthesizeKey("f", { ctrlKey: true })],
  ]) {
    const next = await scrollAfter(browser, press, at, `${label} ${name}`);
    Assert.greater(next, at, `${label}: ${name} scrolls down`);
    at = next;
  }
  for (const [name, press] of [
    ["k", () => type("k")],
    ["<C-u>", () => EventUtils.synthesizeKey("u", { ctrlKey: true })],
    ["<C-b>", () => EventUtils.synthesizeKey("b", { ctrlKey: true })],
  ]) {
    const next = await scrollAfter(browser, press, at, `${label} ${name}`);
    Assert.less(next, at, `${label}: ${name} scrolls up`);
    at = next;
  }
  at = await scrollAfter(browser, () => type("G"), at, `${label} G`);
  Assert.greater(at, 1000, `${label}: G goes to the bottom`);
  at = await scrollAfter(browser, () => type("gg"), at, `${label} gg`);
  Assert.less(at, 5, `${label}: gg goes to the top`);
}

const labelTexts = browser =>
  SpecialPowers.spawn(browser, [], () =>
    [...content.document.documentElement.querySelectorAll("div > span")]
      .map(span => span.textContent)
      .filter(text => text && !text.includes(" "))
  );

// Labels, then text jumps, visual motions and a yank into the ring.
async function checkVisualKeys(browser, label, { isPopup = false } = {}) {
  await focusPage(browser);
  if (isPopup) {
    // A popup's labels are always on, and <Esc> closes it as it does any
    // other: typing a label presses its control.
    await TestUtils.waitForCondition(
      async () => (await labelsShown(browser)) > 0,
      `${label}: the controls have labels`
    );
    type((await labelTexts(browser))[0]);
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(
          browser,
          [],
          () => content.document.title == "pressed"
        ),
      `${label}: a label presses its control`
    );
  } else {
    for (const keys of ["s", "v"]) {
      type(keys);
      await TestUtils.waitForCondition(
        async () => (await labelsShown(browser)) > 0,
        `${label}: ${keys} shows labels`
      );
      EventUtils.synthesizeKey("KEY_Escape");
      await TestUtils.waitForCondition(
        async () => !(await labelsShown(browser)),
        `${label}: <Esc> drops them`
      );
    }
    // The labels went, visual mode stays until the next <Esc>.
    EventUtils.synthesizeKey("KEY_Escape");
  }

  const { yankRing } = ChromeUtils.importESModule(
    "resource:///modules/lazyvimium/plugins/LazyvimiumYank.sys.mjs"
  );
  (await yankRing({ persist: false })).clear();
  // A popup has labels of its own already.
  const before = await labelTexts(browser);
  type("Salph");
  await TestUtils.waitForCondition(
    async () => (await labelTexts(browser)).length == before.length + 1,
    `${label}: S labels the word`
  );
  const fresh = [...(await labelTexts(browser))];
  for (const old of before) {
    fresh.splice(fresh.indexOf(old), 1);
  }
  type(fresh[0]);
  // The cursor is on the word: `e` grows the selection to its end, `y` yanks.
  await TestUtils.waitForCondition(async () => {
    type("e");
    return SpecialPowers.spawn(
      browser,
      [],
      () => content.getSelection().toString().length > 0
    );
  }, `${label}: e selects`);
  type("y");
  await TestUtils.waitForCondition(
    async () =>
      (await yankRing({ persist: false })).at(0)?.text.includes("alpha"),
    `${label}: y puts the selection in the yank ring`
  );
}

for (const [name, check] of [
  ["scroll keys", checkScrollKeys],
  ["visual keys", checkVisualKeys],
]) {
  add_task(async function () {
    info(name);
    await inTab("data:text/html," + encodeURIComponent(PARITY_PAGE), browser =>
      check(browser, "a regular page")
    );
    const extension = ExtensionTestUtils.loadExtension({
      manifest: { options_ui: { page: "page.html", open_in_tab: true } },
      files: { "page.html": PARITY_PAGE },
    });
    await extension.startup();
    await inTab(`moz-extension://${extension.uuid}/page.html`, browser =>
      check(browser, "an extension page")
    );
    await extension.unload();
  });
}

// The popup of an extension is a browser of its own, not a tab's.
add_task(async function test_keys_work_in_extension_popups() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["extensions.openPopupWithoutUserGesture.enabled", true],
      ["ui.popup.disable_autohide", true],
    ],
  });
  const extension = ExtensionTestUtils.loadExtension({
    manifest: { browser_action: { default_popup: "popup.html" } },
    background() {
      browser.test.onMessage.addListener(async () => {
        await browser.browserAction.openPopup();
        browser.test.sendMessage("opened");
      });
    },
    files: {
      "popup.html": `${PARITY_PAGE}<script src="popup.js"></script>`,
      // An extension page takes no inline handlers.
      "popup.js": `document.querySelector("button").onclick = () => {
        document.title = "pressed";
      };`,
    },
  });
  await extension.startup();
  extension.sendMessage("open");
  await extension.awaitMessage("opened");
  const popupBrowser = () =>
    document.querySelector('browser[webextension-view-type="popup"]');
  await TestUtils.waitForCondition(
    () => popupBrowser()?.browsingContext?.currentWindowGlobal,
    "the popup is open"
  );
  // It has to be loaded, and the panel open, for the keys to reach it.
  await TestUtils.waitForCondition(
    async () =>
      popupBrowser()?.closest("panel")?.state == "open" &&
      (await SpecialPowers.spawn(
        popupBrowser(),
        [],
        () => content.document.readyState == "complete"
      )),
    "the popup has loaded"
  );
  try {
    await checkScrollKeys(popupBrowser(), "an extension popup");
    await checkVisualKeys(popupBrowser(), "an extension popup", {
      isPopup: true,
    });
  } catch (e) {
    ok(false, `an extension popup: ${e}`);
  }
  await extension.unload();
});
