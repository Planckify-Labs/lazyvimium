/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { parseMarkdown, parseInline } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/ui/LazyvimiumMarkdown.sys.mjs"
);

// The inline nodes as a short string: **x** for strong, *x* for em, `x` for
// code, [x](href) for links and / for a line break.
function inline(nodes) {
  return nodes
    .map(node => {
      switch (node.type) {
        case "text":
          return node.text;
        case "break":
          return "/";
        case "code":
          return `\`${node.text}\``;
        case "strong":
          return `**${inline(node.children)}**`;
        case "em":
          return `*${inline(node.children)}*`;
        case "del":
          return `~~${inline(node.children)}~~`;
        case "link":
          return `[${inline(node.children)}](${node.href})`;
      }
      return "?";
    })
    .join("");
}

add_task(function test_inline() {
  const cases = [
    ["plain text", "plain text"],
    ["**bold** and *em* and _em_", "**bold** and *em* and *em*"],
    ["a `code **not bold**` b", "a `code **not bold**` b"],
    ["``tick ` inside``", "`tick ` inside`"],
    ["snake_case_name stays", "snake_case_name stays"],
    ["5 * 3 * 2", "5 * 3 * 2"],
    ["~~gone~~", "~~gone~~"],
    ["see [docs](https://example.com/a)", "see [docs](https://example.com/a)"],
    [
      "at https://example.com/x.",
      "at [https://example.com/x](https://example.com/x).",
    ],
    ["\\*not em\\*", "*not em*"],
    ["one\ntwo", "one/two"],
    ["**$92.48** / Oracle", "**$92.48** / Oracle"],
  ];
  for (const [text, expected] of cases) {
    Assert.equal(inline(parseInline(text)), expected, text);
  }
});

add_task(function test_inline_while_streaming() {
  Assert.equal(
    inline(parseInline("price **92.4", { partial: true })),
    "price **92.4**",
    "an open emphasis shows as closed while the text streams"
  );
  Assert.equal(
    inline(parseInline("price **92.4")),
    "price **92.4",
    "and as written once it is done"
  );
  Assert.equal(
    inline(parseInline("run `npm te", { partial: true })),
    "run `npm te`"
  );
});

add_task(function test_blocks() {
  const blocks = parseMarkdown(
    [
      "# Title",
      "**Live read**",
      "- Mark **92**",
      "- Funding",
      "  - nested",
      "",
      "1. first",
      "2. second",
      "",
      "> quoted",
      "",
      "---",
      "",
      "| a | b |",
      "|:--|--:|",
      "| 1 | 2 |",
      "",
      "```js",
      "let x = 1;",
      "```",
    ].join("\n")
  );
  Assert.deepEqual(
    blocks.map(block => block.type),
    ["heading", "paragraph", "list", "list", "quote", "rule", "table", "code"]
  );
  const [heading, paragraph, bullets, numbers, , , table, code] = blocks;
  Assert.equal(heading.level, 1);
  Assert.equal(paragraph.text, "**Live read**", "a list ends the paragraph");
  Assert.equal(bullets.ordered, false);
  Assert.equal(bullets.items.length, 2);
  Assert.equal(bullets.items[1][1].type, "list", "the nested list");
  Assert.equal(numbers.ordered, true);
  Assert.equal(numbers.items.length, 2);
  Assert.deepEqual(table.header, ["a", "b"]);
  Assert.deepEqual(table.align, ["left", "right"]);
  Assert.deepEqual(table.rows, [["1", "2"]]);
  Assert.equal(code.lang, "js");
  Assert.equal(code.text, "let x = 1;");
  Assert.equal(code.open, false);
});

add_task(function test_blocks_while_streaming() {
  const [code] = parseMarkdown("```sh\nnpm test", { partial: true });
  Assert.equal(code.type, "code", "a fence without its end is code");
  Assert.equal(code.text, "npm test");
  Assert.ok(code.open);

  const blocks = parseMarkdown("Done.\n\n- one\n- tw", { partial: true });
  Assert.ok(!blocks[0].partial, "only the last block streams");
  Assert.ok(blocks[1].items[1][0].partial);
});
