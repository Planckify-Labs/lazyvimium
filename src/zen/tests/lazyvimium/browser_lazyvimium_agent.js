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

add_task(async function test_act_survives_a_ticking_row_and_guessed_names() {
  const tab = await openPage();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  await SpecialPowers.spawn(browser, [], () => {
    const row = content.document.createElement("div");
    row.id = "row";
    row.innerHTML =
      '<a id="pair" href="#pair">Token</a> <span id="price">$0.0004425</span> <span id="age">13h</span>';
    content.document.body.append(row);
  });
  let { text } = await box.callTool("page_observe", {});
  const pair = idOf(text, 'link "Token"');

  // A market data row rewrites its numbers every few seconds.
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("price").textContent = "$0.0004591";
    content.document.getElementById("age").textContent = "14h";
  });
  // The wrong names an agent guessed in dev logs: id for element.
  let result = await box.callTool("page_act", { action: "click", id: pair });
  ok(!result.isError, result.text);

  // Other words in the row are another row in a reused node.
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("price").textContent = "delisted";
  });
  result = await box.callTool("page_act", { action: "click", element: pair });
  ok(result.isError, "a row with other words is not clicked");
  ok(result.text.includes("changed since it was observed"), result.text);

  // agy's wrapper around the same call, and a call with no element at all.
  ({ text } = await box.callTool("page_observe", {}));
  result = await box.callTool("call_mcp_tool", {
    ServerName: "lazyvimium",
    ToolName: "page_act",
    Arguments: { action: "click", target: idOf(text, 'link "Token"') },
  });
  ok(!result.isError, result.text);
  result = await box.callTool("page_act", { action: "click" });
  ok(result.isError && result.text.includes('needs "element"'), result.text);
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

  // A fast turn can glow for less than one poll: watch the attribute from
  // before the request.
  const glowed = BrowserTestUtils.waitForMutationCondition(
    browser,
    { attributeFilter: ["lazyvimium-agent-driving"] },
    () => browser.hasAttribute("lazyvimium-agent-driving")
  );
  EventUtils.sendString("press go");
  EventUtils.synthesizeKey("KEY_Enter");
  await glowed;
  ok(true, "the tab glows while the agent works");
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
      ["lazyvimium.agent.width", 420],
    ],
  });
  await openDock(tab);
  const root = dockElement();
  Assert.equal(root.parentNode.id, "zen-tabbox-wrapper");
  if (fullWidth - 420 >= 440) {
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

    await SpecialPowers.pushPrefEnv({
      set: [["lazyvimium.agent.width", Math.ceil(fullWidth)]],
    });
    Assert.equal(
      root.getAttribute("layout"),
      "split",
      "a panel wider than the room gives up its width instead of floating"
    );
    await Promise.all(
      root.getAnimations().map(animation => animation.finished)
    );
    Assert.greaterOrEqual(
      Math.ceil(panels.getBoundingClientRect().width),
      420,
      "and the tab keeps its room"
    );
    await SpecialPowers.popPrefEnv();
  }

  // Four panes side by side leave no room beside any of them.
  const others = [await openPage(), await openPage(), await openPage()];
  const splitDone = BrowserTestUtils.waitForEvent(
    window,
    "ZenViewSplitter:SplitViewActivated"
  );
  gZenViewSplitter.splitTabs([tab, ...others], "vsep", 0);
  await splitDone;
  await TestUtils.waitForCondition(
    () => root.getAttribute("layout") == "float",
    "with no room beside the tab it floats"
  );
  ok(root.hasAttribute("fallback"));
  Assert.equal(
    root.querySelector(".layout-split").getAttribute("aria-pressed"),
    "true",
    "split stays picked"
  );
  ok(
    !root.querySelector(".lazyvimium-agent-grip").hasAttribute("disabled"),
    "floating, it can still be widened"
  );
  gZenViewSplitter.unsplitCurrentView();
  for (const other of others) {
    BrowserTestUtils.removeTab(other);
  }
  gBrowser.selectedTab = tab;

  await SpecialPowers.pushPrefEnv({
    set: [
      ["lazyvimium.agent.width", 420],
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
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_dock_resizes_from_its_inner_edge() {
  await scriptedAgent([]);
  registerCleanupFunction(async () => {
    // Dragging and double-clicking set the pref themselves.
    Services.prefs.clearUserPref("lazyvimium.agent.width");
    if (!dockElement().hidden) {
      await closeDock();
    }
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["lazyvimium.agent.layout", "float"],
      ["lazyvimium.agent.side", "right"],
    ],
  });
  const tab = await openPage();
  await openDock(tab);
  const root = dockElement();
  const grip = root.querySelector(".lazyvimium-agent-grip");
  await Promise.all(root.getAnimations().map(animation => animation.finished));
  const width = () => Math.round(root.getBoundingClientRect().width);
  Assert.equal(width(), 420, "it opens at its narrowest");

  // Synthesized coordinates are from the grip, as it is when each is sent.
  const drag = by => {
    EventUtils.synthesizeMouse(grip, 4, 100, { type: "mousedown" });
    EventUtils.synthesizeMouse(grip, 4 + by, 100, { type: "mousemove" });
    EventUtils.synthesizeMouse(grip, 4, 100, { type: "mouseup" });
  };
  drag(-100);
  await TestUtils.waitForCondition(
    () => Services.prefs.getIntPref("lazyvimium.agent.width") == 520,
    "dragging the edge toward the page widens it"
  );
  Assert.equal(width(), 520);
  drag(300);
  await TestUtils.waitForCondition(
    () => Services.prefs.getIntPref("lazyvimium.agent.width") == 420,
    "but never narrower than it opened"
  );
  drag(-60);
  await TestUtils.waitForCondition(() => width() == 480, "wider again");
  EventUtils.synthesizeMouse(grip, 4, 100, { clickCount: 1 });
  EventUtils.synthesizeMouse(grip, 4, 100, { clickCount: 2 });
  await TestUtils.waitForCondition(
    () => !Services.prefs.prefHasUserValue("lazyvimium.agent.width"),
    "a double-click takes it back to its narrowest"
  );
  Assert.equal(width(), 420);

  await SpecialPowers.pushPrefEnv({
    set: [["lazyvimium.agent.side", "left"]],
  });
  Assert.greater(
    grip.getBoundingClientRect().left,
    root.getBoundingClientRect().left + 400,
    "on the left the edge is on its right"
  );
  drag(80);
  await TestUtils.waitForCondition(
    () => Services.prefs.getIntPref("lazyvimium.agent.width") == 500,
    "and dragging it right widens it"
  );
  await SpecialPowers.popPrefEnv();

  // From the agent's answers: a table wider than the panel squeezed to a
  // letter or two per line instead of scrolling.
  const conversation = LazyvimiumAgents.conversationFor(tab.linkedBrowser);
  const columns = [
    "Laptop",
    "Price",
    "Weight",
    "Battery",
    "Display",
    "Ports",
    "Keyboard",
    "Webcam",
    "Speakers",
    "Warranty",
  ];
  conversation.messages.push({
    type: "agent",
    text: [
      `| ${columns.join(" | ")} |`,
      `|${columns.map(() => "---").join("|")}|`,
      "| ThinkPad X1 Carbon | $1,749 | 1.12 kg | 15 hours | 14 inch OLED | Thunderbolt 4 | Backlit | 1080p | Dolby Atmos | 3 years |",
    ].join("\n"),
  });
  conversation.changed();
  const scroller = await TestUtils.waitForCondition(
    () => root.querySelector(".lazyvimium-md-table"),
    "the table is drawn"
  );
  Assert.greater(
    scroller.scrollWidth,
    scroller.clientWidth,
    "the table scrolls sideways"
  );
  const header = scroller.querySelector("th");
  Assert.less(
    header.getBoundingClientRect().height,
    30,
    "its header stays on one line"
  );
  Assert.notEqual(
    getComputedStyle(scroller).scrollbarColor,
    "auto",
    "in lazyvimium's scrollbar colors"
  );
  conversation.messages.length = 0;
  conversation.changed();

  await closeDock();
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

// From dev testing on a reCAPTCHA page: a frame of another site, in another
// process, was an empty box to the agent, which scrolled looking for it.
add_task(async function test_frames_of_other_sites_are_read_and_driven() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    ROOT + "file_agent_frame_host.html"
  );
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  const frame = browser.browsingContext.children.find(
    child => child.currentURI?.host == "example.org"
  );
  ok(frame, "the card form is a frame of another site");
  Assert.notEqual(
    frame.currentWindowGlobal.domProcess.childID,
    browser.browsingContext.currentWindowGlobal.domProcess.childID,
    "in another process"
  );

  const { text } = await box.callTool("page_observe", {});
  ok(text.includes(`Frame f${frame.id} "Card form" at `), text);
  ok(!text.includes("(could not be read)"), "nothing is left unread");
  ok(text.includes("Card frame") || text.includes("idle"), "its text");
  const pay = text.match(
    new RegExp(`\\[(f${frame.id}\\.e\\d+)\\] button "Pay now"`)
  );
  ok(pay, "its button has an id of its own");
  const card = text.match(
    new RegExp(`\\[(f${frame.id}\\.e\\d+)\\] textbox "Card number"`)
  );
  ok(card, "so does its field");
  ok(!/Frame f\d+ .*about:blank/.test(text), "a 1px frame is left out");

  let result = await box.callTool("page_act", {
    action: "fill",
    element: card[1],
    text: "4242",
  });
  ok(!result.isError, result.text);
  Assert.equal(
    await SpecialPowers.spawn(
      frame,
      [],
      () => content.document.getElementById("card").value
    ),
    "4242",
    "text goes into the frame"
  );
  result = await box.callTool("page_act", { action: "click", element: pay[1] });
  ok(!result.isError, result.text);
  Assert.equal(
    await SpecialPowers.spawn(
      frame,
      [],
      () => content.document.getElementById("out").textContent
    ),
    "paid",
    "a trusted click lands in the frame"
  );

  result = await box.callTool("page_act", {
    action: "click",
    element: "f99999.e1",
  });
  ok(
    result.isError && result.text.includes("no longer on the page"),
    "a frame that is gone is stale"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_screenshot_returns_a_jpeg_of_the_tab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    ROOT + "file_agent_frame_host.html"
  );
  const { box } = toolbox(tab);
  const result = await box.callTool("page_screenshot", {});
  ok(!result.isError, result.text);
  Assert.equal(result.image.mimeType, "image/jpeg");
  const bytes = atob(result.image.data);
  Assert.equal(bytes.slice(0, 3), "\xff\xd8\xff", "a JPEG");
  Assert.greater(bytes.length, 1000, "with something in it");
  ok(/^Screenshot of t\d+, \d+x\d+px/.test(result.text), result.text);
  BrowserTestUtils.removeTab(tab);
});

const RICH = `<!doctype html><title>Rich page</title>
<body style="margin: 20px">
  <header><h1>Shop</h1></header>
  <nav aria-label="Main"><a href="#a">Home</a><a href="#b">Orders</a></nav>
  <main>
    <h2>Sign up</h2>
    <form id="signup" aria-label="Sign up" onsubmit="event.preventDefault()">
      <input id="email" type="email" aria-label="Email" required aria-invalid="true"
             aria-describedby="hint">
      <p id="hint">We never share it</p>
      <button id="mute" type="button" aria-pressed="true">Mute</button>
      <details><summary>More options</summary><p>Hidden detail</p></details>
    </form>
    <div id="list"></div>
    <button id="load" type="button">Load more</button>
    <button id="swap" type="button">Swap</button>
    <div id="slot"><button id="buy" type="button">Buy now</button></div>
    <div style="height: 3000px">tall</div>
    <h2>Far below</h2>
    <button id="bottom" type="button">At the bottom</button>
  </main>
  <footer>Legal</footer>
  <script>
    document.getElementById("load").addEventListener("click", () => {
      setTimeout(() => {
        const b = document.createElement("button");
        b.textContent = "Loaded item";
        document.getElementById("list").append(b);
      }, 300);
    });
    document.getElementById("swap").addEventListener("click", () => {
      const slot = document.getElementById("slot");
      slot.innerHTML = '<button id="buy2" type="button">Buy now</button>';
    });
  </script>
</body>`;

async function openRich() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," + encodeURIComponent(RICH)
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  return tab;
}

