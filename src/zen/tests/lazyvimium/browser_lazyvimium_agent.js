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
  let working = tab.linkedBrowser;
  const box = new LazyvimiumAgentToolbox({
    lazyvimium: Lazyvimium,
    browser: () => working,
    retarget(browser) {
      working = browser;
    },
    onStep: step => steps.push({ ...step }),
    confirm,
  });
  return { box, steps, working: () => working };
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
  await TestUtils.waitForCondition(
    () => dockElement.hidden,
    "Escape closes it, once it has slid out"
  );
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

add_task(async function test_agent_works_across_tabs() {
  const tab = await openPage();
  const questions = [];
  const { box, working } = toolbox(tab, {
    confirm: async question => {
      questions.push(question);
      return false;
    },
  });
  const tabId = text => text.match(/^Tab: (t\d+)/m)?.[1];

  const first = await box.callTool("page_observe", {});
  const home = tabId(first.text);
  ok(home, "every observation names its tab");
  let list = await box.callTool("tabs_list", {});
  ok(
    list.text.includes(`[${home}] "Agent page"`) &&
      list.text.includes("in front, you work on it"),
    list.text
  );

  // A tab of its own, brought to the front.
  const opened = await box.callTool("tab_open", {
    url: ROOT + "file_agent_next.html",
  });
  ok(!opened.isError, opened.text);
  ok(opened.text.includes("Title: Next page"), "it returns the loaded page");
  const own = tabId(opened.text.split("\n\n")[1]);
  Assert.notEqual(own, home);
  Assert.equal(gBrowser.selectedBrowser, working(), "and works on it");

  // The user's tab, now behind, is still in reach.
  const goId = idOf(first.text, 'button "Go"');
  const clicked = await box.callTool("page_act", {
    action: "click",
    element: goId,
    tab: home,
  });
  ok(!clicked.isError, clicked.text);
  Assert.equal(
    await content(tab.linkedBrowser, "#out"),
    "went",
    "a click lands in a tab behind the one in front"
  );
  Assert.notEqual(gBrowser.selectedTab, tab, "without bringing it forward");

  // Back to the user's tab without showing it, then to the front.
  let switched = await box.callTool("tab_switch", { tab: home, show: false });
  ok(!switched.isError, switched.text);
  Assert.equal(working(), tab.linkedBrowser);
  Assert.notEqual(gBrowser.selectedTab, tab);
  switched = await box.callTool("tab_switch", { tab: home });
  Assert.equal(gBrowser.selectedTab, tab, "show brings it to the front");

  // In the background, then closed without asking: the agent opened it.
  const background = await box.callTool("tab_open", { background: true });
  const empty = background.text.match(/tab (t\d+)/)[1];
  Assert.equal(gBrowser.selectedTab, tab, "a background tab stays behind");
  list = await box.callTool("tabs_list", {});
  ok(list.text.includes(`[${empty}]`) && list.text.includes("you opened it"));
  const before = gBrowser.tabs.length;
  const closed = await box.callTool("tab_close", { tab: empty });
  ok(!closed.isError, closed.text);
  Assert.equal(gBrowser.tabs.length, before - 1);
  Assert.deepEqual(questions, [], "closing its own tab asks nothing");
  Assert.equal(
    working(),
    gBrowser.selectedBrowser,
    "closing the tab it works on moves it to the one in front"
  );

  // The user's tab is the user's to close.
  const declined = await box.callTool("tab_close", { tab: home });
  ok(declined.isError);
  Assert.deepEqual(questions, ['close the tab "Agent page"']);
  ok(gBrowser.tabs.includes(tab), "it stays open");

  const missing = await box.callTool("page_observe", { tab: "t9999" });
  ok(missing.isError && missing.text.includes("tabs_list"), missing.text);

  await box.callTool("tab_close", { tab: own });
  BrowserTestUtils.removeTab(tab);
});

// An agent printing the given stream-json lines; "sleep N" pauses.
async function scriptedAgent(lines) {
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "lzv-agent"
  );
  const script = PathUtils.join(dir, "claude");
  const body = lines
    .map(line =>
      typeof line == "string"
        ? line
        : `printf '%s\\n' '${JSON.stringify(line).replaceAll("'", "'\\''")}'`
    )
    .join("\n");
  await IOUtils.writeUTF8(script, `#!/bin/sh\n${body}\n`);
  await IOUtils.setPermissions(script, 0o755);
  registerCleanupFunction(() => IOUtils.remove(dir, { recursive: true }));
  const agent = { id: "claude", name: "Fake Claude", path: script };
  const original = LazyvimiumAgents.defaultAgent;
  LazyvimiumAgents.defaultAgent = async () => agent;
  registerCleanupFunction(() => {
    LazyvimiumAgents.defaultAgent = original;
  });
  return agent;
}

