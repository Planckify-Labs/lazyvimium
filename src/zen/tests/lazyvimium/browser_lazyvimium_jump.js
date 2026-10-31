/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { yankRing } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/plugins/LazyvimiumYank.sys.mjs"
);

const PAGE = `<body style="margin: 0; font: 20px sans-serif">
  <div><button id="pricing" onclick="window.pressed = 'pricing'">Pricing</button></div>
  <div><button id="profile" onclick="window.pressed = 'profile'">Profile</button></div>
  <div><a id="docs" href="#docs" onclick="window.pressed = 'docs'">Documentation</a></div>
  <p id="text">alpha beta gamma delta</p>
  <p id="second">epsilon zeta</p>
  <input id="field">
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

function type(keys) {
  for (const key of keys) {
    EventUtils.synthesizeKey(key, { shiftKey: key != key.toLowerCase() });
  }
}

function statuslineText() {
  return document.getElementById("lazyvimium-statusline")?.textContent ?? "";
}

function inPage(tab, fn, args = []) {
  return SpecialPowers.spawn(tab.linkedBrowser, args, fn);
}

async function waitForMode(name) {
  await TestUtils.waitForCondition(
    () => statuslineText().includes(name),
    `${name} mode`
  );
}

// The labels on the page, not the prompt that shows what was typed.
const labelsShown = tab =>
  inPage(tab, () =>
    [...content.document.documentElement.querySelectorAll("div > span")]
      .map(span => span.textContent)
      .filter(text => text && !text.includes(" "))
  );

// The label on a word of the page, or on the paragraph with it when given
// the paragraph's id.
function labelOf(tab, word, paragraphId) {
  return inPage(
    tab,
    (text, id) => {
      const spans = [
        ...content.document.documentElement.querySelectorAll("div > span"),
      ];
      const isParagraph = span =>
        span.style.background.includes("rgb(61, 89, 161)");
      let rect;
      if (id) {
        rect = content.document.getElementById(id).getBoundingClientRect();
      } else {
        const walker = content.document.createTreeWalker(
          content.document.body,
          content.NodeFilter.SHOW_TEXT
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.data.indexOf(text);
          if (at != -1) {
            const range = content.document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + text.length);
            rect = range.getBoundingClientRect();
            break;
          }
        }
      }
      const found = spans.find(span => {
        const box = span.getBoundingClientRect();
        return (
          isParagraph(span) == !!id &&
          (id
            ? Math.abs(box.top - rect.top) < 3
            : Math.abs(box.left - rect.left) < 4 &&
              box.top >= rect.top - 4 &&
              box.bottom <= rect.bottom + 4)
        );
      });
      return found?.textContent ?? null;
    },
    [word, paragraphId]
  );
}

async function dismissLabels(tab) {
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length,
    "labels are shown"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    async () => !(await labelsShown(tab)).length,
    "<Esc> drops the labels"
  );
}

add_task(async function test_jump_to_a_control_by_text_and_label() {
  const tab = await openPage();
  type("gs");
  await TestUtils.waitForCondition(
    async () =>
      (await inPage(
        tab,
        () => content.document.documentElement.lastChild.style.zIndex
      )) == "2147483647",
    "the jump draws its overlay"
  );
  type("p");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length == 2,
    "the two controls with a p get labels"
  );
  const [first, second] = await labelsShown(tab);
  const next = ["r", "o"];
  ok(!next.includes(first) && !next.includes(second), "labels skip next chars");
  // "pro" narrows to Profile only.
  type("ro");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length == 1,
    "one control left"
  );
  const [label] = await labelsShown(tab);
  type(label);
  await TestUtils.waitForCondition(
    () => inPage(tab, () => content.wrappedJSObject.pressed == "profile"),
    "the label presses its control"
  );
  is(
    await inPage(
      tab,
      () => content.document.documentElement.lastChild.style.zIndex
    ),
    "",
    "the overlay is gone"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_hints_label_everything() {
  const tab = await openPage();
  type("s");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length >= 4,
    "every control is labeled at once"
  );
  const labels = await labelsShown(tab);
  // Reading order: the two buttons, the link, the field.
  type(labels[2]);
  await TestUtils.waitForCondition(
    () => inPage(tab, () => content.wrappedJSObject.pressed == "docs"),
    "a hint presses its control"
  );
  BrowserTestUtils.removeTab(tab);
});

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);

add_task(async function test_s_labels_controls_in_frames_too() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    ROOT + "file_jump_frame_host.html"
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  const browser = tab.linkedBrowser;
  browser.focus();
  await inPage(tab, () => content.focus());
  const frame = browser.browsingContext.children.find(
    child => child.currentURI?.host == "example.org"
  );
  ok(frame, "the form is a frame of another site");
  Assert.notEqual(
    frame.currentWindowGlobal.domProcess.childID,
    browser.browsingContext.currentWindowGlobal.domProcess.childID,
    "in another process"
  );
  const nested = frame.children[0];
  ok(nested, "and it has a frame of its own");
  const textIn = (context, id) =>
    SpecialPowers.spawn(
      context,
      [id],
      elementId => content.document.getElementById(elementId).textContent
    );

  // Reading order: the page's button, the frame's, the frame in the frame's.
  type("s");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length == 3,
    "the page, the frame and the frame in it are all labeled"
  );
  type((await labelsShown(tab))[2]);
  await TestUtils.waitForCondition(
    async () => (await textIn(nested, "out")) == "deep pressed",
    "a label presses a control two frames down"
  );
  await TestUtils.waitForCondition(
    async () => !(await labelsShown(tab)).length,
    "the labels are gone"
  );

  type("s");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length == 3,
    "labels again"
  );
  type((await labelsShown(tab))[1]);
  await TestUtils.waitForCondition(
    async () => (await textIn(frame, "out")) == "paid",
    "a label presses a control in a frame of another site"
  );

  // With focus inside the frame, `s` still labels the whole page.
  await SpecialPowers.spawn(frame, [], () =>
    content.document.getElementById("pay").focus()
  );
  type("s");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length == 3,
    "labels over the whole page from a key typed in a frame"
  );
  type((await labelsShown(tab))[0]);
  await TestUtils.waitForCondition(
    () => inPage(tab, () => content.document.title == "top pressed"),
    "the page's own control is pressed"
  );
  BrowserTestUtils.removeTab(tab);
});

const cursorShown = tab =>
  inPage(tab, () =>
    [...content.document.documentElement.children].some(
      element => element.style.width == "2px" && element.style.display != "none"
    )
  );

// The selected text, once it is what a key should have made it: keys reach
// the page after the message that reads it.
async function selectedText(tab, expected) {
  let text;
  for (let i = 0; i < 40; i++) {
    text = await inPage(tab, () => content.getSelection().toString());
    if (text == expected) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return text;
}

add_task(async function test_visual_mode_selects_and_yanks() {
  const ring = await yankRing({ persist: false });
  ring.clear();
  const tab = await openPage();
  type("v");
  await waitForMode("VISUAL");
  ok(await cursorShown(tab), "visual mode draws the cursor");
  await dismissLabels(tab);
  is(statuslineText().includes("VISUAL"), true, "<Esc> keeps visual mode");
  type("iw");
  is(await selectedText(tab, "Pricing"), "Pricing", "iw selects the word");
  ok(await cursorShown(tab), "the cursor follows the selection");
  type("y");
  await waitForMode("NORMAL");
  await TestUtils.waitForCondition(
    async () => (await yankRing({ persist: false })).length == 1,
    "the yank joins the ring"
  );
  is(ring.at(0).text, "Pricing", "the ring has the selected text");
  is(
    await inPage(tab, () => SpecialPowers.getClipboardData("text/plain")),
    "Pricing",
    "the clipboard has it too"
  );
  is(
    await inPage(tab, () => content.getSelection().isCollapsed),
    true,
    "the cursor stays where the yank began"
  );
  await TestUtils.waitForCondition(
    async () => !(await cursorShown(tab)),
    "the cursor is gone in normal mode"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_visual_mode_labels_words_and_paragraphs() {
  const ring = await yankRing({ persist: false });
  ring.clear();
  const tab = await openPage();
  type("v");
  await waitForMode("VISUAL");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length > 9,
    "every word and paragraph on screen is labeled"
  );

  const gamma = await labelOf(tab, "gamma");
  ok(gamma, "a word has a label");
  const paragraph = await labelOf(tab, "", "second");
  ok(paragraph, "a paragraph has a label of its own");
  isnot(gamma, paragraph, "labels are different");

  // A word label puts the cursor on the word.
  type(gamma);
  await TestUtils.waitForCondition(
    async () => !(await labelsShown(tab)).length,
    "the labels are gone"
  );
  ok(
    await inPage(tab, () => {
      const selection = content.getSelection();
      return (
        selection.isCollapsed &&
        selection.focusNode.data
          .slice(selection.focusOffset)
          .startsWith("gamma")
      );
    }),
    "the cursor is at the word"
  );
  ok(statuslineText().includes("VISUAL"), "still in visual mode");
  type("iw");
  is(await selectedText(tab, "gamma"), "gamma", "viw takes that word");
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");

  // A paragraph label selects the paragraph, and y yanks it.
  type("v");
  await waitForMode("VISUAL");
  await TestUtils.waitForCondition(
    async () => !!(await labelOf(tab, "", "second")),
    "labels again"
  );
  type(await labelOf(tab, "", "second"));
  is(
    await selectedText(tab, "epsilon zeta"),
    "epsilon zeta",
    "a paragraph label selects the paragraph"
  );
  type("y");
  await waitForMode("NORMAL");
  await TestUtils.waitForCondition(
    async () =>
      (await yankRing({ persist: false })).at(0)?.text == "epsilon zeta",
    "the paragraph is yanked"
  );

  // A selection made before is kept, with no labels over it.
  await inPage(tab, () =>
    content
      .getSelection()
      .selectAllChildren(content.document.getElementById("text"))
  );
  type("v");
  await waitForMode("VISUAL");
  is((await labelsShown(tab)).length, 0, "no labels over a selection");
  is(
    await selectedText(tab, "alpha beta gamma delta"),
    "alpha beta gamma delta",
    "the selection is kept"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_gg_and_G_select_to_the_top_and_bottom() {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) => `<p id="p${i}">line ${i} word${i}</p>`
  ).join("");
  // Room above the first text and below the last, so the ends of the text
  // are not the ends of the page.
  const tab = await openPage(
    `<body style="margin: 0; padding: 300px 0">${paragraphs}</body>`
  );
  const scrolledTo = (where, label) =>
    TestUtils.waitForCondition(
      () =>
        inPage(
          tab,
          expected => {
            const root = content.document.scrollingElement;
            return (
              content.scrollY ==
              (expected == "top" ? 0 : root.scrollHeight - content.innerHeight)
            );
          },
          [where]
        ),
      label
    );
  const land = async word => {
    type("v");
    await waitForMode("VISUAL");
    await TestUtils.waitForCondition(
      async () => !!(await labelOf(tab, word)),
      `${word} is labeled`
    );
    type(await labelOf(tab, word));
    await TestUtils.waitForCondition(
      async () => !(await labelsShown(tab)).length,
      "the labels are gone"
    );
  };

  await land("word3");
  type("G");
  await TestUtils.waitForCondition(
    async () => (await selectedText(tab)).endsWith("line 39 word39"),
    "G selects from the cursor to the bottom"
  );
  let text = await selectedText(tab);
  ok(text.startsWith("word3"), "the selection starts where the cursor landed");
  await scrolledTo("bottom", "G scrolls to the very bottom of the page");
  ok(await cursorShown(tab), "the cursor is still drawn there");
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");

  await inPage(tab, () => content.scrollTo(0, 0));
  await land("word3");
  type("gg");
  await TestUtils.waitForCondition(
    async () => (await selectedText(tab)).startsWith("line 0 word0"),
    "gg selects from the cursor to the top"
  );
  text = await selectedText(tab);
  ok(
    text.endsWith("line 3 "),
    `the selection ends where the cursor landed: ${text}`
  );
  await scrolledTo("top", "gg scrolls to the very top of the page");
  ok(await cursorShown(tab), "the cursor is still drawn there");
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");
  BrowserTestUtils.removeTab(tab);
});

const OBJECTS = `<p id="code">call(one, [two, {three four}]) say "hello there" in a/path/x ok.</p>
  <p id="more">second <b>bold <i id="deep">deep</i> text</b> end</p>`;

// Visual mode with the cursor inside a word of the page.
async function visualIn(tab, id, word) {
  await inPage(
    tab,
    (elementId, text) => {
      const node = content.document.getElementById(elementId).firstChild;
      const at = node.data.indexOf(text) + 1;
      content.getSelection().collapse(node, at);
    },
    [id, word]
  );
  type("v");
  await waitForMode("VISUAL");
  await dismissLabels(tab);
}

add_task(async function test_text_objects() {
  const tab = await openPage(PAGE + OBJECTS);
  const cases = [
    ["a{", "{three four}"],
    ["i{", "three four"],
    ["a[", "[two, {three four}]"],
    ["i(", "one, [two, {three four}]"],
    ["aw", "three "],
    ["iw", "three"],
    ["ip", 'call(one, [two, {three four}]) say "hello there" in a/path/x ok.'],
  ];
  for (const [keys, expected] of cases) {
    await visualIn(tab, "code", "three");
    type(keys);
    is(await selectedText(tab, expected), expected, `v${keys}`);
    EventUtils.synthesizeKey("KEY_Escape");
    await waitForMode("NORMAL");
  }

  await visualIn(tab, "code", "hello");
  type('i"');
  is(await selectedText(tab, "hello there"), "hello there", 'vi"');
  type('a"');
  is(await selectedText(tab, '"hello there"'), '"hello there"', 'a" grows it');
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");

  await visualIn(tab, "code", "hello");
  type("aq");
  is(await selectedText(tab, '"hello there"'), '"hello there"', "vaq");
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");

  await visualIn(tab, "code", "path");
  type("i/");
  is(await selectedText(tab, "path"), "path", "vi/");
  type("a/");
  is(await selectedText(tab, "path/"), "path/", "va/ grows it");
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");

  // Repeating grows to the next bracket around.
  await visualIn(tab, "code", "three");
  type("a{");
  type("a[");
  type("a(");
  is(
    await selectedText(tab, "(one, [two, {three four}])"),
    "(one, [two, {three four}])",
    "a{ a[ a( grow outwards"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");

  // The elements around the cursor.
  await visualIn(tab, "deep", "deep");
  type("it");
  is(await selectedText(tab, "deep"), "deep", "vit is the element around");
  type("it");
  is(
    await selectedText(tab, "bold deep text"),
    "bold deep text",
    "vit again grows to its parent"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_typed_jump_to_a_word_starts_visual_mode() {
  const tab = await openPage();
  type("S");
  type("zeta");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length == 1,
    "the one match is labeled"
  );
  type((await labelsShown(tab))[0]);
  await waitForMode("VISUAL");
  await TestUtils.waitForCondition(
    () =>
      inPage(tab, () => {
        const selection = content.getSelection();
        return selection.focusNode.data
          .slice(selection.focusOffset)
          .startsWith("zeta");
      }),
    "the cursor jumps to the word"
  );
  type("iw");
  is(await selectedText(tab, "zeta"), "zeta", "viw after the jump");
  type("s");
  await TestUtils.waitForCondition(
    async () => !!(await labelOf(tab, "alpha")),
    "every word is labeled"
  );
  type(await labelOf(tab, "alpha"));
  await TestUtils.waitForCondition(
    async () => (await selectedText(tab)).includes("alpha beta"),
    "s in visual mode extends the selection to the word"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await waitForMode("NORMAL");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_cycling_the_ring_in_a_field() {
  const ring = await yankRing({ persist: false });
  ring.clear();
  ring.add("first");
  ring.add("second");
  ring.add("third");
  const tab = await openPage();
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#field",
    {},
    tab.linkedBrowser
  );
  await waitForMode("INSERT");
  const value = () =>
    inPage(tab, () => content.document.getElementById("field").value);

  EventUtils.synthesizeKey("p", { altKey: true });
  await TestUtils.waitForCondition(
    async () => (await value()) == "third",
    "newest"
  );
  EventUtils.synthesizeKey("p", { altKey: true });
  await TestUtils.waitForCondition(
    async () => (await value()) == "second",
    "older"
  );
  EventUtils.synthesizeKey("p", { altKey: true });
  await TestUtils.waitForCondition(
    async () => (await value()) == "first",
    "oldest"
  );
  EventUtils.synthesizeKey("n", { altKey: true });
  await TestUtils.waitForCondition(
    async () => (await value()) == "second",
    "newer"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_copy_events_join_the_ring() {
  const ring = await yankRing({ persist: false });
  ring.clear();
  const tab = await openPage();
  await inPage(tab, () => {
    const selection = content.getSelection();
    selection.selectAllChildren(content.document.getElementById("second"));
  });
  EventUtils.synthesizeKey("c", { accelKey: true });
  await TestUtils.waitForCondition(
    async () =>
      (await yankRing({ persist: false })).at(0)?.text == "epsilon zeta",
    "a copy in the page joins the ring"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_keys_typed_in_a_frame_act_on_the_page() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    ROOT + "file_trap_host.html"
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  const browser = tab.linkedBrowser;
  browser.focus();
  const frame = browser.browsingContext.children.find(
    child => child.currentURI?.host == "example.org"
  );
  ok(frame, "the page has a frame of another site");
  const focusIn = id =>
    SpecialPowers.spawn(frame, [id], elementId => {
      content.document.getElementById(elementId).focus();
    });
  const scrolls = async () => ({
    page: await inPage(tab, () => content.scrollY),
    frame: await SpecialPowers.spawn(frame, [], () => content.scrollY),
  });

  await focusIn("inside");
  type("G");
  await TestUtils.waitForCondition(
    async () => (await scrolls()).page > 1000,
    "G from inside a frame goes to the bottom of the page"
  );
  is((await scrolls()).frame, 0, "and the frame did not scroll");

  // The page has the focus now: the keys that follow are the page's too.
  type("gg");
  await TestUtils.waitForCondition(
    async () => (await scrolls()).page == 0,
    "gg goes to the top of the page"
  );

  await focusIn("inside");
  type("j");
  await TestUtils.waitForCondition(
    async () => (await scrolls()).page > 0,
    "j scrolls the page from inside a frame"
  );
  is((await scrolls()).frame, 0, "not the frame");

  await focusIn("inside");
  type("v");
  await TestUtils.waitForCondition(
    async () => (await labelsShown(tab)).length > 0,
    "v from inside a frame labels the page's words"
  );
  await dismissLabels(tab);

  // Typing in a field of the frame stays in the frame.
  await focusIn("field");
  await TestUtils.waitForCondition(
    () => statuslineText().includes("INSERT"),
    "a field of the frame is insert mode"
  );
  // The scroll of `j` has to be over.
  let before;
  await TestUtils.waitForCondition(async () => {
    const last = before;
    before = (await scrolls()).page;
    return before === last;
  }, "the page stopped scrolling");
  type("jG");
  await TestUtils.waitForCondition(
    async () =>
      (await SpecialPowers.spawn(
        frame,
        [],
        () => content.document.getElementById("field").value
      )) == "jG",
    "the keys are typed into the field"
  );
  is((await scrolls()).page, before, "and the page does not scroll");
  BrowserTestUtils.removeTab(tab);
});