// What only the accessibility tree knows: the description a field points at,
// that it is required and invalid, and that a toggle is pressed.
add_task(async function test_the_accessibility_tree_names_and_states() {
  const tab = await openRich();
  const { box } = toolbox(tab);
  // Off by default: the markup alone, as before.
  let { text } = await box.callTool("page_observe", {});
  ok(!text.includes("description="), "the markup alone gives no description");
  ok(!text.includes("pressed="), "or pressed");
  ok(text.includes('textbox "Email"'), "but still the controls");

  await SpecialPowers.pushPrefEnv({ set: [["lazyvimium.agent.a11y", true]] });
  ({ text } = await box.callTool("page_observe", {}));
  ok(
    /\[e\d+\] textbox "Email" description="We never share it" .*required invalid/.test(
      text
    ),
    text
  );
  ok(/button "Mute" pressed=true/.test(text), "the toggle is pressed");
  ok(/button "More options" expanded=false/.test(text), "a closed details");
  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_outline_and_scope_read_a_part_of_the_page() {
  const tab = await openRich();
  const { box } = toolbox(tab);
  const full = await box.callTool("page_observe", {});
  const { text } = await box.callTool("page_observe", { outline: true });
  ok(text.includes("Outline (use an id as scope"), text);
  ok(/\[e\d+\] heading 1 "Shop"/.test(text), "the top heading");
  ok(/\[e\d+\] navigation "Main"/.test(text), "a landmark");
  ok(/\[e\d+\] main\b/.test(text), "the main region");
  ok(/heading 2 "Far below" \(out of view\)/.test(text), "what is off screen");
  const form = text.match(/\[(e\d+)\] form "Sign up"/);
  ok(form, "a named form");

  const scoped = await box.callTool("page_observe", { scope: form[1] });
  ok(!scoped.isError, scoped.text);
  ok(scoped.text.includes(`Elements in ${form[1]}:`), scoped.text);
  ok(scoped.text.includes('textbox "Email"'), "its field");
  ok(scoped.text.includes('button "More options"'), "its details");
  ok(!scoped.text.includes('"Home"'), "not the navigation");
  // The data: URL on the URL line holds the whole page; read below it.
  ok(
    !scoped.text.split("Visible text:")[1].includes("Legal"),
    "not the footer"
  );
  Assert.less(scoped.text.length, full.text.length, "so it is shorter");

  const below = text.match(/\[(e\d+)\] main/);
  const wide = await box.callTool("page_observe", { scope: below[1] });
  ok(
    wide.text.includes('button "At the bottom"'),
    "a scope reads past the window, to the bottom of the region"
  );

  const control = scoped.text.match(/\[(e\d+)\] button "Mute"/);
  const refused = await box.callTool("page_act", {
    action: "click",
    element: form[1],
  });
  ok(
    refused.isError && refused.text.includes("is a region of the outline"),
    refused.text
  );
  ok(control, "controls of the scope can be acted on");
  const bad = await box
    .callTool("page_observe", { scope: "e99999" })
    .catch(e => ({ isError: true, text: e.message }));
  ok(bad.isError && bad.text.includes("not a region"), bad.text);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_wait_returns_when_the_page_changes() {
  const tab = await openRich();
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  await box.callTool("page_act", {
    action: "click",
    element: idOf(text, 'button "Load more"'),
  });
  const started = Date.now();
  const waited = await box.callTool("page_wait", { timeout_ms: 5000 });
  ok(!waited.isError, waited.text);
  ok(waited.text.startsWith("The page changed."), waited.text.slice(0, 80));
  ok(waited.text.includes('button "Loaded item"'), "it returns the new page");
  Assert.less(Date.now() - started, 3000, "long before the timeout");

  const quiet = await box.callTool("page_wait", { timeout_ms: 400 });
  ok(
    quiet.text.startsWith("The page did not change in 400 ms."),
    quiet.text.slice(0, 80)
  );
  BrowserTestUtils.removeTab(tab);
});

// A framework re-renders a control as a new node: the old id is refused, and
// the answer names the one that took its place instead of leaving the agent
// to guess, or reusing the dead id.
add_task(async function test_a_replaced_control_is_offered_not_reused() {
  const tab = await openRich();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  const buy = idOf(text, 'button "Buy now"');
  await SpecialPowers.spawn(browser, [], () => {
    content.document.getElementById("slot").innerHTML =
      '<button id="buy2" type="button">Buy now</button>';
  });
  const result = await box.callTool("page_act", {
    action: "click",
    element: buy,
  });
  ok(result.isError, "the old id is not used");
  const hint = result.text.match(
    /was replaced by the page; (e\d+) has the same role and name/
  );
  ok(hint, result.text);
  ok(
    new RegExp(`\\[${hint[1]}\\] button "Buy now"`).test(result.text),
    "and the new observation lists it"
  );
  const again = await box.callTool("page_act", {
    action: "click",
    element: hint[1],
  });
  ok(!again.isError, again.text);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_outline_and_scope_reach_into_frames() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    ROOT + "file_agent_frame_host.html"
  );
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", { outline: true });
  const form = text.match(/\[(f\d+\.e\d+)\] form "Card details"/);
  ok(form, "the frame's form is in the outline: " + text);
  const scoped = await box.callTool("page_observe", { scope: form[1] });
  ok(!scoped.isError, scoped.text);
  const prefix = form[1].split(".")[0];
  ok(
    new RegExp(`\\[${prefix}\\.e\\d+\\] button "Pay now"`).test(scoped.text),
    "its controls keep the frame in their ids: " + scoped.text
  );
  ok(!scoped.text.includes("Checkout"), "and nothing of the host page");
  BrowserTestUtils.removeTab(tab);
});

// From dev testing on a sign-up form: a control with no accessible name makes
// the accessibility tree answer null for it, and every observation threw
// until the loop gave up after 15 seconds.
add_task(async function test_controls_without_names_do_not_break_observing() {
  const page = `<!doctype html><title>Form</title>
    <body style="margin: 20px">
      <form onsubmit="event.preventDefault()">
        <input id="plain">
        <input id="named" placeholder="Username">
        <select id="proto"><option>VMess</option><option>VLESS</option></select>
        <div role="button" tabindex="0" id="icon"></div>
        <button id="blank"></button>
        <input type="checkbox" id="agree">
        <input type="submit" id="send" value="">
      </form>
    </body>`;
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," + encodeURIComponent(page)
  );
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  const started = Date.now();
  const { text } = await box.callTool("page_observe", {});
  Assert.less(Date.now() - started, 3000, "no retrying until the timeout");
  ok(/\[e\d+\] textbox "Username"/.test(text), text);
  ok(/\[e\d+\] checkbox/.test(text), "nameless controls are still listed");

  const named = idOf(text, 'textbox "Username"');
  const result = await box.callTool("page_act", {
    action: "fill",
    element: named,
    text: "ada",
  });
  ok(!result.isError, result.text);
  Assert.equal(await content(browser, "#named", "value"), "ada");
  BrowserTestUtils.removeTab(tab);
});

