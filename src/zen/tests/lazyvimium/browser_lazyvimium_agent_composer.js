/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// The agent panel's composer: files attached to a request and the user's
// standing instructions, with a fake Claude that saves the prompt it gets.

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { LazyvimiumAgents } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs"
);
const { LazyvimiumAgentInstructions } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentInstructions.sys.mjs"
);

const dock = () => Lazyvimium.agentDockFor(window);
const dockElement = () => document.getElementById("lazyvimium-agent-dock");
const $ = selector => dockElement().querySelector(selector);

async function fakeAgent() {
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "lzv-composer-agent"
  );
  const script = PathUtils.join(dir, "claude");
  await IOUtils.writeUTF8(
    script,
    `#!/bin/sh
printf '%s' "$2" > '${dir}/prompt'
echo '{"type":"system","subtype":"init","session_id":"c-1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}'
echo '{"type":"result","is_error":false,"result":"done","session_id":"c-1"}'
`
  );
  await IOUtils.setPermissions(script, 0o755);
  registerCleanupFunction(() => IOUtils.remove(dir, { recursive: true }));
  const agent = { id: "claude", name: "Fake Claude", path: script };
  const original = LazyvimiumAgents.defaultAgent;
  LazyvimiumAgents.defaultAgent = async () => agent;
  registerCleanupFunction(() => {
    LazyvimiumAgents.defaultAgent = original;
  });
  return dir;
}

function type(element, value) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

