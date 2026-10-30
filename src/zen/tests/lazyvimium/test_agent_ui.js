/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  UI_SANDBOX_FLAGS,
  dataAddress,
  frameDocument,
  isNumberColumn,
  numberOf,
  pageDocument,
  pageFromArgs,
  pageHeight,
  partialFields,
  partialHtml,
  tableFromArgs,
  toCsv,
  uiGuide,
  uiToolDefinitions,
} = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentUi.sys.mjs"
);
const { LAZYVIMIUM_DRIVERS, BROWSER_INSTRUCTIONS } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentHarness.sys.mjs"
);

add_task(function test_tools_are_described() {
  Assert.deepEqual(
    uiToolDefinitions().map(tool => tool.name),
    ["ui_table", "ui_show", "ui_guide"]
  );
  const show = uiToolDefinitions()[1];
  Assert.deepEqual(
    Object.keys(show.inputSchema.properties),
    ["title", "id", "height", "css", "html", "js"],
    "ui_show's fields in the order they should stream"
  );
  ok(BROWSER_INSTRUCTIONS.includes("ui_table"), "agents are told about them");
});

add_task(function test_table_arguments() {
  const table = tableFromArgs({
    id: "laptops",
    title: "  Laptops\n compared ",
    columns: ["Model", { name: "Price" }],
    rows: [
      { cells: ["ThinkPad X1", "$1,749"], tab: "t3" },
      { cells: ["MacBook Air"], url: "https://apple.com/" },
      ["Bare", 999, "extra cell"],
      { cells: ["Bad links", null], tab: "3", url: "javascript:alert(1)" },
    ],
    note: "Prices from the open tabs.",
  });
  Assert.equal(table.kind, "table");
  Assert.equal(table.id, "laptops");
  Assert.equal(table.title, "Laptops compared", "whitespace is tidied");
  Assert.deepEqual(table.columns, ["Model", "Price"]);
  Assert.deepEqual(
    table.rows.map(row => row.cells),
    [
      ["ThinkPad X1", "$1,749"],
      ["MacBook Air", ""],
      ["Bare", "999"],
      ["Bad links", ""],
    ],
    "one cell per column, missing ones empty, extra ones dropped"
  );
  Assert.equal(table.rows[0].tab, "t3");
  Assert.equal(table.rows[1].url, "https://apple.com/");
  Assert.equal(table.rows[3].tab, null, "a tab id must look like t3");
  Assert.equal(table.rows[3].url, null, "only http(s) rows open");

  Assert.throws(() => tableFromArgs({ title: "x", rows: [] }), /columns/);
  Assert.throws(
    () => tableFromArgs({ title: "x", columns: ["a"], rows: [{}] }),
    /Row 1 has no cells/
  );
  Assert.throws(
    () =>
      tableFromArgs({
        title: "x",
        columns: ["a"],
        rows: Array(501).fill(["v"]),
      }),
    /at most 500 rows/
  );
});

add_task(function test_numbers_for_sorting() {
  const cases = [
    ["$1,749", 1749],
    ["1,749.50", 1749.5],
    ["1.749,50 €", 1749.5],
    ["Rp 15.000.000", 15000000],
    ["Rs. 999", 999],
    ["USD 12", 12],
    ["1.12 kg", 1.12],
    ["4,5 ★", 4.5],
    ["15 hours", 15],
    ["-3", -3],
    ["−3", -3],
    ["ThinkPad X1", null],
    ["X1 Carbon", null],
    ["", null],
  ];
  for (const [cell, number] of cases) {
    Assert.equal(numberOf(cell), number, cell);
  }
  const table = tableFromArgs({
    title: "t",
    columns: ["Name", "Price", "Rating"],
    rows: [
      ["A", "$10", "4.5"],
      ["B", "—", "n/a"],
      ["C", "$9", "great"],
    ],
  });
  ok(!isNumberColumn(table, 0));
  ok(isNumberColumn(table, 1), "cells that say nothing do not count");
  ok(!isNumberColumn(table, 2));
});

add_task(function test_csv() {
  Assert.equal(
    toCsv(
      ["Name", "Note"],
      [
        ["A", 'says "hi"'],
        ["B, C", "line\nbreak"],
      ]
    ),
    'Name,Note\nA,"says ""hi"""\n"B, C","line\nbreak"'
  );
});

add_task(function test_partial_fields_follow_the_stream() {
  const json = JSON.stringify({
    title: 'Bill "splitter"',
    height: 320,
    css: "body { color: red }",
    html: "<p>Total: <b>€</b>\n</p>",
    js: "go()",
  });
  // Every prefix reads without throwing, and grows toward the whole.
  for (let i = 0; i <= json.length; i++) {
    const { fields } = partialFields(json.slice(0, i));
    for (const key of Object.keys(fields)) {
      ok(
        ["title", "height", "css", "html", "js"].includes(key),
        `${key} at ${i}`
      );
    }
  }
  Assert.deepEqual(partialFields(json), {
    fields: JSON.parse(json),
    open: null,
  });
  const cut = json.indexOf("<b>") + 2;
  Assert.deepEqual(partialFields(json.slice(0, cut)), {
    fields: {
      title: 'Bill "splitter"',
      height: 320,
      css: "body { color: red }",
      html: "<p>Total: <b",
    },
    open: "html",
  });
  Assert.deepEqual(
    partialFields('{"title": "A", "height": 3').fields,
    { title: "A" },
    "a number that may go on is left out"
  );
  Assert.deepEqual(
    partialFields('{"html": "a\\u00e9b\\u00').fields,
    { html: "aéb" },
    "an escape cut in half is left out"
  );
  Assert.deepEqual(partialFields("").fields, {});
});

