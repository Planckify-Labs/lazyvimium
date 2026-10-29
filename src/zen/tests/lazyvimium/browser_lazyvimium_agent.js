/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { LazyvimiumAgents } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs"
);
const { LazyvimiumAgentToolbox } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentTools.sys.mjs"
);

const PAGE = `<!doctype html><title>Agent page</title>
<body style="margin: 20px">
  <form id="form" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'submitted'">
    <input id="name" aria-label="Name">
  </form>
  <button id="go">Go</button>
  <select id="lang" aria-label="Language">
    <option value="en">English</option>
    <option value="de">Deutsch</option>
  </select>
  <input type="password" aria-label="Secret">
  <p id="out">waiting</p>
  <script>
    const out = document.getElementById("out");
    document.getElementById("go").addEventListener("click", event => {
      out.textContent = event.isTrusted ? "went" : "untrusted";
    });
    document.getElementById("name").addEventListener("input", () => {
      out.dataset.typed = document.getElementById("name").value;
    });
    document.getElementById("lang").addEventListener("change", event => {
      out.dataset.lang = event.target.value;
    });
  </script>
</body>`;

async function openPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," + encodeURIComponent(PAGE)
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  return tab;
}

function toolbox(tab, { confirm = async () => false } = {}) {
  const steps = [];
  const box = new LazyvimiumAgentToolbox({
    lazyvimium: Lazyvimium,
    browser: () => tab.linkedBrowser,
    retarget() {},
    onStep: step => steps.push({ ...step }),
    confirm,
  });
  return { box, steps };
}

function idOf(observation, pattern) {
  const match = observation.match(new RegExp(`\\[(e\\d+)\\] ${pattern}`));
  ok(match, `the observation lists ${pattern}`);
  return match[1];
}

function content(browser, selector, key = "textContent") {
  return SpecialPowers.spawn(
    browser,
    [selector, key],
    (s, k) => content.document.querySelector(s)[k]
  );
}

add_task(async function test_observe_lists_controls_but_not_passwords() {
  const tab = await openPage();
  const { box, steps } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  ok(text.includes("Title: Agent page"), text);
  const elements = text.split("Elements in view:")[1].split("Visible text:")[0];
  ok(/\[e\d+\] button "Go"/.test(text), "the button");
  ok(/\[e\d+\] textbox "Name" value="" \(editable\)/.test(text), "the field");
  ok(text.includes('options: "English", "Deutsch"'), "the list's options");
  ok(!elements.includes("Secret"), "passwords are left to the user");
  ok(text.includes("waiting"), "the visible text");
  Assert.deepEqual(
    steps.map(step => step.status),
    ["running", "done"],
    "the dock sees the call"
  );

  const again = await box.callTool("page_observe", {});
  Assert.equal(
    idOf(again.text, 'button "Go"'),
    idOf(text, 'button "Go"'),
    "an element keeps its id"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_act_fills_clicks_selects_and_presses() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  let { text } = await box.callTool("page_observe", {});

  let result = await box.callTool("page_act", {
    action: "fill",
    element: idOf(text, 'textbox "Name"'),
    text: "Ada",
  });
  ok(!result.isError, result.text);
  ok(result.text.startsWith('Typed into input "Name".'), result.text);
  Assert.equal(await content(browser, "#name", "value"), "Ada");
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("out").dataset.typed
    ),
    "Ada",
    "the page saw the input"
  );
  ok(result.text.includes('value="Ada"'), "it returns the page after");

  result = await box.callTool("page_act", { action: "press", text: "Enter" });
  ok(!result.isError, result.text);
  Assert.equal(await content(browser, "#out"), "submitted", "Enter submits");

  text = result.text;
  result = await box.callTool("page_act", {
    action: "select",
    element: idOf(text, 'combobox "Language"'),
    text: "Deutsch",
  });
  ok(!result.isError, result.text);
  Assert.equal(await content(browser, "#lang", "value"), "de");

  result = await box.callTool("page_act", {
    action: "click",
    element: idOf(result.text, 'button "Go"'),
  });
  ok(!result.isError, result.text);
  Assert.equal(await content(browser, "#out"), "went", "a trusted click");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_act_refuses_changed_and_covered_elements() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  const go = idOf(text, 'button "Go"');

  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("go").textContent = "Delete everything";
  });
  let result = await box.callTool("page_act", { action: "click", element: go });
  ok(result.isError, "a button that changed meaning is not clicked");
  ok(result.text.includes("changed since it was observed"), result.text);
  ok(result.text.includes('button "Delete everything"'), "with the page now");
  Assert.equal(await content(browser, "#out"), "waiting");

  const fresh = idOf(result.text, 'button "Delete everything"');
  await SpecialPowers.spawn(browser, [], () => {
    const cover = content.document.createElement("div");
    cover.id = "cover";
    cover.style.cssText = "position: fixed; inset: 0; background: white";
    content.document.body.append(cover);
  });
  result = await box.callTool("page_act", { action: "click", element: fresh });
  ok(result.isError, "a covered button is not clicked");
  ok(result.text.includes("is covered by div"), result.text);
  Assert.equal(await content(browser, "#out"), "waiting");
  ok(
    new RegExp(
      `\\[${fresh}\\] button "Delete everything" \\(covered by div\\)`
    ).test(result.text),
    "the observation says what is covered before the agent tries"
  );

  result = await box.callTool("page_act", {
    action: "click",
    element: "e99999",
  });
  ok(
    result.isError && result.text.includes("no longer on the page"),
    result.text
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_confirm_actions_ask_the_user() {
  const tab = await openPage();
  const questions = [];
  const { box } = toolbox(tab, {
    confirm: async question => {
      questions.push(question);
      return false;
    },
  });
  const tools = box.listTools();
  const ids = tools.find(tool => tool.name == "browser_action").inputSchema
    .properties.id.enum;
  ok(ids.includes("tabs.close"), "registry actions are offered");
  ok(!ids.includes("agent.ask"), "the agent cannot drive its own dock");
  ok(!ids.includes("url.paste"), "nor read the clipboard");

  const result = await box.callTool("browser_action", { id: "tabs.close" });
  ok(result.isError && result.text.includes("declined"), result.text);
  Assert.equal(questions.length, 1, "the user is asked");
  ok(gBrowser.tabs.includes(tab), "the tab stays open");

  const unknown = await box.callTool("browser_action", { id: "session.quit" });
  ok(unknown.isError, "actions kept from agents are unknown to them");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_navigate_only_opens_web_addresses() {
  const tab = await openPage();
  const { box } = toolbox(tab);
  const result = await box.callTool("page_navigate", {
    url: "file:///etc/passwd",
  });
  ok(result.isError, "no file: addresses");
  BrowserTestUtils.removeTab(tab);
});

// An agent speaking Claude Code's stream-json that observes the page over
// lazyvimium's MCP server and clicks the first button it finds.
async function fakeAgent() {
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "lzv-agent"
  );
  const script = PathUtils.join(dir, "claude");
  await IOUtils.writeUTF8(
    script,
    `#!/bin/sh
call() {
  printf '%s' "$1" | curl -sS -H "Authorization: Bearer $LAZYVIMIUM_MCP_TOKEN" \\
    -H 'Content-Type: application/json' --data-binary @- "$LAZYVIMIUM_MCP_URL"
}
echo '{"type":"system","subtype":"init","session_id":"fake-1"}'
page=$(call '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"page_observe","arguments":{}}}')
id=$(printf '%s' "$page" | grep -o '\\[e[0-9]*\\] button' | head -n 1 | sed 's/^\\[\\(e[0-9]*\\)\\].*/\\1/')
call '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"page_act","arguments":{"action":"click","element":"'"$id"'"}}}' > /dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Clicked it"}]}}'
echo '{"type":"result","is_error":false,"result":"Clicked it","session_id":"fake-1"}'
`
  );
  await IOUtils.setPermissions(script, 0o755);
  registerCleanupFunction(() => IOUtils.remove(dir, { recursive: true }));
  return { id: "claude", name: "Fake Claude", path: script, version: "1.0" };
}

