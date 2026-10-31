/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  findTextObject,
  chooseRange,
  paragraphEdge,
  SEARCH_LINES,
  TEXT_OBJECT_KEYS,
} = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/core/LazyvimiumTextObjects.sys.mjs"
);

// The text an object selects around the first place a marker is.
function select(text, kind, key, at, options) {
  const index = text.indexOf(at) + 1;
  const range = findTextObject(
    text,
    kind,
    key,
    { start: index, end: index },
    options
  );
  return range && text.slice(range.start, range.end);
}

const CODE = "call(one, [two, {three four}]) end";

add_task(function test_brackets() {
  Assert.equal(select(CODE, "a", "{", "three"), "{three four}");
  Assert.equal(select(CODE, "i", "{", "three"), "three four");
  Assert.equal(select(CODE, "a", "B", "three"), "{three four}");
  Assert.equal(select(CODE, "a", "}", "three"), "{three four}");
  Assert.equal(select(CODE, "i", "[", "three"), "two, {three four}");
  Assert.equal(select(CODE, "a", "b", "three"), "(one, [two, {three four}])");
  Assert.equal(select("a <bc> c", "i", "<", "bc"), "bc");
});

add_task(function test_a_bracket_not_around_is_the_next_one() {
  Assert.equal(select(CODE, "i", "(", "call"), "one, [two, {three four}]");
});

add_task(function test_quotes() {
  const text = `say "hello there" and 'single' now`;
  Assert.equal(select(text, "i", '"', "hello"), "hello there");
  Assert.equal(select(text, "a", '"', "hello"), '"hello there"');
  Assert.equal(select(text, "i", "'", "single"), "single");
  Assert.equal(select(text, "a", "q", "single"), "'single'");
  Assert.equal(select("“curly” text", "i", '"', "curly"), "curly");
  Assert.equal(select("`code` x", "i", "`", "code"), "code");
});

add_task(function test_an_apostrophe_is_no_quote() {
  const text = "don't stop 'quoted' it's";
  Assert.equal(select(text, "i", "'", "quoted"), "quoted");
});

add_task(function test_separators() {
  const text = "see a/path/x ok";
  Assert.equal(select(text, "i", "/", "path"), "path");
  Assert.equal(select(text, "a", "/", "path"), "path/");
  Assert.equal(select("a, bb, c", "i", ",", "bb"), " bb");
  Assert.equal(select("a_bc_d", "i", "_", "bc"), "bc");
});

add_task(function test_words() {
  const text = "alpha beta-gamma delta";
  Assert.equal(select(text, "i", "w", "beta"), "beta");
  Assert.equal(select(text, "a", "w", "beta"), " beta", "no blanks after");
  Assert.equal(select(text, "a", "w", "alpha"), "alpha ");
  Assert.equal(select(text, "a", "w", "delta"), " delta", "leading at the end");
  Assert.equal(select(text, "i", "W", "beta"), "beta-gamma");
  Assert.equal(select("fooBarBaz", "i", "e", "Bar"), "Bar");
  Assert.equal(select("snake_case_name", "a", "e", "case"), "case_");
  Assert.equal(select("pay 1200 now", "i", "d", "1200"), "1200");
});

add_task(function test_sentences_paragraphs_buffer() {
  const text = "One two. Three four! Five.\nSecond line";
  Assert.equal(select(text, "i", "s", "Three"), "Three four!");
  Assert.equal(select(text, "a", "s", "Three"), "Three four! ");
  Assert.equal(select(text, "i", "p", "Five"), "One two. Three four! Five.");
  Assert.equal(select(text, "i", "p", "Second"), "Second line");
  Assert.equal(select("  all \n of it ", "i", "g", "all"), "all \n of it");
  Assert.equal(select(text, "a", "g", "Five"), text);
});

add_task(function test_repeating_grows() {
  Assert.equal(select(CODE, "a", "{", "three", { times: 1 }), "{three four}");
  const range = findTextObject(
    CODE,
    "a",
    "b",
    { start: CODE.indexOf("three"), end: CODE.indexOf("three") + 5 },
    { times: 2 }
  );
  Assert.equal(
    CODE.slice(range.start, range.end),
    "(one, [two, {three four}])",
    "the next that contains the selection"
  );
  Assert.equal(
    findTextObject(CODE, "a", "{", { start: 5, end: 28 }),
    null,
    "nothing bigger than the selection"
  );
});

add_task(function test_choose_range() {
  const ranges = [
    { start: 0, end: 10 },
    { start: 2, end: 5 },
    { start: 20, end: 25 },
  ];
  Assert.deepEqual(chooseRange(ranges, { start: 3, end: 3 }), ranges[1]);
  Assert.deepEqual(chooseRange(ranges, { start: 12, end: 12 }), ranges[2]);
  Assert.deepEqual(chooseRange(ranges, { start: 2, end: 5 }), ranges[0]);
  Assert.equal(chooseRange(ranges, { start: 0, end: 10 }), null);
  Assert.equal(chooseRange(ranges, { start: 30, end: 30 }), null);
});

add_task(function test_only_nearby_lines_are_searched() {
  const far = "\n".repeat(SEARCH_LINES + 5);
  const text = `( open${far}close )`;
  Assert.equal(select(text, "a", "(", "open"), null, "no pair a page away");
  Assert.equal(select("( open\nclose )", "a", "(", "open"), "( open\nclose )");
});

add_task(function test_paragraph_edges() {
  const text = "one two\nthree\nfour five";
  const edge = (offset, forward) => paragraphEdge(text, offset, forward);
  Assert.deepEqual(edge(2, true), { offset: 7, side: "end" }, "to the end");
  Assert.deepEqual(edge(7, true), { offset: 13, side: "end" }, "then the next");
  Assert.deepEqual(edge(15, true), { offset: 23, side: "end" }, "to the last");
  Assert.deepEqual(
    edge(23, true),
    { offset: 23, side: "end" },
    "stays at the end"
  );
  Assert.deepEqual(
    edge(10, false),
    { offset: 8, side: "start" },
    "to the start"
  );
  Assert.deepEqual(
    edge(8, false),
    { offset: 0, side: "start" },
    "then the one before"
  );
  Assert.deepEqual(
    edge(0, false),
    { offset: 0, side: "start" },
    "stays at the top"
  );
});

add_task(function test_unknown_objects() {
  Assert.equal(findTextObject("x", "a", "!", { start: 0, end: 0 }), null);
  Assert.equal(findTextObject("x", "z", "w", { start: 0, end: 0 }), null);
  Assert.ok(TEXT_OBJECT_KEYS.includes("/"));
  Assert.ok(TEXT_OBJECT_KEYS.includes("t"));
});