function delta(text) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  };
}

const dock = () => Lazyvimium.agentDockFor(window);
const dockElement = () => document.getElementById("lazyvimium-agent-dock");

async function openDock(tab) {
  await dock().open(tab.linkedBrowser);
  const input = dockElement().querySelector(".lazyvimium-agent-input");
  await TestUtils.waitForCondition(
    () => document.activeElement == input,
    "the dock has the keys"
  );
  return input;
}

async function closeDock() {
  dock().close();
  await TestUtils.waitForCondition(() => dockElement().hidden, "it closed");
}

add_task(async function test_answers_render_as_markdown_as_they_stream() {
  const answer =
    "## Levels\n- **Resistance** $93\n- Support `90`\n\n[docs](https://example.com/)";
  const cut = answer.indexOf("tance");
  await scriptedAgent([
    { type: "system", subtype: "init", session_id: "md-1" },
    delta(answer.slice(0, cut)),
    "sleep 2",
    delta(answer.slice(cut)),
    {
      type: "assistant",
      message: { content: [{ type: "text", text: answer }] },
    },
    { type: "result", is_error: false, session_id: "md-1" },
  ]);
  const tab = await openPage();
  const input = await openDock(tab);
  input.value = "levels?";
  EventUtils.synthesizeKey("KEY_Enter");

  const answerRow = () =>
    dockElement().querySelector('.lazyvimium-agent-message[type="agent"]');
  await TestUtils.waitForCondition(
    () => answerRow()?.hasAttribute("streaming"),
    "the answer shows while it streams"
  );
  const row = answerRow();
  Assert.equal(row.querySelector("h2")?.textContent, "Levels");
  Assert.equal(
    row.querySelector("li strong")?.textContent,
    "Resis",
    "an emphasis still open shows as emphasis, not as **"
  );
  ok(!row.textContent.includes("**"), row.textContent);

  await TestUtils.waitForCondition(
    () => !LazyvimiumAgents.conversationFor(tab.linkedBrowser).running,
    "the turn ends"
  );
  await TestUtils.waitForCondition(
    () => !answerRow().hasAttribute("streaming"),
    "and the answer settles"
  );
  Assert.equal(answerRow(), row, "in the row it streamed into");
  Assert.deepEqual(
    [...row.querySelectorAll("li")].map(li => li.textContent),
    ["Resistance $93", "Support 90"]
  );
  Assert.equal(row.querySelector("li code").textContent, "90");
  Assert.equal(
    dockElement().querySelectorAll('.lazyvimium-agent-message[type="agent"]')
      .length,
    1,
    "the whole message replaced its pieces"
  );

  const link = row.querySelector("a");
  Assert.equal(link.href, "https://example.com/");
  const opened = BrowserTestUtils.waitForNewTab(
    gBrowser,
    "https://example.com/"
  );
  EventUtils.synthesizeMouseAtCenter(link, {});
  BrowserTestUtils.removeTab(await opened);
  Assert.equal(
    document.location.href,
    AppConstants.BROWSER_CHROME_URL,
    "the link opened in a tab, not over the browser"
  );

  await closeDock();
  LazyvimiumAgents.reset(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_insert_mode_keys_in_the_dock() {
  await scriptedAgent([]);
  const tab = await openPage();
  const tabs = gBrowser.tabs.length;
  const input = await openDock(tab);
  EventUtils.sendString("hello brave world");
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  Assert.equal(input.value, "hello brave ", "Ctrl+W deletes a word");
  Assert.equal(gBrowser.tabs.length, tabs, "and leaves the tab open");
  EventUtils.synthesizeKey("h", { ctrlKey: true });
  Assert.equal(input.value, "hello brave", "Ctrl+H a character");
  EventUtils.synthesizeKey("u", { ctrlKey: true });
  Assert.equal(input.value, "", "Ctrl+U the line");
  await closeDock();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_dock_layouts() {
  await scriptedAgent([]);
  registerCleanupFunction(async () => {
    // The side button sets the pref itself.
    Services.prefs.clearUserPref("lazyvimium.agent.layout");
    Services.prefs.clearUserPref("lazyvimium.agent.side");
    if (!dockElement().hidden) {
      await closeDock();
    }
  });
  const tab = await openPage();
  const panels = gBrowser.tabpanels;
  const fullWidth = panels.getBoundingClientRect().width;
  await SpecialPowers.pushPrefEnv({
    set: [
      ["lazyvimium.agent.layout", "split"],
      ["lazyvimium.agent.width", 360],
    ],
  });
  await openDock(tab);
  const root = dockElement();
  Assert.equal(root.parentNode.id, "zen-tabbox-wrapper");
  if (fullWidth - 360 >= 440) {
    Assert.equal(root.getAttribute("layout"), "split");
    await TestUtils.waitForCondition(
      () => panels.getBoundingClientRect().width < fullWidth - 300,
      "the tab makes room beside it"
    );
    // From dev testing: a long conversation stretched the tab box past the
    // window, hiding the close button and the request box.
    const conversation = LazyvimiumAgents.conversationFor(tab.linkedBrowser);
    for (let i = 0; i < 80; i++) {
      conversation.messages.push({
        type: "step",
        text: `Read the page, a long step title number ${i} that wraps around the panel`,
        status: "done",
      });
    }
    conversation.changed();
    await TestUtils.waitForCondition(
      () => root.querySelectorAll(".lazyvimium-agent-message").length >= 80,
      "the conversation is drawn"
    );
    await Promise.all(
      root.getAnimations().map(animation => animation.finished)
    );
    const wrapper = root.parentNode.getBoundingClientRect();
    const panel = root.getBoundingClientRect();
    const close = root.querySelector(".close").getBoundingClientRect();
    const composer = root
      .querySelector(".lazyvimium-agent-composer")
      .getBoundingClientRect();
    info(JSON.stringify({ wrapper, panel, close, composer, h: innerHeight }));
    Assert.lessOrEqual(wrapper.bottom, innerHeight, "the tab box fits");
    Assert.lessOrEqual(panel.right, wrapper.right + 1, "so does the panel");
    Assert.lessOrEqual(panel.bottom, wrapper.bottom + 1);
    Assert.lessOrEqual(close.right, panel.right, "its close button shows");
    Assert.equal(close.width, 24, "whole");
    Assert.lessOrEqual(composer.bottom, panel.bottom, "and its request box");
    Assert.greater(composer.height, 30);
    conversation.messages.length = 0;
    conversation.changed();

    EventUtils.synthesizeKey("KEY_Escape");
    Assert.equal(
      document.activeElement,
      tab.linkedBrowser,
      "Escape goes back to the page"
    );
    ok(!root.hidden, "and the panel stays beside it");
  }

  await SpecialPowers.pushPrefEnv({
    set: [["lazyvimium.agent.width", Math.ceil(fullWidth)]],
  });
  Assert.equal(
    root.getAttribute("layout"),
    "float",
    "with no room beside the tab it floats"
  );
  ok(root.hasAttribute("fallback"));
  Assert.equal(
    root.querySelector(".layout-split").getAttribute("aria-pressed"),
    "true",
    "split stays picked"
  );

  await SpecialPowers.pushPrefEnv({
    set: [
      ["lazyvimium.agent.width", 360],
      ["lazyvimium.agent.layout", "float"],
      ["lazyvimium.agent.side", "left"],
    ],
  });
  Assert.equal(root.getAttribute("side"), "left");
  root.querySelector(".side").click();
  Assert.equal(
    Services.prefs.getStringPref("lazyvimium.agent.side"),
    "right",
    "the side button moves it across"
  );
  root.querySelector(".layout-slide").click();
  Assert.equal(root.getAttribute("layout"), "slide");

  // Slid in, it hides once the mouse leaves it.
  await Promise.all(root.getAnimations().map(animation => animation.finished));
  EventUtils.synthesizeMouseAtCenter(root, { type: "mousemove" });
  EventUtils.synthesizeMouse(panels, 20, 20, { type: "mousemove" });
  await TestUtils.waitForCondition(
    () => root.hidden,
    "the slid-in panel hides when the mouse leaves"
  );
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
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
