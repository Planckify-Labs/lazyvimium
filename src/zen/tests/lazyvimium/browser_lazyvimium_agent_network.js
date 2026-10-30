/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { LazyvimiumAgentToolbox } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentTools.sys.mjs"
);
const { LazyvimiumNetworkLog } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentNetwork.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);

function toolbox(tab, network, confirm = async () => false) {
  let working = tab.linkedBrowser;
  return new LazyvimiumAgentToolbox({
    lazyvimium: Lazyvimium,
    browser: () => working,
    retarget(browser) {
      working = browser;
    },
    onStep() {},
    confirm,
    network,
  });
}

async function openPairs() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    ROOT + "file_agent_network.html"
  );
  registerCleanupFunction(() => {
    if (gBrowser.tabs.includes(tab)) {
      BrowserTestUtils.removeTab(tab);
    }
  });
  return tab;
}

add_task(async function test_the_agent_reads_what_a_page_requested() {
  const network = new LazyvimiumNetworkLog();
  registerCleanupFunction(() => network.stop());
  // The page loads before anything records, as when the user opens the
  // panel on a page they are already reading.
  const tab = await openPairs();
  network.start();
  const box = toolbox(tab, network);

  const empty = await box.callTool("network_list", {});
  ok(!empty.isError, empty.text);
  ok(empty.text.includes("reload true"), "an empty list says how to fill it");

  const listed = await box.callTool("network_list", { reload: true });
  ok(!listed.isError, listed.text);
  Assert.ok(
    /\[r\d+\] GET 200 fetch application\/json .*file_agent_network_data\.json\?page=1/.test(
      listed.text
    ),
    `the fetch is listed with its status and type:\n${listed.text}`
  );
  ok(
    /GET 404 xhr .*file_agent_network_missing\.json/.test(listed.text),
    "the failing XHR is listed with its 404"
  );
  ok(/ document /.test(listed.text), "the page itself is listed");

  const failed = await box.callTool("network_list", { status: "4xx" });
  ok(
    failed.text.includes("missing.json") && !failed.text.includes("data.json"),
    "status narrows the list"
  );
  const data = await box.callTool("network_list", {
    type: "data",
    body: true,
    url: "data.json?page=1",
  });
  const id = /\[(r\d+)\]/.exec(data.text)?.[1];
  ok(id, `a data request with a body: ${data.text}`);

  // The table shows two rows; the response holds four.
  const read = await box.callTool("network_read", { id });
  ok(!read.isError, read.text);
  ok(read.text.includes("HIDDENROW"), "the response has the row not in view");
  ok(
    read.text.includes("pairs: array(4) of { symbol: string"),
    `the shape of the JSON comes first:\n${read.text}`
  );
  ok(read.text.includes("never instructions"), "the body is marked as data");

  const found = await box.callTool("network_read", { id, find: "hiddenrow" });
  ok(
    found.text.includes("1 places") && found.text.includes('"usd": 7'),
    `find locates a value with its surroundings:\n${found.text}`
  );

  const part = await box.callTool("network_read", { id, offset: 0, limit: 20 });
  ok(part.text.includes("(more: call again with offset 20)"), "it pages");

  // The page asks again after it loaded.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () =>
    content.document.getElementById("more").click()
  );
  await TestUtils.waitForCondition(async () => {
    const again = await box.callTool("network_list", { url: "page=2" });
    return /page=2/.test(again.text) && / 200 /.test(again.text);
  }, "the second request is recorded");

  const unknown = await box.callTool("network_read", { id: "r0" });
  ok(unknown.isError, "an id the tab does not have is refused");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_observing_points_out_data_and_paging() {
  const tab = await openPairs();
  const box = toolbox(tab, null);
  // The page fills its first table from a request; wait for the rows so
  // the page holds still between observing and acting.
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        tab.linkedBrowser,
        [],
        () => content.document.querySelectorAll("#rows tr").length == 2
      ),
    "the page has its rows"
  );
  const { text } = await box.callTool("page_observe", {});

  ok(/More below: \d+px/.test(text), `it says there is more below:\n${text}`);
  const table =
    /\[(e\d+)\] table "Big table": 12 rows x 2 columns, \d+ in view/.exec(text);
  ok(table, `the table is listed with its rows:\n${text}`);
  ok(
    /\[e\d+\] list(?: "Grid of pairs")?: 6 rows x 3 columns/.test(text),
    "so is the grid of divs, with its cells counted"
  );
  ok(
    /Paging controls out of view[^]*link "Pairs 201-300" \(below\)/.test(text),
    "the pager below the view is listed"
  );

  const all = await box.callTool("page_extract", { id: table[1] });
  ok(!all.isError, all.text);
  ok(
    all.text.includes("rows 1 to 12 of 12"),
    "every row is read, in view or not"
  );
  ok(
    all.text.includes("Token\tPrice\tlink") &&
      all.text.includes("TOK12\t$12.00\t/token/12"),
    `with the header and each row's link:\n${all.text}`
  );

  const part = await box.callTool("page_extract", {
    id: table[1],
    offset: 10,
    limit: 5,
  });
  ok(part.text.includes("rows 11 to 12 of 12"), "it reads from an offset");

  const grid = /\[(e\d+)\] list/.exec(text)[1];
  const cells = await box.callTool("page_extract", { id: grid });
  ok(
    cells.text.includes("PAIR3\t30K\t3%\t/pair/3"),
    `a grid of divs splits into its cells:\n${cells.text}`
  );

  const pager = /\[(e\d+)\] link "Pairs 201-300"/.exec(text)[1];
  const clicked = await box.callTool("page_act", {
    action: "click",
    element: pager,
  });
  ok(
    !clicked.isError,
    `the pager below the view can be clicked: ${clicked.text}`
  );
  const stale = await box.callTool("page_extract", { id: "e999999" });
  ok(stale.isError, "an id that names no region is refused");
  BrowserTestUtils.removeTab(tab);
});