const FORM = `<!doctype html><title>Sign up</title>
<style>
  .box input { opacity: 0; position: absolute; }
  .box span { display: inline-block; width: 16px; height: 16px; border: 1px solid; }
</style>
<body style="margin: 20px">
  <form id="form" onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent'">
    <table>
      <tr><td>First Name</td><td><input id="first"></td></tr>
      <tr><td>Last Name</td><td><input id="last"></td></tr>
      <tr><td>Year</td><td><select id="year"></select></td></tr>
      <tr><td>Card</td><td><select id="card">
        <option>(Select)</option><option>Visa (Preferred)</option><option>Master Card</option>
      </select></td></tr>
    </table>
    City: <input id="city">
    <p><input type="checkbox" id="news"> Send me news</p>
    <label class="box" for="terms"><input type="checkbox" id="terms"><span></span> I agree to the terms</label>
    <p>Email <input id="email" type="email" required></p>
    <button id="send">Create account</button>
    <button type="button" id="noop">Does nothing</button>
  </form>
  <p id="out">idle</p>
  <script>
    const year = document.getElementById("year");
    for (let y = 1920; y <= 2020; y++) year.append(new Option(String(y)));
  </script>
</body>`;

async function openForm() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," + encodeURIComponent(FORM)
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  return tab;
}