add_task(async function test_dock_asks_the_agent_about_the_tab() {
  const agent = await fakeAgent();
  const original = LazyvimiumAgents.defaultAgent;
  LazyvimiumAgents.defaultAgent = async () => agent;
  registerCleanupFunction(() => {
    LazyvimiumAgents.defaultAgent = original;
  });

  const tab = await openPage();
  const browser = tab.linkedBrowser;
  browser.focus();
  await SpecialPowers.spawn(browser, [], () => content.focus());
  const dockElement = document.getElementById("lazyvimium-agent-dock");
  ok(dockElement.hidden, "the dock starts closed");

  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("a");
  EventUtils.synthesizeKey("a");
  const input = dockElement.querySelector(".lazyvimium-agent-input");
  await TestUtils.waitForCondition(
    () => !dockElement.hidden && document.activeElement == input,
    "<leader>aa opens the dock with the keys"
  );
  ok(input.placeholder.includes("Fake Claude"), input.placeholder);
  ok(
    dockElement
      .querySelector(".lazyvimium-agent-tab")
      .textContent.includes("Agent page"),
    "it shows the tab it asks about"
  );

  EventUtils.sendString("press go");
  EventUtils.synthesizeKey("KEY_Enter");
  await TestUtils.waitForCondition(
    () => browser.hasAttribute("lazyvimium-agent-driving"),
    "the tab glows while the agent works"
  );
  await TestUtils.waitForCondition(
    () => dockElement.textContent.includes("Clicked it"),
    "the agent's answer lands in the dock",
    100,
    300
  );
  Assert.equal(await content(browser, "#out"), "went", "the agent clicked");
  await TestUtils.waitForCondition(
    () => !browser.hasAttribute("lazyvimium-agent-driving"),
    "the glow goes once it is done"
  );

  const messages = [
    ...dockElement.querySelectorAll(".lazyvimium-agent-message"),
  ];
  Assert.deepEqual(
    messages.map(message => message.getAttribute("type")),
    ["user", "step", "step", "agent"],
    "the request, the agent's tool calls and its answer"
  );
  ok(
    messages[2].textContent.includes('Clicked button "Go"'),
    messages[2].textContent
  );
  Assert.equal(LazyvimiumAgents.conversationFor(browser).resume, "fake-1");

  Assert.equal(document.activeElement, browser, "the page had the keys");
  EventUtils.synthesizeKey(" ");
  EventUtils.synthesizeKey("a");
  EventUtils.synthesizeKey("a");
  await TestUtils.waitForCondition(
    () => document.activeElement == input,
    "<leader>aa comes back to the dock"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  ok(dockElement.hidden, "Escape closes it");
  ok(
    document.getElementById("lazyvimium-agent-pill").hidden,
    "nothing is waiting"
  );

  const log = LazyvimiumAgents.conversationFor(browser).log;
  await log.flush();
  const entries = (await IOUtils.readUTF8(log.path))
    .trim()
    .split("\n")
    .map(line => JSON.parse(line));
  const turn = entries.find(entry => entry.kind == "turn");
  Assert.equal(turn.request, "press go", "the log has the request");
  ok(turn.url.startsWith("data:"), "and the tab it was asked on");
  Assert.deepEqual(
    entries.filter(entry => entry.kind == "tool").map(entry => entry.name),
    ["page_observe", "page_act"],
    "every browser tool call"
  );
  ok(
    entries.find(entry => entry.kind == "tool").text.includes('button "Go"'),
    "with what the agent saw"
  );
  ok(
    entries.some(entry => entry.kind == "done" && entry.error === null),
    "and how the turn ended"
  );

  LazyvimiumAgents.reset(browser);
  BrowserTestUtils.removeTab(tab);
});

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);