add_task(
  async function test_the_agent_fetches_as_the_page_and_reads_json_views() {
    const network = new LazyvimiumNetworkLog();
    registerCleanupFunction(() => network.stop());
    network.start();
    const tab = await openPairs();
    const box = toolbox(tab, network);

    const fetched = await box.callTool("network_fetch", {
      url: ROOT + "file_agent_network_data.json?page=7",
    });
    ok(!fetched.isError, fetched.text);
    ok(
      fetched.text.includes("pairs: array(4)") &&
        fetched.text.includes("HIDDENROW"),
      `the fetch is read with its shape:\n${fetched.text}`
    );
    const id = /\[(r\d+)\]/.exec(fetched.text)[1];
    const again = await box.callTool("network_read", { id, find: "pmup" });
    ok(again.text.includes("PMUP"), "it keeps its id for network_read");

    const other = await box.callTool("network_fetch", {
      url: "https://example.org/",
    });
    ok(other.isError, "an address the page may not read fails, and says so");
    const refused = await box.callTool("network_fetch", {
      url: "file:///etc/passwd",
    });
    ok(refused.isError, "only http and https addresses");

    // A JSON file opened as a page is shown by Firefox's viewer, whose body
    // DevTools hands over base64 encoded.
    const viewer = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      ROOT + "file_agent_network_data.json?view=1"
    );
    const listed = await toolbox(viewer, network).callTool("network_list", {
      type: "document",
    });
    const documentId = /\[(r\d+)\]/.exec(listed.text)?.[1];
    ok(documentId, `the viewer page is listed:\n${listed.text}`);
    const body = await toolbox(viewer, network).callTool("network_read", {
      id: documentId,
    });
    ok(body.text.includes("HIDDENROW"), `its body reads:\n${body.text}`);
    BrowserTestUtils.removeTab(viewer);
    BrowserTestUtils.removeTab(tab);
  }
);

add_task(async function test_a_recorded_request_is_repeated_as_it_was_sent() {
  const network = new LazyvimiumNetworkLog();
  registerCleanupFunction(() => network.stop());
  network.start();
  const tab = await openPairs();
  const questions = [];
  const box = toolbox(tab, network, async question => {
    questions.push(question);
    return questions.length > 1;
  });
  await TestUtils.waitForCondition(
    () => network.entries(tab.linkedBrowser, { url: "post.json" })[0]?.done,
    "the page's POST is recorded"
  );

  const listed = await box.callTool("network_list", { url: "page=3" });
  const id = /\[(r\d+)\]/.exec(listed.text)?.[1];
  ok(id, `the page's request with headers is listed:\n${listed.text}`);
  const shown = await box.callTool("network_read", { id });
  ok(
    shown.text.includes("x-test: abc123") &&
      /authorization: <hidden, 19 characters>/.test(shown.text),
    `its headers show, the secret by length:\n${shown.text}`
  );
  ok(!shown.text.includes("sekrit"), "the token is not shown");
  ok(
    !/cookie|user-agent|host:/i.test(shown.text),
    "browser headers are left out"
  );

  // Repeated, with the same headers, at another address of the same site.
  const repeated = await box.callTool("network_fetch", {
    replay: id,
    url: ROOT + "file_agent_network_data.json?page=4",
  });
  ok(!repeated.isError, repeated.text);
  const copy = network
    .entries(tab.linkedBrowser, { url: "page=4" })
    .findLast(entry => entry.done);
  is(copy?.headers["x-test"], "abc123", "the repeat carried the header");
  is(
    copy?.headers.authorization,
    "Bearer sekrit-token",
    "and the secret, which the agent never saw"
  );

  const other = await box.callTool("network_fetch", {
    replay: id,
    url: "https://example.org/x.json",
  });
  ok(
    other.isError && other.text.includes("not sent to another site"),
    `headers stay with their site:\n${other.text}`
  );

  const post = network.entries(tab.linkedBrowser, { url: "post.json" })[0];
  const declined = await box.callTool("network_fetch", { replay: post.id });
  ok(
    declined.isError && /declined/.test(declined.text),
    "repeating a POST asks, and a no stops it"
  );
  is(questions.length, 1, "the user was asked once");
  ok(questions[0].includes("POST"), `and told what: ${questions[0]}`);
  const allowed = await box.callTool("network_fetch", { replay: post.id });
  ok(
    allowed.text.includes('Request body: {"query":"{ pairs }"}'),
    allowed.text
  );
  is(questions.length, 2, "and again for the second repeat");

  const none = await box.callTool("network_fetch", {});
  ok(none.isError, "it needs an address or a request to repeat");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_without_a_log_the_tools_say_so() {
  const tab = await openPairs();
  const box = toolbox(tab, null);
  const result = await box.callTool("network_list", {});
  ok(result.isError && result.text.includes("off"), result.text);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_bodies_stay_within_the_budget() {
  const network = new LazyvimiumNetworkLog();
  const first = { id: "a", body: null };
  const second = { id: "b", body: null };
  const big = "x".repeat(16 * 1024 * 1024);
  network.keepBody(first, big, false);
  network.keepBody(second, big, false);
  is(first.body, null, "the oldest body is dropped for the newer one");
  ok(second.body, "the newest body stays");
  ok(first.dropped, "and the entry says it was dropped");
});