// From dev testing on a form laid out as a table: thirty fields named
// "textbox", filled by counting.
add_task(async function test_fields_are_named_by_the_text_beside_them() {
  const tab = await openForm();
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  ok(/\[e\d+\] textbox "First Name"/.test(text), text);
  ok(/\[e\d+\] textbox "Last Name"/.test(text), "the next row's own label");
  ok(/\[e\d+\] combobox "Year"/.test(text), "a list in a table");
  ok(/\[e\d+\] textbox "City:"/.test(text), "text just before a field");
  ok(/\[e\d+\] checkbox "Send me news"/.test(text), "text just after a box");
  ok(/\[e\d+\] textbox "Email" value="" required/.test(text), "required");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_a_box_hidden_behind_its_label_can_be_ticked() {
  const tab = await openForm();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  const terms = idOf(text, 'checkbox "I agree to the terms" checked=false');
  const result = await box.callTool("page_act", {
    action: "click",
    element: terms,
  });
  ok(!result.isError, result.text);
  ok(await content(browser, "#terms", "checked"), "ticked through its label");
  ok(
    result.text.includes('checkbox "I agree to the terms" checked=true'),
    "and the page after says so"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_long_lists_say_so_and_select_forgives() {
  const tab = await openForm();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  ok(
    text.includes("and 71 more (select takes any option's text)"),
    "a list longer than shown says how much longer"
  );
  let result = await box.callTool("page_act", {
    action: "select",
    element: idOf(text, 'combobox "Year"'),
    text: "1990",
  });
  ok(!result.isError, result.text);
  Assert.equal(await content(browser, "#year", "value"), "1990");
  result = await box.callTool("page_act", {
    action: "select",
    element: idOf(result.text, 'combobox "Card"'),
    text: "visa",
  });
  ok(!result.isError, result.text);
  Assert.equal(await content(browser, "#card", "value"), "Visa (Preferred)");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_keys_by_the_names_agents_use() {
  const tab = await openForm();
  const browser = tab.linkedBrowser;
  browser.focus();
  await SpecialPowers.spawn(browser, [], () => content.focus());
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  const news = idOf(text, 'checkbox "Send me news"');
  let result = await box.callTool("page_act", {
    action: "press",
    element: news,
    text: "Space",
  });
  ok(!result.isError, result.text);
  ok(await content(browser, "#news", "checked"), "Space ticks a box");

  result = await box.callTool("page_act", {
    action: "press",
    text: "Shift+Tab",
  });
  ok(!result.isError, result.text);
  Assert.equal(
    await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.activeElement.id
    ),
    "city",
    "Shift+Tab goes back a field"
  );

  await box.callTool("page_act", {
    action: "fill",
    element: idOf(result.text, 'textbox "City:"'),
    text: "Springfield",
  });
  result = await box.callTool("page_act", {
    action: "press",
    text: "Control+a",
  });
  ok(!result.isError, result.text);
  Assert.deepEqual(
    await SpecialPowers.spawn(browser, [], () => {
      const city = content.document.getElementById("city");
      return [city.selectionStart, city.selectionEnd];
    }),
    [0, "Springfield".length],
    "Control+a selects the field's text"
  );
  const unknown = await box.callTool("page_act", {
    action: "press",
    text: "Hyper+Q",
  });
  ok(
    unknown.isError && unknown.text.includes("Shift+Tab"),
    "unknown keys say what works"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_actions_say_when_nothing_changed() {
  const tab = await openForm();
  const browser = tab.linkedBrowser;
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  const result = await box.callTool("page_act", {
    action: "click",
    element: idOf(text, 'button "Does nothing"'),
  });
  ok(!result.isError, result.text);
  ok(result.text.includes("Nothing on the page changed."), result.text);

  // The browser refuses an invalid email; the field says why.
  let after = await box.callTool("page_act", {
    action: "fill",
    element: idOf(result.text, 'textbox "Email"'),
    text: "not-an-email",
  });
  after = await box.callTool("page_act", {
    action: "click",
    element: idOf(after.text, 'button "Create account"'),
  });
  Assert.equal(await content(browser, "#out"), "idle", "not sent");
  ok(/textbox "Email" .*invalid error="/.test(after.text), after.text);
  BrowserTestUtils.removeTab(tab);
});

// From dev testing on app-like pages: the window does not scroll, a panel
// does, and the observation said "0 of 0px" over a long list.
add_task(async function test_scroll_reports_the_panel_that_scrolls() {
  const page = `<!doctype html><title>App</title>
    <body style="margin: 0; overflow: hidden; height: 100vh">
      <div id="panel" style="height: 100vh; overflow: auto">
        <div style="height: 3000px">Top of the list</div>
        <button>Last item</button>
      </div>
    </body>`;
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html," + encodeURIComponent(page)
  );
  const { box } = toolbox(tab);
  const { text } = await box.callTool("page_observe", {});
  const total = Number(text.match(/Scroll: 0 of (\d+)px/)?.[1]);
  Assert.greater(total, 1000, text.split("\n").slice(0, 4).join(" / "));
  let result;
  for (let i = 0; i < 20; i++) {
    result = await box.callTool("page_act", { action: "scroll", text: "down" });
    if (result.text.startsWith("Did not scroll")) {
      break;
    }
  }
  ok(
    result.text.startsWith("Did not scroll: already at the bottom."),
    result.text.slice(0, 80)
  );
  ok(result.text.includes('button "Last item"'), "and it got there");
  BrowserTestUtils.removeTab(tab);
});
