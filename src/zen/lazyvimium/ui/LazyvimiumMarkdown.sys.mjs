// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The Markdown agents answer in, GitHub's flavor as chat apps render it:
// headings, paragraphs whose line breaks stay, lists, quotes, fenced code,
// rules and pipe tables, with code spans, emphasis, strikethrough and links
// inline. It builds DOM nodes, never HTML, so nothing an agent prints can
// run in the browser's chrome.
//
// While an answer streams in, its last block is `partial`: an emphasis or
// code span still waiting for its closing mark is shown as if closed, and a
// code fence without its end is shown as code, so the text does not flash
// its markup until the next delta.

const HTML_NS = "http://www.w3.org/1999/xhtml";

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])([ \t]+|$)/;
const TABLE_DELIMITER =
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|~>]/;
const AUTOLINK = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]]/;
const LINK =
  /^\[((?:\\.|[^\]\\])*)\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+"[^"]*")?\s*\)/;

function indentOf(line) {
  return line.match(/^[ \t]*/)[0].replace(/\t/g, "    ").length;
}

function dedent(line, count) {
  let i = 0;
  let removed = 0;
  while (i < line.length && removed < count) {
    if (line[i] == " ") {
      removed++;
    } else if (line[i] == "\t") {
      removed += 4;
    } else {
      break;
    }
    i++;
  }
  return line.slice(i);
}

function isBlank(line) {
  return !line.trim();
}

function isTableStart(lines, i) {
  return (
    lines[i].includes("|") &&
    i + 1 < lines.length &&
    lines[i + 1].includes("-") &&
    TABLE_DELIMITER.test(lines[i + 1]) &&
    (lines[i + 1].includes("|") || lines[i].trim().startsWith("|"))
  );
}

// Whether a line starts a block other than a paragraph, so a paragraph ends
// before it without a blank line, as agents write "**Title**\n- item".
function startsBlock(lines, i) {
  const line = lines[i];
  return (
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    (ITEM.test(line) && !isBlank(line.replace(ITEM, ""))) ||
    isTableStart(lines, i)
  );
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) {
    row = row.slice(1);
  }
  if (row.endsWith("|") && !row.endsWith("\\|")) {
    row = row.slice(0, -1);
  }
  const cells = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch == "\\" && row[i + 1] == "|") {
      cell += "|";
      i++;
    } else if (ch == "`") {
      code = !code;
      cell += ch;
    } else if (ch == "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseList(lines, start, partial) {
  const first = lines[start].match(ITEM);
  const ordered = /\d/.test(first[2]);
  const list = {
    type: "list",
    ordered,
    start: ordered ? parseInt(first[2], 10) : 1,
    items: [],
  };
  const baseIndent = first[1].length;
  let i = start;
  while (i < lines.length) {
    const match = lines[i].match(ITEM);
    if (
      !match ||
      /\d/.test(match[2]) != ordered ||
      match[1].length > baseIndent + 1 ||
      match[1].length + 1 < baseIndent
    ) {
      break;
    }
    // Content lines up with the text after the marker; agents often nest
    // with two spaces under "1.", so that is enough too.
    const contentIndent = Math.min(
      match[1].length + match[2].length + Math.max(1, match[3].length),
      baseIndent + 2
    );
    const itemLines = [lines[i].slice(match[0].length)];
    i++;
    let blankBefore = false;
    while (i < lines.length) {
      const line = lines[i];
      if (isBlank(line)) {
        blankBefore = true;
        itemLines.push("");
        i++;
        continue;
      }
      if (indentOf(line) >= contentIndent) {
        itemLines.push(dedent(line, contentIndent));
        blankBefore = false;
        i++;
        continue;
      }
      // A lazy continuation of the item's paragraph.
      if (!blankBefore && !startsBlock(lines, i)) {
        itemLines.push(line.trim());
        i++;
        continue;
      }
      break;
    }
    while (itemLines.length && isBlank(itemLines.at(-1))) {
      itemLines.pop();
      blankBefore = true;
    }
    const last = i >= lines.length;
    list.items.push(parseBlockLines(itemLines, partial && last));
    if (blankBefore && !(i < lines.length && ITEM.test(lines[i]))) {
      break;
    }
  }
  return { block: list, next: i };
}