add_task(function test_partial_html() {
  Assert.equal(partialHtml("<p>Hello <b"), "<p>Hello ");
  Assert.equal(partialHtml("<p>A</p><script>alert(1)"), "<p>A</p>");
  Assert.equal(
    partialHtml("<style>p{}</style><p>B</p><script>x()</script>"),
    "<p>B</p>"
  );
  Assert.equal(partialHtml("<p>Fish &am"), "<p>Fish ");
});

add_task(function test_page_arguments_and_document() {
  Assert.throws(() => pageFromArgs({ title: "x" }), /needs html/);
  Assert.throws(
    () => pageFromArgs({ title: "x", html: "a".repeat(600 * 1024) }),
    /too large/
  );
  Assert.equal(pageHeight(10), 48);
  Assert.equal(pageHeight(5000), 900);
  Assert.equal(pageHeight("tall"), 200);

  const page = pageFromArgs({
    title: "Calc",
    css: "p { color: red } </style><script>alert(1)</script>",
    html: '<p id="out">Ready</p>',
    js: 'document.getElementById("out").textContent = "</script>";',
  });
  const theme = {
    "--lazyvimium-base": "light-dark(#fff, #000)",
    "--lazyvimium-bad": "red; } body { display: none",
  };
  const shell = pageDocument(page, theme);
  ok(
    shell.includes('<iframe sandbox="allow-scripts" srcdoc="'),
    "the page is a sandboxed frame of a shell"
  );
  ok(shell.includes("frame-src 'none'"), "which cannot navigate itself");
  ok(
    !shell.replace(/srcdoc="[^"]*"/, "").includes("<script"),
    "the shell runs nothing of its own"
  );
  const srcdoc = /srcdoc="([^"]*)"/.exec(shell)[1];
  ok(!srcdoc.includes('"'), "the frame's document stays in its attribute");
  Assert.equal(
    srcdoc.replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
    frameDocument(page, theme)
  );

  const html = frameDocument(page, theme);
  ok(html.includes("Content-Security-Policy"), "a CSP");
  ok(html.includes("connect-src https://cdnjs.cloudflare.com"));
  ok(html.includes("form-action 'none'"));
  ok(html.includes("--lazyvimium-base: light-dark(#fff, #000);"));
  ok(!html.includes("body { display: none"), "a theme value cannot escape");
  ok(html.includes("--color-text-primary"), "upstream's token names");
  ok(html.includes("svg .c-blue"), "and SVG classes");
  ok(!/<\/style><script>alert/i.test(html), "css cannot close its element");
  ok(html.includes("<\\/style><script>alert(1)</script>"), "it stays text");
  ok(
    html.includes('textContent = "<\\/script>";</script>'),
    "nor can the script"
  );
  ok(html.includes('"three":"https://esm.sh/three"'), "an import map");

  const preview = frameDocument(
    { ...page, css: "p { color: red }", html: "<p>Half <b", js: "go()" },
    theme,
    { preview: true }
  );
  ok(
    pageDocument(page, theme, { preview: true }).includes(
      "default-src 'none'; style-src 'unsafe-inline'"
    ),
    "a preview's shell has the preview's CSP"
  );
  ok(!preview.includes("<script"), "a preview runs nothing");
  ok(preview.includes("default-src 'none'; style-src 'unsafe-inline'"));
  ok(preview.includes("<body><p>Half </body>"), preview);

  const address = dataAddress("<p>é</p>");
  ok(address.startsWith("data:text/html;charset=utf-8;base64,"));
  Assert.equal(
    new TextDecoder().decode(
      Uint8Array.from(atob(address.split(",")[1]), c => c.charCodeAt(0))
    ),
    "<p>é</p>"
  );
  Assert.equal(UI_SANDBOX_FLAGS & 0x80, 0, "scripts may run");
  Assert.equal(UI_SANDBOX_FLAGS & 0x2, 0x2, "popups may not");
});

add_task(function test_guides() {
  ok(uiGuide("diagrams").includes("c-blue"));
  ok(uiGuide("interactive").includes("lazyvimium.sendPrompt"));
  ok(!/Websandbox|Jev|A2UI|query_data/.test(uiGuide("interactive")));
  ok(!/Websandbox|Jev|A2UI|#[0-9A-F]{6}/.test(uiGuide("diagrams")));
  Assert.throws(() => uiGuide("music"), /There is no guide "music"/);
});

add_task(function test_claude_streams_ui_show_as_drafts() {
  const driver = LAZYVIMIUM_DRIVERS.claude;
  const state = {};
  const stream = event => driver.parse({ type: "stream_event", event }, state);
  stream({ type: "message_start" });
  Assert.deepEqual(
    stream({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        name: "mcp__lazyvimium__ui_show",
        input: {},
      },
    }),
    [{ type: "ui-draft", key: 1, json: "" }]
  );
  Assert.deepEqual(
    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"title": "Bi' },
    }),
    [{ type: "ui-draft", key: 1, json: '{"title": "Bi' }]
  );
  // Another tool's input is not a page.
  stream({
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", name: "mcp__lazyvimium__page_act" },
  });
  Assert.deepEqual(
    stream({
      type: "content_block_delta",
      index: 2,
      delta: { type: "input_json_delta", partial_json: "{" },
    }),
    []
  );
  // Indices start again with the next message.
  stream({ type: "message_start" });
  Assert.deepEqual(
    stream({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "x" },
    }),
    []
  );
  Assert.deepEqual(
    driver.parse({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "mcp__lazyvimium__ui_table", input: {} },
        ],
      },
    }),
    [],
    "the panel shows ui calls itself, not as the agent's tools"
  );
});
