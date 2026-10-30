/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Tables and pages the agent shows in the panel, from a fake Claude that
// calls the browser's MCP server with curl.

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { LazyvimiumAgents } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs"
);
const { tabIdOf } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentTools.sys.mjs"
);

const dock = () => Lazyvimium.agentDockFor(window);
const dockElement = () => document.getElementById("lazyvimium-agent-dock");
const uiRows = () =>
  dockElement().querySelectorAll('.lazyvimium-agent-message[type="ui"]');

// A fake Claude running `body` (sh) with call FILE posting
// <dir>/FILE.json to the MCP server; returns the directory for the files.
async function fakeAgent(body) {
  const dir = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "lzv-ui-agent"
  );
  const script = PathUtils.join(dir, "claude");
  await IOUtils.writeUTF8(
    script,
    `#!/bin/sh
dir='${dir}'
call() {
  curl -sS -H "Authorization: Bearer $LAZYVIMIUM_MCP_TOKEN" \\
    -H 'Content-Type: application/json' --data-binary @"$dir/$1.json" "$LAZYVIMIUM_MCP_URL"
}
say() {
  printf '%s\\n' "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"$1\\"}]}}"
}
echo '{"type":"system","subtype":"init","session_id":"ui-1"}'
${body}
echo '{"type":"result","is_error":false,"result":"done","session_id":"ui-1"}'
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

let gCallIds = 0;
function writeCall(dir, file, name, args) {
  return IOUtils.writeJSON(PathUtils.join(dir, `${file}.json`), {
    jsonrpc: "2.0",
    id: ++gCallIds,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

async function openTab() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "data:text/html,<title>Shop</title><p>shop"
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  return tab;
}

async function ask(tab, text) {
  await dock().open(tab.linkedBrowser);
  const input = dockElement().querySelector(".lazyvimium-agent-input");
  await TestUtils.waitForCondition(
    () => document.activeElement == input,
    "the dock has the keys"
  );
  input.value = text;
  EventUtils.synthesizeKey("KEY_Enter");
}

async function turnEnds(tab) {
  await TestUtils.waitForCondition(
    () => !LazyvimiumAgents.conversationFor(tab.linkedBrowser)?.running,
    "the turn ends"
  );
}

// The page's frame in its browser, once the page is in.
async function pageFrame(browser) {
  await TestUtils.waitForCondition(
    () =>
      browser.currentURI?.schemeIs("data") &&
      browser.browsingContext?.children[0]?.currentWindowGlobal?.documentURI
        ?.spec == "about:srcdoc",
    "the page loads"
  );
  return browser.browsingContext.children[0];
}

async function closeAndRemove(tab) {
  dock().close();
  await TestUtils.waitForCondition(() => dockElement().hidden, "closed");
  LazyvimiumAgents.reset(tab.linkedBrowser);
  BrowserTestUtils.removeTab(tab);
}

add_task(async function test_a_live_table_sorts_filters_copies_and_updates() {
  const tab = await openTab();
  const other = await openTab();
  gBrowser.selectedTab = tab;
  const otherId = tabIdOf(other);
  const rows = [
    { cells: ["ThinkPad X1", "$1,749", "1.12 kg"], tab: otherId },
    { cells: ["MacBook Air", "$1,099", "1.24 kg"] },
    { cells: ["XPS 13", "$999", "—"] },
    { cells: ["Zenbook 14", "$1,299", "1.2 kg"] },
    { cells: ["Swift Go", "$799", "1.3 kg"] },
    { cells: ["Galaxy Book", "$1,399", "1.17 kg"] },
  ];
  const dir = await fakeAgent(`call first > /dev/null
say 'Compared them'
while [ ! -f "$dir/go" ]; do sleep 0.1; done
call second > "$dir/second-result"`);
  const table = {
    id: "laptops",
    title: "Laptops",
    columns: ["Model", "Price", "Weight"],
    rows,
    note: "Prices from the open tabs",
  };
  await writeCall(dir, "first", "ui_table", table);
  await writeCall(dir, "second", "ui_table", {
    ...table,
    rows: [...rows, { cells: ["Gram 14", "$1,199", "0.99 kg"] }],
  });
  await ask(tab, "compare the laptops");

  await TestUtils.waitForCondition(() => uiRows().length == 1, "a table");
  const row = uiRows()[0];
  const cells = column =>
    [...row.querySelectorAll("tbody tr")].map(
      tr => tr.children[column].textContent
    );
  Assert.equal(
    row.querySelector(".lazyvimium-ui-title").textContent,
    "Laptops"
  );
  Assert.equal(row.querySelector(".lazyvimium-ui-count").textContent, "6 rows");
  Assert.equal(
    row.querySelector(".lazyvimium-ui-note").textContent,
    "Prices from the open tabs"
  );
  ok(
    row.querySelectorAll("th")[1].hasAttribute("numeric"),
    "prices sort and align as numbers"
  );
  ok(
    ![
      ...dockElement().querySelectorAll(
        '.lazyvimium-agent-message[type="tool"]'
      ),
    ].length,
    "no tool row for it"
  );

  const sortBy = column =>
    row.querySelectorAll(".lazyvimium-ui-sort")[column].click();
  sortBy(1);
  Assert.deepEqual(cells(1), [
    "$799",
    "$999",
    "$1,099",
    "$1,299",
    "$1,399",
    "$1,749",
  ]);
  Assert.equal(
    row.querySelectorAll("th")[1].getAttribute("aria-sort"),
    "ascending"
  );
  sortBy(1);
  Assert.equal(cells(1)[0], "$1,749", "then descending");
  sortBy(2);
  Assert.equal(cells(2).at(-1), "—", "a cell saying nothing goes last");
  sortBy(2);
  Assert.equal(cells(2).at(-1), "—", "either way");
  sortBy(1);

  const filter = row.querySelector(".lazyvimium-ui-filter");
  ok(!filter.hidden, "six rows get a filter box");
  filter.focus();
  EventUtils.sendString("book");
  Assert.deepEqual(
    cells(0),
    ["MacBook Air", "Zenbook 14", "Galaxy Book"],
    "filtered, still by price"
  );
  Assert.equal(row.querySelector(".lazyvimium-ui-count").textContent, "3 of 6");

  row.querySelector(".lazyvimium-ui-button").click();
  Assert.equal(
    SpecialPowers.getClipboardData("text/plain"),
    'Model,Price,Weight\nMacBook Air,"$1,099",1.24 kg\nZenbook 14,"$1,299",1.2 kg\nGalaxy Book,"$1,399",1.17 kg',
    "Copy CSV copies what shows"
  );

  // The agent updates the table while the user sorted and filtered it.
  await IOUtils.writeUTF8(PathUtils.join(dir, "go"), "");
  await TestUtils.waitForCondition(
    () => row.querySelector(".lazyvimium-ui-count").textContent == "3 of 7",
    "the update lands in the same table"
  );
  Assert.equal(uiRows().length, 1, "no second table");
  Assert.equal(filter.value, "book", "the filter stays");
  Assert.equal(
    row.querySelectorAll("th")[1].getAttribute("aria-sort"),
    "ascending",
    "so does the sort"
  );
  filter.value = "";
  filter.dispatchEvent(new Event("input"));
  const fresh = [...row.querySelectorAll("tbody tr[fresh]")];
  Assert.deepEqual(
    fresh.map(tr => tr.children[0].textContent),
    ["Gram 14"],
    "the added row shows"
  );
  await turnEnds(tab);
  const result = await IOUtils.readUTF8(PathUtils.join(dir, "second-result"));
  ok(result.includes('call ui_table with id \\"laptops\\"'), result);

  const thinkpad = [...row.querySelectorAll("tbody tr")].find(
    tr => tr.children[0].textContent == "ThinkPad X1"
  );
  ok(thinkpad.hasAttribute("link"));
  thinkpad.click();
  Assert.equal(gBrowser.selectedTab, other, "a row brings its tab forward");
  gBrowser.selectedTab = tab;
  BrowserTestUtils.removeTab(other);
  await closeAndRemove(tab);
});

// From dev testing with Antigravity: a table of trading pairs wider than
// the panel spilled out of its card, and the whole conversation scrolled
// sideways with the title and first column out of sight.
add_task(async function test_a_wide_table_scrolls_in_its_card() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["lazyvimium.agent.layout", "float"],
      ["lazyvimium.agent.width", 420],
    ],
  });
  const tab = await openTab();
  const dir = await fakeAgent(`call wide > /dev/null
say 'Here are the pairs'`);
  const columns = [
    "Pair / Chain",
    "Market Cap (MCAP)",
    "24h Volume",
    "Unique Traders / Makers",
    "Liquidity",
    "Age",
  ];
  await writeCall(dir, "wide", "ui_table", {
    title: "Top Solana pairs by market cap",
    columns,
    rows: Array.from({ length: 5 }, (_, i) => ({
      cells: [
        `TOKEN${i} / SOL (Meteora DLMM)`,
        `$${13 - i}.2M`,
        `$${10 - i}.6M`,
        `${7980 + i}`,
        `$${400 + i}K`,
        `${i + 2} days`,
      ],
    })),
  });
  await ask(tab, "top pairs");
  await TestUtils.waitForCondition(() => uiRows().length == 1, "a table");
  await Promise.all(
    dockElement()
      .getAnimations({ subtree: true })
      .map(animation => animation.finished)
  );
  const row = uiRows()[0];
  const log = dockElement().querySelector(".lazyvimium-agent-log");
  const scroller = row.querySelector(".lazyvimium-ui-scroll");
  Assert.greater(
    scroller.scrollWidth,
    scroller.clientWidth,
    "the table scrolls sideways in its own box"
  );
  Assert.lessOrEqual(
    log.scrollWidth,
    log.clientWidth,
    "the conversation does not"
  );
  Assert.lessOrEqual(
    row.getBoundingClientRect().right,
    log.getBoundingClientRect().right,
    "the card stays inside it"
  );
  Assert.greater(
    row.querySelector(".lazyvimium-ui-title").getBoundingClientRect().width,
    100,
    "with its title in sight"
  );
  await turnEnds(tab);
  await closeAndRemove(tab);
  await SpecialPowers.popPrefEnv();
});

const PAGE_HTML = `<h1>Split the bill</h1>
<p id="result">Ready</p>
<button id="ask" type="button">Ask about this</button>
<a id="link" href="https://example.com/">Source</a>
<p id="checks"></p>`;

const PAGE_JS = `
const checks = {};
checks.origin = origin;
try { localStorage.x = 1; checks.storage = "allowed"; } catch (e) { checks.storage = e.name; }
try { checks.popup = String(window.open("https://example.com/")); } catch (e) { checks.popup = e.name; }
checks.api = typeof lazyvimium.sendPrompt;
lazyvimium.sendPrompt({ text: "on load" }).then(
  () => { checks.onLoad = "sent"; show(); },
  e => { checks.onLoad = e.message; show(); }
);
fetch("https://example.com/").then(
  () => { checks.fetch = "allowed"; show(); },
  e => { checks.fetch = e.name; show(); }
);
function show() { document.getElementById("checks").textContent = JSON.stringify(checks); }
document.getElementById("ask").addEventListener("click", async () => {
  try {
    await lazyvimium.sendPrompt({ text: "FOLLOWUP 3 people, 15% tip" });
    document.getElementById("result").textContent = "asked";
  } catch (e) {
    document.getElementById("result").textContent = e.message;
  }
});
setTimeout(() => { location.href = "https://example.com/?left"; }, 300);
show();
`;

add_task(async function test_a_page_runs_sandboxed_and_asks_back() {
  const tab = await openTab();
  const dir = await fakeAgent(`case "$*" in
*FOLLOWUP*) say 'About the scenario'; echo '{"type":"result","is_error":false,"result":"done","session_id":"ui-1"}'; exit 0;;
esac
call page > /dev/null
say 'Built it'`);
  await writeCall(dir, "page", "ui_show", {
    title: "Bill splitter",
    height: 260,
    css: "#result { font-weight: 600; }",
    html: PAGE_HTML,
    js: PAGE_JS,
  });
  await ask(tab, "split a bill");

  await TestUtils.waitForCondition(() => uiRows().length == 1, "a page");
  const row = uiRows()[0];
  const browser = row.querySelector(".lazyvimium-ui-browser");
  ok(browser.isRemoteBrowser, "in a content process");
  Assert.equal(browser.remoteType, "web");
  const tabs = gBrowser.tabs.length;
  const frame = await pageFrame(browser);
  const checks = await SpecialPowers.spawn(frame, [], async () => {
    await ContentTaskUtils.waitForCondition(() => {
      const text = content.document.getElementById("checks")?.textContent;
      return text && JSON.parse(text).onLoad && JSON.parse(text).fetch;
    }, "the page checked itself");
    return {
      ...JSON.parse(content.document.getElementById("checks").textContent),
      opaque: content.document.nodePrincipal.isNullPrincipal,
      flags: content.document.sandboxFlags,
      themed: content
        .getComputedStyle(content.document.documentElement)
        .getPropertyValue("--color-text-primary")
        .trim(),
      bold: content.getComputedStyle(content.document.getElementById("result"))
        .fontWeight,
    };
  });
  info(JSON.stringify(checks));
  Assert.equal(checks.origin, "null", "an opaque origin");
  ok(checks.opaque);
  Assert.equal(checks.storage, "SecurityError", "no storage");
  Assert.equal(checks.popup, "InvalidAccessError", "no popups");
  Assert.equal(checks.fetch, "TypeError", "no network but its CDNs");
  Assert.equal(checks.api, "function", "the bridge is there");
  ok(
    checks.onLoad.includes("only works from something the user clicked"),
    checks.onLoad
  );
  ok(
    checks.themed.includes("#c8d3f5"),
    `the browser's theme: ${checks.themed}`
  );
  Assert.equal(checks.bold, "600", "with the agent's css");
  await TestUtils.waitForCondition(
    () => parseInt(browser.style.height) > 60,
    "the page's height comes from the page"
  );

  // The page tried to leave after 300 ms.
  await new Promise(resolve => setTimeout(resolve, 800));
  ok(browser.currentURI.schemeIs("data"), "it stays the page it is");
  Assert.equal(browser.browsingContext.children[0], frame);
  Assert.equal(
    frame.currentWindowGlobal.documentURI.spec,
    "about:srcdoc",
    "in its frame too"
  );
  Assert.equal(gBrowser.tabs.length, tabs, "and opened nothing");

  await turnEnds(tab);
  const newTab = BrowserTestUtils.waitForNewTab(
    gBrowser,
    "https://example.com/"
  );
  await BrowserTestUtils.synthesizeMouseAtCenter("#link", {}, frame);
  BrowserTestUtils.removeTab(await newTab);
  gBrowser.selectedTab = tab;

  // The panel followed the new tab and back: the page loads again, in a
  // new frame.
  const again = await pageFrame(browser);
  await SpecialPowers.spawn(again, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => !!content.document.getElementById("ask"),
      "the page is back"
    );
  });
  await BrowserTestUtils.synthesizeMouseAtCenter("#ask", {}, again);
  const conversation = LazyvimiumAgents.conversationFor(tab.linkedBrowser);
  await TestUtils.waitForCondition(
    () =>
      conversation.messages.some(
        m => m.type == "user" && m.text == "FOLLOWUP 3 people, 15% tip"
      ),
    "a click asks the agent, as if the user typed it"
  );
  await turnEnds(tab);
  ok(
    conversation.messages.some(
      m => m.type == "agent" && m.text == "About the scenario"
    )
  );
  await closeAndRemove(tab);
});