function parseBlockLines(lines, partial) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let match = line.match(FENCE);
    if (match) {
      const fence = match[1];
      const body = [];
      const indent = indentOf(line);
      i++;
      let closed = false;
      while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (
          trimmed.startsWith(fence[0].repeat(fence.length)) &&
          !trimmed.replaceAll(fence[0], "")
        ) {
          closed = true;
          i++;
          break;
        }
        body.push(dedent(lines[i], indent));
        i++;
      }
      blocks.push({
        type: "code",
        lang: match[2] || "",
        text: body.join("\n"),
        open: !closed,
      });
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    match = line.match(HEADING);
    if (match) {
      blocks.push({
        type: "heading",
        level: match[1].length,
        text: match[2] ?? "",
      });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quoted.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      blocks.push({
        type: "quote",
        blocks: parseBlockLines(quoted, partial && i >= lines.length),
      });
      continue;
    }
    if (ITEM.test(line) && !isBlank(line.replace(ITEM, ""))) {
      const { block, next } = parseList(lines, i, partial);
      blocks.push(block);
      i = next;
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(cell => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) {
          return "center";
        }
        if (right) {
          return "right";
        }
        return left ? "left" : "";
      });
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", header, align, rows });
      continue;
    }
    const text = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
      text.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: "paragraph", text: text.join("\n") });
  }
  if (partial && blocks.length) {
    blocks.at(-1).partial = true;
  }
  return blocks;
}

/**
 * @param {string} text Markdown.
 * @param {object} [options]
 * @param {boolean} [options.partial] The text is still streaming in.
 * @returns {object[]} Its blocks.
 */
export function parseMarkdown(text, { partial = false } = {}) {
  return parseBlockLines(text.replace(/\r\n?/g, "\n").split("\n"), partial);
}

// The closing mark for an emphasis that opens at `from`, or -1.
function findCloser(text, from, mark) {
  let i = from;
  while (i < text.length) {
    if (text[i] == "\\") {
      i += 2;
      continue;
    }
    if (text[i] == "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0) {
        return -1;
      }
      i = end + 1;
      continue;
    }
    if (text.startsWith(mark, i) && !/\s/.test(text[i - 1])) {
      const single = mark.length == 1;
      const doubled = text[i + 1] == mark || text[i - 1] == mark;
      const intraword = mark == "_" && /\w/.test(text[i + 1] ?? "");
      if ((!single || !doubled) && !intraword) {
        return i;
      }
      if (single && text[i + 1] == mark) {
        i += 2;
        continue;
      }
    }
    i++;
  }
  return -1;
}

/**
 * @param {string} text One block's text.
 * @param {object} [options]
 * @param {boolean} [options.partial] Close what is still open at the end.
 * @returns {object[]} Its inline nodes.
 */
export function parseInline(text, { partial = false } = {}) {
  const nodes = [];
  let plain = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    let read;
    if (ch == "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      read = { text: text[i + 1], length: 2 };
    } else if (ch == "\n") {
      read = { node: { type: "break" }, length: 1 };
    } else {
      read = INLINE_READERS[ch]?.(text, i, partial);
    }
    read ??= { text: ch, length: 1 };
    if (read.node) {
      if (plain) {
        nodes.push({ type: "text", text: plain });
        plain = "";
      }
      nodes.push(read.node);
    } else {
      plain += read.text;
    }
    i += read.length;
  }
  if (plain) {
    nodes.push({ type: "text", text: plain });
  }
  return nodes;
}

// Each reader looks at the text from `i` and returns the node it read and
// the length it took, or the text to keep as it is, or null when nothing
// starts there.