async function openServedPage() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    ROOT + "file_agent_start.html"
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  tab.linkedBrowser.focus();
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => content.focus());
  return tab;
}

// From dev testing on YouTube: a link answered with the page it left.
add_task(async function test_click_waits_for_the_page_it_opens() {
  const tab = await openServedPage();
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  const result = await box.callTool("page_act", {
    action: "click",
    element: idOf(text, 'link "Next page"'),
  });
  ok(!result.isError, result.text);
  ok(result.text.includes("Title: Next page"), "the new page comes back");

  const next = idOf(result.text, 'button "Continue"');
  ok(!new RegExp(`\\[${next}\\]`).test(text), "ids never repeat across pages");
  const stale = await box.callTool("page_act", {
    action: "click",
    element: idOf(text, 'link "Next page"'),
  });
  ok(
    stale.isError && stale.text.includes("no longer on the page"),
    "an id from the page before is gone"
  );
  BrowserTestUtils.removeTab(tab);
});

// From dev testing on YouTube: the vim engine took the agent's k and Escape.
add_task(async function test_pressed_keys_reach_the_page() {
  const tab = await openServedPage();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  for (const key of ["j", "k", "Escape"]) {
    const result = await box.callTool("page_act", {
      action: "press",
      text: key,
    });
    ok(!result.isError, result.text);
  }
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.getElementById("out").dataset.keys
    ),
    "j,k,Escape,",
    "the page got every key once, as real input"
  );
  Assert.equal(
    await SpecialPowers.spawn(browser, [], () => content.scrollY),
    0,
    "and vim did not scroll for j"
  );

  // The user's own keys still drive vim.
  EventUtils.synthesizeKey("j");
  await TestUtils.waitForCondition(
    () => SpecialPowers.spawn(browser, [], () => content.scrollY > 0),
    "j scrolls for the user"
  );
  BrowserTestUtils.removeTab(tab);
});

// From dev testing on YouTube: player controls faded out before the click.
add_task(async function test_hidden_until_hovered_controls_are_clicked() {
  const tab = await openServedPage();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  const play = idOf(text, 'button "Play"');
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("player").classList.add("autohide");
  });
  const result = await box.callTool("page_act", {
    action: "click",
    element: play,
  });
  ok(!result.isError, result.text);
  Assert.equal(await content(browser, "#out"), "playing");

  // The mouse now rests on Play. The player hides it until the mouse moves,
  // so a mousemove to where the mouse already is would reveal nothing.
  await SpecialPowers.spawn(browser, [], () => {
    const player = content.document.getElementById("player");
    player.classList.remove("autohide");
    player.classList.add("idle");
  });
  const again = await box.callTool("page_act", {
    action: "click",
    element: play,
  });
  ok(!again.isError, again.text);
  Assert.equal(await content(browser, "#out"), "paused");
  BrowserTestUtils.removeTab(tab);
});

// From dev testing: music.youtube.com → www.youtube.com, another site in
// another process, came back as the page it left.
add_task(async function test_navigate_to_another_site_returns_it() {
  const tab = await openServedPage();
  const { box } = toolbox(tab);
  const other = ROOT.replace("https://example.com", "https://example.org");
  const result = await box.callTool("page_navigate", {
    url: other + "file_agent_next.html",
  });
  ok(!result.isError, result.text);
  ok(result.text.includes("Title: Next page"), result.text.slice(0, 200));
  ok(result.text.includes("URL: https://example.org/"), "on the new site");
  BrowserTestUtils.removeTab(tab);
});
