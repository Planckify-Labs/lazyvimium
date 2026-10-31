// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Text objects over a plain text: `a` and `i` with brackets, quotes, words,
// sentences, paragraphs and the punctuation that separates things. Lines of
// the text are the blocks of a page, so a paragraph is a line.
//
// A range is {start, end}, half open. Repeating an object on a selection
// grows it to the next one that contains it.

/** How many lines around the selection are searched. */
export const SEARCH_LINES = 50;

const BRACKETS = {
  "(": ["(", ")"],
  ")": ["(", ")"],
  b: ["(", ")"],
  "[": ["[", "]"],
  "]": ["[", "]"],
  "{": ["{", "}"],
  "}": ["{", "}"],
  B: ["{", "}"],
  "<": ["<", ">"],
  ">": ["<", ">"],
};

// Quotes close with themselves, or with their curly twin.
const QUOTES = {
  '"': ['"', "“", "”"],
  "'": ["'", "‘", "’"],
  "`": ["`", "`", "`"],
};

const SEPARATORS = "_.,;:+-=~|/\\&$#";

const WORD = /[\p{L}\p{N}_]+/gu;
const NON_BLANK = /\S+/g;
const SUBWORD = /[\p{Lu}]?[\p{Ll}]+|[\p{Lu}]+(?![\p{Ll}])|\p{N}+/gu;
const DIGITS = /\d+/g;
const SENTENCE = /[^.!?]*[^\s.!?][.!?]*\s*/g;

/** Every key that follows `a` or `i`. `t` is the page's elements. */
export const TEXT_OBJECT_KEYS = [
  ...Object.keys(BRACKETS),
  ...Object.keys(QUOTES),
  "q",
  "w",
  "W",
  "e",
  "d",
  "s",
  "p",
  "t",
  "g",
  ...SEPARATORS,
];

/**
 * Where a paragraph motion goes from a position: to the end of the paragraph
 * it is in, or the start of it going back; and if it is there already, to
 * the next one's.
 *
 * @param {string} text
 * @param {number} offset
 * @param {boolean} forward
 * @returns {{offset: number, side: "start"|"end"}} A position, and whether
 *   it is the start of a line or the end of one.
 */
export function paragraphEdge(text, offset, forward) {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  let end = text.indexOf("\n", offset);
  if (end == -1) {
    end = text.length;
  }
  if (forward) {
    if (offset < end) {
      return { offset: end, side: "end" };
    }
    const next = text.indexOf("\n", end + 1);
    return end >= text.length
      ? { offset: text.length, side: "end" }
      : { offset: next == -1 ? text.length : next, side: "end" };
  }
  if (offset > start) {
    return { offset: start, side: "start" };
  }
  return start == 0
    ? { offset: 0, side: "start" }
    : { offset: text.lastIndexOf("\n", start - 2) + 1, side: "start" };
}

/**
 * @param {string} key
 * @returns {boolean} Whether a text object has this key.
 */
export function isTextObjectKey(key) {
  return TEXT_OBJECT_KEYS.includes(key);
}

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i != -1; i = text.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

// The ranges of a pattern's matches in each line.
function matchesPerLine(text, pattern, toRange) {
  const found = [];
  for (const line of lines(text)) {
    for (const match of line.text.matchAll(pattern)) {
      found.push(toRange(match, line.start));
    }
  }
  return found;
}

function lines(text) {
  const starts = lineStarts(text);
  return starts.map((start, i) => ({
    start,
    text: text.slice(start, (starts[i + 1] ?? text.length + 1) - 1),
  }));
}

function bracketPairs(text, open, close) {
  const pairs = [];
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] == open) {
      stack.push(i);
    } else if (text[i] == close && stack.length) {
      pairs.push({ open: stack.pop(), close: i });
    }
  }
  return pairs;
}

function quotePairs(text, kind) {
  const [straight, opening, closing] = QUOTES[kind];
  const pairs = [];
  for (const line of lines(text)) {
    let open = null;
    for (let i = 0; i < line.text.length; i++) {
      const char = line.text[i];
      const before = line.text[i - 1] ?? "";
      const after = line.text[i + 1] ?? "";
      if (char == straight && straight != opening) {
        // The apostrophe of "don't" is no quote.
        if (kind == "'" && /\p{L}/u.test(before) && /\p{L}/u.test(after)) {
          continue;
        }
        if (open === null) {
          open = i;
        } else {
          pairs.push({ open: line.start + open, close: line.start + i });
          open = null;
        }
      } else if (char == straight) {
        // A backtick opens and closes alike.
        if (open === null) {
          open = i;
        } else {
          pairs.push({ open: line.start + open, close: line.start + i });
          open = null;
        }
      } else if (char == opening) {
        open = i;
      } else if (char == closing && open !== null) {
        pairs.push({ open: line.start + open, close: line.start + i });
        open = null;
      }
    }
  }
  return pairs;
}