function readCode(text, i, partial) {
  const ticks = text.slice(i).match(/^`+/)[0];
  // The closing run is as long as the opening one.
  let end = i + ticks.length;
  for (;;) {
    end = text.indexOf(ticks, end);
    if (end < 0 || text[end + ticks.length] != "`") {
      break;
    }
    end += text.slice(end).match(/^`+/)[0].length;
  }
  if (end < 0 && !partial) {
    return { text: ticks, length: ticks.length };
  }
  let code = text.slice(i + ticks.length, end < 0 ? undefined : end);
  if (/^ .*[^ ].* $/.test(code)) {
    code = code.slice(1, -1);
  }
  return {
    node: { type: "code", text: code.replace(/\n/g, " ") },
    length: end < 0 ? text.length - i : end + ticks.length - i,
  };
}

function readLink(text, i) {
  const match = text.slice(i).match(LINK);
  return match
    ? {
        node: {
          type: "link",
          href: match[2].replace(/^<|>$/g, ""),
          children: parseInline(match[1]),
        },
        length: match[0].length,
      }
    : null;
}

function readAutolink(text, i) {
  if (i > 0 && !/[\s(*_~]/.test(text[i - 1])) {
    return null;
  }
  const match = text.slice(i).match(AUTOLINK);
  return match
    ? {
        node: {
          type: "link",
          href: match[0],
          children: [{ type: "text", text: match[0] }],
        },
        length: match[0].length,
      }
    : null;
}

const EMPHASIS = {
  "*": "em",
  "**": "strong",
  _: "em",
  __: "strong",
  "~~": "del",
};

function readEmphasis(text, i, partial) {
  const ch = text[i];
  let mark = ch;
  if (ch == "~") {
    if (text[i + 1] != "~") {
      return null;
    }
    mark = "~~";
  } else if (text[i + 1] == ch && text[i + 2] != ch) {
    mark = ch + ch;
  }
  const next = text[i + mark.length];
  const canOpen =
    next && !/\s/.test(next) && !(ch == "_" && /\w/.test(text[i - 1] ?? ""));
  const end = canOpen ? findCloser(text, i + mark.length, mark) : -1;
  if (!canOpen || (end < 0 && !partial)) {
    return { text: mark, length: mark.length };
  }
  return {
    node: {
      type: EMPHASIS[mark],
      children: parseInline(
        text.slice(i + mark.length, end < 0 ? undefined : end),
        { partial: end < 0 }
      ),
    },
    length: end < 0 ? text.length - i : end + mark.length - i,
  };
}

const INLINE_READERS = {
  "`": readCode,
  "[": readLink,
  h: readAutolink,
  "*": readEmphasis,
  _: readEmphasis,
  "~": readEmphasis,
};

function safeHref(href) {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function renderInline(nodes, document, options, parent) {
  const create = tag => document.createElementNS(HTML_NS, tag);
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        parent.append(node.text);
        break;
      case "break":
        parent.append(create("br"));
        break;
      case "code": {
        const code = create("code");
        code.textContent = node.text;
        parent.append(code);
        break;
      }
      case "strong":
      case "em":
      case "del": {
        const element = create(node.type);
        renderInline(node.children, document, options, element);
        parent.append(element);
        break;
      }
      case "link": {
        const href = safeHref(node.href);
        if (!href) {
          renderInline(node.children, document, options, parent);
          break;
        }
        const link = create("a");
        link.href = href;
        link.title = href;
        link.addEventListener("click", event => {
          // A link in the browser's own chrome would load over it.
          event.preventDefault();
          options.onLink?.(href, event);
        });
        renderInline(node.children, document, options, link);
        parent.append(link);
        break;
      }
    }
  }
}

function renderBlocks(blocks, document, options, parent) {
  const create = (tag, className) => {
    const element = document.createElementNS(HTML_NS, tag);
    if (className) {
      element.className = className;
    }
    return element;
  };
  const inline = (block, text, element) =>
    renderInline(
      parseInline(text, { partial: !!block.partial }),
      document,
      options,
      element
    );
  for (const block of blocks) {
    let element;
    switch (block.type) {
      case "paragraph":
        element = create("p");
        inline(block, block.text, element);
        break;
      case "heading":
        element = create(`h${block.level}`);
        inline(block, block.text, element);
        break;
      case "rule":
        element = create("hr");
        break;
      case "code": {
        element = create("pre");
        if (block.lang) {
          element.setAttribute("data-lang", block.lang);
        }
        const code = create("code");
        code.textContent = block.text;
        element.append(code);
        break;
      }
      case "quote":
        element = create("blockquote");
        renderBlocks(block.blocks, document, options, element);
        break;
      case "list":
        element = create(block.ordered ? "ol" : "ul");
        if (block.ordered && block.start != 1) {
          element.setAttribute("start", block.start);
        }
        for (const item of block.items) {
          const li = create("li");
          renderBlocks(item, document, options, li);
          element.append(li);
        }
        break;
      case "table": {
        element = create("div", "lazyvimium-md-table");
        const table = create("table");
        const row = (cells, tag) => {
          const tr = create("tr");
          block.header.forEach((_, index) => {
            const cell = create(tag);
            if (block.align[index]) {
              cell.style.textAlign = block.align[index];
            }
            inline(block, cells[index] ?? "", cell);
            tr.append(cell);
          });
          return tr;
        };
        const head = create("thead");
        head.append(row(block.header, "th"));
        const body = create("tbody");
        body.append(...block.rows.map(cells => row(cells, "td")));
        table.append(head, body);
        element.append(table);
        break;
      }
      default:
        continue;
    }
    parent.append(element);
  }
}

/**
 * Render Markdown into an element, replacing what it held.
 *
 * @param {Element} element
 * @param {string} text
 * @param {object} [options]
 * @param {boolean} [options.partial] The text is still streaming in.
 * @param {(href: string, event: Event) => void} [options.onLink] Opens a
 *   clicked link; links never load in place.
 */
export function renderMarkdown(element, text, options = {}) {
  const document = element.ownerDocument;
  const fragment = document.createDocumentFragment();
  renderBlocks(
    parseMarkdown(text, { partial: options.partial }),
    document,
    options,
    fragment
  );
  element.replaceChildren(fragment);
}