add_task(async function test_a_page_shows_while_it_is_written() {
  const tab = await openTab();
  const args = {
    title: "Flow",
    height: 120,
    css: "p { margin: 0 }",
    html: '<p id="one">First step</p><p id="two">Second step</p>',
    js: 'document.getElementById("two").dataset.ran = "yes";',
  };
  const json = JSON.stringify(args);
  const cut = json.indexOf('<p id=\\"two');
  const event = e =>
    `printf '%s\\n' '${JSON.stringify({ type: "stream_event", event: e }).replaceAll("'", "'\\''")}'`;
  const dir = await fakeAgent(`${event({ type: "message_start" })}
${event({
  type: "content_block_start",
  index: 0,
  content_block: {
    type: "tool_use",
    name: "mcp__lazyvimium__ui_show",
    input: {},
  },
})}
${event({
  type: "content_block_delta",
  index: 0,
  delta: { type: "input_json_delta", partial_json: json.slice(0, cut) },
})}
while [ ! -f "$dir/go" ]; do sleep 0.1; done
${event({
  type: "content_block_delta",
  index: 0,
  delta: { type: "input_json_delta", partial_json: json.slice(cut) },
})}
call page > /dev/null
say 'Drew it'`);
  await writeCall(dir, "page", "ui_show", args);
  await ask(tab, "draw the flow");

  await TestUtils.waitForCondition(
    () => uiRows()[0]?.hasAttribute("draft"),
    "a draft shows while the page is written"
  );
  const row = uiRows()[0];
  Assert.equal(row.querySelector(".lazyvimium-ui-title").textContent, "Flow");
  Assert.equal(
    row.querySelector(".lazyvimium-ui-count").textContent,
    "building…"
  );
  const browser = row.querySelector(".lazyvimium-ui-browser");
  const draft = await SpecialPowers.spawn(
    await pageFrame(browser),
    [],
    async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.document.getElementById("one"),
        "the first step"
      );
      return {
        one: content.document.getElementById("one").textContent,
        two: !!content.document.getElementById("two"),
      };
    }
  );
  Assert.deepEqual(draft, { one: "First step", two: false });

  await IOUtils.writeUTF8(PathUtils.join(dir, "go"), "");
  await TestUtils.waitForCondition(
    () => !row.hasAttribute("draft"),
    "the finished page takes the draft's place"
  );
  Assert.equal(uiRows().length, 1, "in the same row");
  await TestUtils.waitForCondition(async () => {
    try {
      return await SpecialPowers.spawn(
        browser.browsingContext.children[0],
        [],
        () => content.document.getElementById("two")?.dataset.ran == "yes"
      );
    } catch {
      return false;
    }
  }, "and its script runs");
  await turnEnds(tab);
  Assert.equal(uiRows().length, 1, "nothing left over");
  await closeAndRemove(tab);
});