add_task(async function test_instructions_are_kept_and_sent() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<title>Shop</title><p>shop"
  );
  const dir = await fakeAgent();
  await dock().open(tab.linkedBrowser);
  const page = $(".lazyvimium-agent-instructions");
  ok(page.hidden, "the instructions page starts closed");

  $(".lazyvimium-agent-round-button.instructions").click();
  await TestUtils.waitForCondition(() => !page.hidden, "the page opens");
  ok(
    page.querySelector(".lazyvimium-agent-instructions-empty") &&
      !page.querySelector(".lazyvimium-agent-instructions-empty").hidden,
    "it says what instructions are while there are none"
  );

  page.querySelector(".lazyvimium-agent-instructions-add").click();
  page.querySelector(".lazyvimium-agent-instructions-add").click();
  const cards = page.querySelectorAll(".lazyvimium-agent-instruction");
  is(cards.length, 2, "two instructions were added");
  type(
    cards[0].querySelector(".lazyvimium-agent-instruction-title"),
    "Be brief"
  );
  type(
    cards[0].querySelector(".lazyvimium-agent-instruction-text"),
    "Answer in one sentence.\nNo lists."
  );
  type(cards[1].querySelector(".lazyvimium-agent-instruction-title"), "Prices");
  type(
    cards[1].querySelector(".lazyvimium-agent-instruction-text"),
    "Quote prices in euros."
  );
  is(
    $(".lazyvimium-agent-round-button.instructions").hasAttribute("active"),
    true,
    "the button shows that instructions are on"
  );

  // Nothing is wider than the page, so it never scrolls sideways.
  const body = page.querySelector(".lazyvimium-agent-instructions-body");
  await TestUtils.waitForCondition(
    () => page.getAnimations().length == 0,
    "the page has come in"
  );
  ok(body.scrollWidth <= body.clientWidth, "the page has no horizontal scroll");
  const text = cards[0].querySelector(".lazyvimium-agent-instruction-text");
  ok(
    text.getBoundingClientRect().right <=
      cards[0].getBoundingClientRect().right,
    "a guideline's box stays inside its card"
  );
  ok(
    text.getBoundingClientRect().height >
      cards[0]
        .querySelector(".lazyvimium-agent-instruction-title")
        .getBoundingClientRect().height,
    "and it is as tall as its two lines"
  );
  is(getComputedStyle(text).resize, "none", "it has no resize grip");

  // One file comes with an instruction: dropped on its card.
  const dropOn = (card, ...files) => {
    const data = new DataTransfer();
    for (const file of files) {
      data.items.add(file);
    }
    card.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      })
    );
  };
  const fileTile = () =>
    cards[0].querySelector(".lazyvimium-agent-attachment-tile");
  ok(
    cards[0].querySelector(".lazyvimium-agent-instruction-file-add"),
    "an instruction offers to attach a file"
  );
  dropOn(cards[0], new File(["Quote the style guide."], "guide.md"));
  await TestUtils.waitForCondition(() => fileTile(), "the document shows");
  is(fileTile().getAttribute("kind"), "doc", "a document gets a document tile");
  is(
    fileTile().querySelector(".lazyvimium-agent-doc-ext").textContent,
    "MD",
    "named by its kind"
  );
  const tileBox = fileTile().getBoundingClientRect();
  const cross = fileTile()
    .querySelector(".lazyvimium-agent-attachment-x")
    .getBoundingClientRect();
  is(tileBox.width, 72, "the tile is a full square");
  ok(
    cross.left >= tileBox.left &&
      cross.right <= tileBox.right &&
      cross.top >= tileBox.top &&
      cross.width > 0,
    "its cross sits on the tile's corner, not cut off"
  );
  const first = LazyvimiumAgentInstructions.items[0].file.path;
  ok(
    first.startsWith(LazyvimiumAgentInstructions.filesDir),
    "a copy is kept in the profile"
  );
  is(await IOUtils.readUTF8(first), "Quote the style guide.", "it is the file");
  ok(
    $(".lazyvimium-agent-attachments").hidden,
    "it did not go to the composer"
  );

  // Never more than one: a second replaces the first.
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
    ),
    c => c.charCodeAt(0)
  );
  dropOn(cards[0], new File([png], "pic.png", { type: "image/png" }));
  await TestUtils.waitForCondition(
    () => fileTile()?.getAttribute("kind") == "image",
    "the picture takes its place"
  );
  is(
    cards[0].querySelectorAll(".lazyvimium-agent-attachment-tile").length,
    1,
    "only one file is shown"
  );
  ok(!(await IOUtils.exists(first)), "the earlier copy is gone");

  // Taking it off.
  fileTile().querySelector(".lazyvimium-agent-attachment-x").click();
  await TestUtils.waitForCondition(
    () => !fileTile(),
    "the cross takes the file off"
  );
  is(LazyvimiumAgentInstructions.items[0].file, null, "and from the store");
  dropOn(cards[0], new File(["Quote the style guide."], "guide.md"));
  await TestUtils.waitForCondition(() => fileTile(), "a file again");

  // A switch turns one off without losing it.
  cards[1].querySelector(".lazyvimium-agent-switch").click();
  is(
    cards[1]
      .querySelector(".lazyvimium-agent-switch")
      .getAttribute("aria-checked"),
    "false",
    "the switch is off"
  );

  // Escape closes the page, not the panel.
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(() => page.hidden, "Escape goes back");
  ok(!dockElement().hidden, "the panel stays open");
  await TestUtils.waitForCondition(
    () => IOUtils.exists(LazyvimiumAgentInstructions.path),
    "closing the page saves them"
  );
  const saved = await IOUtils.readJSON(LazyvimiumAgentInstructions.path);
  is(saved.instructions.length, 2, "both were saved");
  is(saved.instructions[1].enabled, false, "with their switches");

  const input = $(".lazyvimium-agent-input");
  await TestUtils.waitForCondition(
    () => document.activeElement == input,
    "the keys go back to the request"
  );
  type(input, "what is on this page?");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => !LazyvimiumAgents.conversationFor(tab.linkedBrowser)?.running,
    "the turn ends"
  );
  const prompt = await IOUtils.readUTF8(PathUtils.join(dir, "prompt"));
  ok(
    prompt.includes("- Be brief: Answer in one sentence.\n  No lists."),
    prompt
  );
  const guide = prompt.match(/^ {2}File: (.*guide\.md)$/m)?.[1];
  ok(guide, "the instruction's file goes with it");
  is(
    await IOUtils.readUTF8(guide),
    "Quote the style guide.",
    "the agent can read it"
  );
  ok(!prompt.includes("Prices"), "an instruction that is off is not sent");
  ok(prompt.includes("what is on this page?"), "the request is sent");

  // Deleting.
  $(".lazyvimium-agent-round-button.instructions").click();
  await TestUtils.waitForCondition(() => !page.hidden, "the page opens again");
  page.querySelector(".lazyvimium-agent-icon-button.trash").click();
  page.querySelector(".lazyvimium-agent-icon-button.trash").click();
  is(
    page.querySelectorAll(".lazyvimium-agent-instruction").length,
    0,
    "both are deleted"
  );
  await TestUtils.waitForCondition(
    async () => !(await IOUtils.exists(guide)),
    "deleting an instruction deletes its file"
  );
  page.querySelector(".lazyvimium-agent-instructions-done").click();
  await TestUtils.waitForCondition(() => page.hidden, "Done closes the page");
  ok(
    !$(".lazyvimium-agent-round-button.instructions").hasAttribute("active"),
    "the button shows none are on"
  );

  dock().close();
  await TestUtils.waitForCondition(() => dockElement().hidden, "closed");
  LazyvimiumAgents.reset(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_files_go_with_the_request() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<title>Shop</title><p>shop"
  );
  const dir = await fakeAgent();
  await dock().open(tab.linkedBrowser);
  const input = $(".lazyvimium-agent-input");
  const send = $(".lazyvimium-agent-round-button.send");
  ok(send.disabled, "there is nothing to send yet");

  // Files dropped on the composer; ones with no path on disk, as a picture
  // from the clipboard is, are kept by their bytes. (A ClipboardEvent made
  // by a test carries no files, so the paste handler shares this path but
  // is not driven here.)
  const dropFiles = (...files) => {
    const data = new DataTransfer();
    for (const file of files) {
      data.items.add(file);
    }
    // On the conversation, away from the composer.
    $(".lazyvimium-agent-log").dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      })
    );
  };
  dropFiles(new File(["name,price\nlamp,9"], "prices.csv"));
  await TestUtils.waitForCondition(
    () => $(".lazyvimium-agent-attachment"),
    "the file shows as a chip"
  );
  ok(!send.disabled, "a file alone can be sent");
  is(
    $(".lazyvimium-agent-attachment-name").textContent,
    "prices.csv",
    "the chip names the file"
  );

  dropFiles(new File(["x"], "ignored.txt"));
  await TestUtils.waitForCondition(
    () =>
      dockElement().querySelectorAll(".lazyvimium-agent-attachment").length ==
      2,
    "a second file is added"
  );

  // Taking one off.
  dockElement().querySelectorAll(".lazyvimium-agent-attachment-x")[1].click();
  is(
    dockElement().querySelectorAll(".lazyvimium-agent-attachment").length,
    1,
    "a chip's cross takes the file off"
  );

  // A picture gets a preview, not a chip.
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
    ),
    c => c.charCodeAt(0)
  );
  dropFiles(new File([png], "pic.png", { type: "image/png" }));
  await TestUtils.waitForCondition(
    () => $(".lazyvimium-agent-attachment-tile img"),
    "the picture shows as a tile"
  );
  const image = $(".lazyvimium-agent-attachment-tile img");
  ok(image.src.startsWith("blob:"), "its preview is the picture itself");
  await TestUtils.waitForCondition(
    () => image.complete && image.naturalWidth == 1,
    "the preview loads"
  );
  is(
    dockElement().querySelectorAll(".lazyvimium-agent-attachment").length,
    1,
    "and the picture is not also a chip"
  );

  EventUtils.synthesizeKey("KEY_Enter", {}, window);
  await TestUtils.waitForCondition(
    () => !LazyvimiumAgents.conversationFor(tab.linkedBrowser)?.running,
    "the turn ends"
  );
  const prompt = await IOUtils.readUTF8(PathUtils.join(dir, "prompt"));
  ok(/^- .*attachments.*pic\.png$/m.test(prompt), "the picture goes along");
  const path = prompt.match(/^- (.*attachments.*prices\.csv)$/m)?.[1];
  ok(path, `the prompt names the file's copy: ${prompt}`);
  is(
    await IOUtils.readUTF8(path),
    "name,price\nlamp,9",
    "the copy is what was attached"
  );
  ok(
    !$(".lazyvimium-agent-attachments") ||
      $(".lazyvimium-agent-attachments").hidden,
    "the chips are cleared once sent"
  );
  is(
    $('.lazyvimium-agent-message[type="user"] .lazyvimium-agent-attachment')
      .textContent,
    "prices.csv",
    "the sent request lists its file"
  );

  dock().close();
  await TestUtils.waitForCondition(() => dockElement().hidden, "closed");
  LazyvimiumAgents.reset(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
});