// Candidate ranges of an object, `a` or `i`, before choosing one.
function candidates(text, key, kind) {
  const inner = kind == "i";
  const pairRanges = pairs =>
    pairs
      .map(({ open, close }) =>
        inner
          ? { start: open + 1, end: close }
          : { start: open, end: close + 1 }
      )
      .filter(range => range.end > range.start);

  if (BRACKETS[key]) {
    return pairRanges(bracketPairs(text, ...BRACKETS[key]));
  }
  if (QUOTES[key]) {
    return pairRanges(quotePairs(text, key));
  }
  if (key == "q") {
    return Object.keys(QUOTES).flatMap(each =>
      pairRanges(quotePairs(text, each))
    );
  }
  if (SEPARATORS.includes(key)) {
    // Between two of the character on a line; `a` takes the right one too.
    return lines(text).flatMap(line => {
      const found = [];
      let previous = -1;
      for (let i = 0; i < line.text.length; i++) {
        if (line.text[i] != key) {
          continue;
        }
        if (previous != -1) {
          found.push({
            start: line.start + previous + 1,
            end: line.start + i + (inner ? 0 : 1),
          });
        }
        previous = i;
      }
      return found.filter(range => range.end > range.start);
    });
  }
  switch (key) {
    case "w":
      return withTrailing(text, matchesPerLine(text, WORD, span), inner);
    case "W":
      return withTrailing(text, matchesPerLine(text, NON_BLANK, span), inner);
    case "e":
      return matchesPerLine(text, SUBWORD, span).map(range =>
        inner ? range : joined(text, range)
      );
    case "d":
      return matchesPerLine(text, DIGITS, span);
    case "s":
      return matchesPerLine(text, SENTENCE, ({ 0: match, index }, start) => ({
        start: start + index,
        end: start + index + (inner ? match.trimEnd().length : match.length),
      }));
    case "p":
      return lines(text)
        .map(line => ({
          start: line.start,
          end: line.start + line.text.length,
        }))
        .filter(range => range.end > range.start);
    case "g":
      return [
        inner
          ? {
              start: text.length - text.trimStart().length,
              end: text.trimEnd().length,
            }
          : { start: 0, end: text.length },
      ].filter(range => range.end > range.start);
  }
  return [];
}

const span = ({ 0: match, index }, start) => ({
  start: start + index,
  end: start + index + match.length,
});

// `a` takes the blanks after a word, or before it at the end of a line.
function withTrailing(text, ranges, inner) {
  if (inner) {
    return ranges;
  }
  return ranges.map(range => {
    let end = range.end;
    while (text[end] == " ") {
      end++;
    }
    if (end > range.end) {
      return { start: range.start, end };
    }
    let start = range.start;
    while (text[start - 1] == " ") {
      start--;
    }
    return { start, end: range.end };
  });
}

// A part of a name, with the `_` or `-` that joins it to the next.
function joined(text, range) {
  return "_-".includes(text[range.end] ?? "")
    ? { start: range.start, end: range.end + 1 }
    : range;
}

/**
 * The candidate an object selects: for a caret, the smallest that covers
 * it, or else the next one; for a selection, the smallest that contains it
 * and is bigger.
 *
 * @param {{start: number, end: number}[]} ranges
 * @param {{start: number, end: number}} selection
 * @returns {{start: number, end: number}|null}
 */
export function chooseRange(ranges, selection) {
  const size = range => range.end - range.start;
  const collapsed = selection.start == selection.end;
  const containing = ranges
    .filter(range =>
      collapsed
        ? range.start <= selection.start && selection.start < range.end
        : range.start <= selection.start &&
          selection.end <= range.end &&
          size(range) > selection.end - selection.start
    )
    .sort((a, b) => size(a) - size(b));
  if (containing.length) {
    return containing[0];
  }
  if (!collapsed) {
    return null;
  }
  const next = ranges
    .filter(range => range.start >= selection.start)
    .sort((a, b) => a.start - b.start || size(a) - size(b));
  return next[0] ?? null;
}

/**
 * Select a text object, `a` or `i`, around a selection.
 *
 * @param {string} text
 * @param {string} kind "a" or "i".
 * @param {string} key What follows it.
 * @param {{start: number, end: number}} selection
 * @param {object} [options]
 * @param {number} [options.times] How many times to grow it.
 * @returns {{start: number, end: number}|null}
 */
export function findTextObject(text, kind, key, selection, { times = 1 } = {}) {
  if (!isTextObjectKey(key) || (kind != "a" && kind != "i")) {
    return null;
  }
  // Only the lines near the selection: an unmatched bracket would otherwise
  // pair with one a page away.
  const starts = lineStarts(text);
  const lineOf = offset => {
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= offset) {
      line++;
    }
    return line;
  };
  const first = Math.max(0, lineOf(selection.start) - SEARCH_LINES);
  const last = Math.min(
    starts.length - 1,
    lineOf(selection.end) + SEARCH_LINES
  );
  const from = starts[first];
  const to = starts[last + 1] ?? text.length;
  const slice = text.slice(from, to);

  let current = {
    start: selection.start - from,
    end: selection.end - from,
  };
  let result = null;
  for (let i = 0; i < times; i++) {
    const range = chooseRange(candidates(slice, key, kind), current);
    if (!range) {
      break;
    }
    result = range;
    current = range;
  }
  return result && { start: result.start + from, end: result.end + from };
}
