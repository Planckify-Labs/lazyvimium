// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Answers the agent shows in the panel instead of writing them out: a live
// table the panel draws itself (ui_table), or a page of the agent's own
// HTML, CSS and JavaScript run in a sandbox (ui_show). After CopilotKit's
// Open Intelligent UI (github.com/CopilotKit/OpenIntelligentUI at 8391a94c;
// MIT License, Copyright (c) Atai Barkai): its tool contract and field
// order, sandbox and bridge rules, theme token and SVG class names, partial
// HTML preview, and its skills, which ui_guide hands the agent.
//
// A page runs in a sandboxed srcdoc iframe of a data: shell document, in a
// web content process. Its origin is opaque, so it has no storage or
// cookies; its CSP lets scripts come only from inline code and four CDNs,
// and connect nowhere else; the sandbox takes popups, forms, modals,
// downloads and navigating the shell from it, and the shell's frame-src
// 'none' keeps it from navigating itself, since an opaque origin gets no
// navigate events to cancel. Being a frame, its navigations never move to
// a tab of their own, as a top-level one switching container would. It
// reaches the browser only through window.lazyvimium (LazyvimiumUiChild),
// whose calls the parent checks.

export const UI_TOOLS = ["ui_table", "ui_show", "ui_guide"];

const MAX_TITLE = 120;
const MAX_NOTE = 600;
const MAX_CELL = 400;
const MAX_COLUMNS = 24;
const MAX_ROWS = 500;
const MAX_ID = 64;
const MAX_PAGE = 512 * 1024;
export const MAX_PROMPT = 4000;
// The heights a page may take in the panel; a taller one scrolls.
export const MIN_PAGE_HEIGHT = 48;
export const MAX_PAGE_HEIGHT = 900;
const DEFAULT_PAGE_HEIGHT = 200;

// Every sandbox flag but scripts (nsSandboxFlags.h): no popups, forms,
// modals, downloads, pointer lock, autoplay or navigating anything.
const SANDBOX_ALL_FLAGS = 0xfffff;
const SANDBOXED_SCRIPTS = 0x80;
export const UI_SANDBOX_FLAGS = SANDBOX_ALL_FLAGS & ~SANDBOXED_SCRIPTS;

const CDNS = [
  "https://cdnjs.cloudflare.com",
  "https://esm.sh",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
];

const PAGE_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS.join(" ")}`,
  `style-src 'unsafe-inline' ${CDNS.join(" ")}`,
  `font-src data: ${CDNS.join(" ")}`,
  "img-src data: blob: https:",
  "media-src data: blob: https:",
  `connect-src ${CDNS.join(" ")}`,
  "worker-src blob:",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

// While the agent still writes the page, nothing in it runs.
const PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: blob: https:",
  "font-src data:",
].join("; ");

// Bare imports for the libraries the guides name, as upstream maps them.
const IMPORTMAP = {
  imports: Object.fromEntries(
    ["three", "gsap", "d3", "chart.js"].flatMap(name => [
      [name, `https://esm.sh/${name}`],
      [`${name}/`, `https://esm.sh/${name}/`],
    ])
  ),
};

export const UI_INSTRUCTIONS = `Showing answers in the panel, after CopilotKit's Open Intelligent UI playbook:
- Answer in text when a few sentences do. For things that share the same fields (products across tabs, search results, issues, prices) call ui_table instead of writing a Markdown table. When an answer is clearer to see or to use than to read (a chart, a diagram of how something works, a calculator, a comparison with adjustable weights) call ui_show, after reading ui_guide.
- Use values you read from pages or the user gave you. Label sample values and assumptions where the user sees them. Never invent prices, data or sources.
- Do not repeat in your answer what a table or page already shows, and do not build the same one again after it was shown; add a sentence only if it helps.`;

/**
 * The MCP tool descriptions.
 *
 * @returns {object[]}
 */
export function uiToolDefinitions() {
  return [
    {
      name: "ui_table",
      description:
        "Show a table in the user's panel, which they can sort, filter, copy as CSV and open rows from. Use it for comparisons and lists read from pages instead of a Markdown table. Call it again with the same id to update the table in place, for example while you read more tabs: the new rows replace the old. A row with tab (an id like t3) brings that tab to the front when clicked; one with url opens it. Say in note where the values came from and what is assumed.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Your name for the table, to update it later",
          },
          title: { type: "string" },
          columns: {
            type: "array",
            items: { type: "string" },
            description: "The column names",
          },
          rows: {
            type: "array",
            items: {
              type: "object",
              properties: {
                cells: {
                  type: "array",
                  items: { type: ["string", "number", "null"] },
                  description: "One value per column, units included",
                },
                tab: { type: "string" },
                url: { type: "string" },
              },
              required: ["cells"],
            },
          },
          note: { type: "string" },
        },
        required: ["title", "columns", "rows"],
        additionalProperties: false,
      },
    },
    {
      name: "ui_show",
      description: `Show a page of your own in the user's panel: a chart, diagram, calculator, simulation or any answer clearer to use than to read. Send the fields in this order, title, id, height, css, html, js, since the user watches the html arrive. html is body markup (no <html>, <head>, <style> or <script>), css styles it, js is a classic script run after it (no top-level await; import() inside async functions; three, d3, chart.js and gsap import bare). The page has the browser's theme as CSS variables (--color-text-primary, --color-background-secondary, --color-border-tertiary, --color-accent...), styled form controls and SVG color classes (c-blue, c-teal...). It has no storage or cookies, and no network but scripts from ${CDNS.map(cdn => cdn.replace("https://", "")).join(", ")} and https images. A button the user clicks can call await lazyvimium.sendPrompt({text}) to ask you a follow-up with the values it shows, lazyvimium.openLink({url}) to open an https page in a tab, or lazyvimium.focusTab({tab}) to bring a tab like t3 to the front; they refuse anything the user did not click. Read ui_guide before your first diagram or interactive page. Call it again with the same id to replace the page.`,
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          id: {
            type: "string",
            description: "Your name for the page, to replace it later",
          },
          height: {
            type: "number",
            description: "Your estimate of its finished height in pixels",
          },
          css: { type: "string" },
          html: { type: "string" },
          js: { type: "string" },
        },
        required: ["title", "html"],
        additionalProperties: false,
      },
    },
    {
      name: "ui_guide",
      description:
        "How to build good ui_show pages: topic diagrams for SVG diagrams of systems, processes and mechanisms; interactive for calculators, charts, comparisons, maps and 3D. Read the topic before you build one.",
      inputSchema: {
        type: "object",
        properties: {
          topic: { type: "string", enum: ["diagrams", "interactive"] },
        },
        required: ["topic"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

function clean(value, max) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function idOf(value) {
  return clean(value, MAX_ID) || null;
}

/**
 * @param {*} value
 * @returns {string|null} The value as an http(s) address, or null.
 */
export function webAddress(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol == "https:" || url.protocol == "http:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Check and tidy what the agent sent ui_table.
 *
 * @param {object} args
 * @returns {object} The table: {kind, id, title, columns, rows, note}.
 * @throws {Error} What to tell the agent.
 */
export function tableFromArgs(args) {
  const columns = Array.isArray(args?.columns)
    ? args.columns.map(column =>
        clean(typeof column == "object" ? column?.name : column, MAX_CELL)
      )
    : [];
  if (!columns.length) {
    throw new Error("ui_table needs columns, an array of column names.");
  }
  if (columns.length > MAX_COLUMNS) {
    throw new Error(`ui_table takes at most ${MAX_COLUMNS} columns.`);
  }
  if (!Array.isArray(args.rows)) {
    throw new Error('ui_table needs rows, each {"cells": [...]}.');
  }
  if (args.rows.length > MAX_ROWS) {
    throw new Error(`ui_table takes at most ${MAX_ROWS} rows.`);
  }
  const rows = args.rows.map((row, index) => {
    // A bare array of cells is forgiven.
    const cells = Array.isArray(row) ? row : row?.cells;
    if (!Array.isArray(cells)) {
      throw new Error(`Row ${index + 1} has no cells array.`);
    }
    const tab = String(row?.tab ?? "");
    return {
      cells: columns.map((_, i) => clean(cells[i], MAX_CELL)),
      tab: /^t\d+$/.test(tab) ? tab : null,
      url: webAddress(row?.url),
    };
  });
  return {
    kind: "table",
    id: idOf(args.id),
    title: clean(args.title, MAX_TITLE) || "Table",
    columns,
    rows,
    note: clean(args.note, MAX_NOTE),
  };
}

/**
 * @param {*} value
 * @returns {number} A page height the panel can use.
 */
export function pageHeight(value) {
  const height = Number(value);
  if (!Number.isFinite(height)) {
    return DEFAULT_PAGE_HEIGHT;
  }
  return Math.round(
    Math.min(MAX_PAGE_HEIGHT, Math.max(MIN_PAGE_HEIGHT, height))
  );
}

/**
 * Check what the agent sent ui_show.
 *
 * @param {object} args
 * @returns {object} The page: {kind, id, title, height, css, html, js}.
 * @throws {Error} What to tell the agent.
 */
export function pageFromArgs(args) {
  const text = value => (typeof value == "string" ? value : "");
  const page = {
    kind: "page",
    id: idOf(args?.id),
    title: clean(args?.title, MAX_TITLE) || "Untitled",
    height: pageHeight(args?.height),
    css: text(args?.css),
    html: text(args?.html),
    js: text(args?.js),
  };
  if (!page.html.trim()) {
    throw new Error("ui_show needs html, the page's body markup.");
  }
  if (page.css.length + page.html.length + page.js.length > MAX_PAGE) {
    throw new Error(
      "The page is too large: keep css, html and js under 512 KB together."
    );
  }
  return page;
}

const EMPTY_CELLS = new Set(["", "-", "–", "—", "?", "n/a", "na", "none"]);

/**
 * @param {string} cell
 * @returns {boolean} Whether the cell says nothing, to sort it last.
 */
export function isEmptyCell(cell) {
  return EMPTY_CELLS.has(String(cell).trim().toLowerCase());
}

/**
 * The number a cell starts with, for sorting: "$1,749", "Rp 15.000.000",
 * "1.12 kg", "4,5 ★". A cell with words before its number has none.
 *
 * @param {string} cell
 * @returns {number|null}
 */
export function numberOf(cell) {
  // A currency code needs a space or a dot after it: "X1 Carbon" is a name.
  const match =
    /^\s*(?:[$€£¥₹₩]\s?|[A-Za-z]{1,3}(?:\.\s?|\s))?([-+−]?\d[\d.,]*)/u.exec(
      cell
    );
  if (!match) {
    return null;
  }
  let digits = match[1].replace("−", "-").replace(/[.,]$/, "");
  const comma = digits.lastIndexOf(",");
  const dot = digits.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    // The later one is the decimal point.
    const [group, point] = comma > dot ? [".", ","] : [",", "."];
    digits = digits.replaceAll(group, "").replace(point, ".");
  } else if (comma >= 0) {
    // 1,749 groups thousands; 4,5 is a decimal comma.
    digits =
      /,\d{3}$/.test(digits) || digits.split(",").length > 2
        ? digits.replaceAll(",", "")
        : digits.replace(",", ".");
  } else if (digits.split(".").length > 2) {
    // 15.000.000
    digits = digits.replaceAll(".", "");
  }
  const number = parseFloat(digits);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {object} table
 * @param {number} column
 * @returns {boolean} Whether every cell of the column that says something
 *   starts with a number, so it sorts as numbers.
 */
export function isNumberColumn(table, column) {
  let any = false;
  for (const row of table.rows) {
    const cell = row.cells[column];
    if (isEmptyCell(cell)) {
      continue;
    }
    if (numberOf(cell) === null) {
      return false;
    }
    any = true;
  }
  return any;
}

/**
 * @param {string[]} columns
 * @param {string[][]} rows
 * @returns {string} RFC 4180 CSV, but with \n line ends: Linux clipboards
 *   turn \r\n into \n anyway, and spreadsheets read either.
 */
export function toCsv(columns, rows) {
  const line = cells =>
    cells
      .map(cell =>
        /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell
      )
      .join(",");
  return [line(columns), ...rows.map(line)].join("\n");
}

/**
 * Read the string and number fields of a JSON object the agent is still
 * writing: the field being written comes back with what it has so far.
 *
 * @param {string} json
 * @returns {{fields: object, open: string|null}} The fields, and the one
 *   whose value is not finished.
 */
export function partialFields(json) {
  const fields = {};
  let i = json.indexOf("{") + 1;
  if (!i) {
    return { fields, open: null };
  }
  const skip = () => {
    while (i < json.length && /[\s,]/.test(json[i])) {
      i++;
    }
  };
  // A string from its opening quote: [value, finished].
  const string = () => {
    let value = "";
    i++;
    while (i < json.length) {
      const char = json[i];
      if (char == '"') {
        i++;
        return [value, true];
      }
      if (char != "\\") {
        value += char;
        i++;
        continue;
      }
      const next = json[i + 1];
      if (next === undefined) {
        break;
      }
      if (next == "u") {
        const hex = json.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          break;
        }
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      value += { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[next] ?? next;
      i += 2;
    }
    return [value, false];
  };
  while (i < json.length) {
    skip();
    if (json[i] != '"') {
      break;
    }
    const [key, keyDone] = string();
    if (!keyDone) {
      break;
    }
    skip();
    if (json[i] != ":") {
      break;
    }
    i++;
    while (i < json.length && /\s/.test(json[i])) {
      i++;
    }
    if (i >= json.length) {
      break;
    }
    if (json[i] == '"') {
      const [value, done] = string();
      fields[key] = value;
      if (!done) {
        return { fields, open: key };
      }
      continue;
    }
    const scalar = /^[^,}\s]+/.exec(json.slice(i))?.[0] ?? "";
    i += scalar.length;
    if (i >= json.length) {
      // It may go on.
      break;
    }
    try {
      fields[key] = JSON.parse(scalar);
    } catch {
      break;
    }
  }
  return { fields, open: null };
}

/**
 * What of html still being written can be shown: no tag cut in half, no
 * style, script or head block, no entity cut in half. Forked from
 * CopilotKit's processPartialHtml (MIT).
 *
 * @param {string} html
 * @returns {string}
 */
export function partialHtml(html) {
  let result = html
    .replace(/<[^>]*$/, "")
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(style|script|head)\b[^>]*>[\s\S]*$/gi, "")
    .replace(/&[a-zA-Z0-9#]*$/, "");
  const body = /<body[^>]*>([\s\S]*)/i.exec(result);
  if (body) {
    result = body[1].replace(/<\/body>[\s\S]*/i, "");
  }
  return result;
}

// Upstream's SVG color classes, on lazyvimium's hues: fill a tint of the
// hue, stroke the hue, text between the hue and the text color.
const SVG_HUES = {
  purple: "purple",
  teal: "teal",
  coral: "orange",
  pink: "pink",
  gray: "muted",
  blue: "blue",
  green: "green",
  amber: "yellow",
  red: "red",
};

function svgClassesCss() {
  return Object.entries(SVG_HUES)
    .map(([name, hue]) => {
      const c = `c-${name}`;
      const color = `var(--lazyvimium-${hue})`;
      return `
.${c} { --c-fill: color-mix(in srgb, ${color} 16%, var(--lazyvimium-base)); --c-stroke: ${color}; --c-text: color-mix(in srgb, ${color} 55%, var(--lazyvimium-text)); }
svg .${c} > rect, svg .${c} > circle, svg .${c} > ellipse, svg .${c} > path, svg .${c} > polygon,
svg rect.${c}, svg circle.${c}, svg ellipse.${c}, svg path.${c}, svg polygon.${c} { fill: var(--c-fill); stroke: var(--c-stroke); }
svg .${c} text.th, svg .${c} text.t { fill: var(--c-text); }
svg .${c} text.ts { fill: var(--c-stroke); }`;
    })
    .join("");
}

// Upstream's theme token names, on lazyvimium's palette, and its form
// styles, with lazyvimium's accent for focus and checked controls.
const BASE_CSS = `
:root {
  color-scheme: light dark;
  --color-background-primary: var(--lazyvimium-base);
  --color-background-secondary: var(--lazyvimium-raised);
  --color-background-tertiary: color-mix(in srgb, var(--lazyvimium-raised) 55%, var(--lazyvimium-base));
  --color-background-info: color-mix(in srgb, var(--lazyvimium-blue) 16%, var(--lazyvimium-base));
  --color-background-danger: color-mix(in srgb, var(--lazyvimium-red) 16%, var(--lazyvimium-base));
  --color-background-success: color-mix(in srgb, var(--lazyvimium-green) 16%, var(--lazyvimium-base));
  --color-background-warning: color-mix(in srgb, var(--lazyvimium-yellow) 16%, var(--lazyvimium-base));
  --color-text-primary: var(--lazyvimium-text);
  --color-text-secondary: var(--lazyvimium-muted);
  --color-text-tertiary: color-mix(in srgb, var(--lazyvimium-muted) 75%, var(--lazyvimium-base));
  --color-text-info: var(--lazyvimium-blue);
  --color-text-danger: var(--lazyvimium-red);
  --color-text-success: var(--lazyvimium-green);
  --color-text-warning: var(--lazyvimium-yellow);
  --color-border-primary: color-mix(in srgb, var(--lazyvimium-text) 45%, transparent);
  --color-border-secondary: var(--lazyvimium-border);
  --color-border-tertiary: color-mix(in srgb, var(--lazyvimium-border) 70%, transparent);
  --color-border-info: var(--lazyvimium-blue);
  --color-border-danger: var(--lazyvimium-red);
  --color-border-success: var(--lazyvimium-green);
  --color-border-warning: var(--lazyvimium-yellow);
  --color-accent: var(--lazyvimium-accent);
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-serif: Georgia, "Times New Roman", serif;
  --font-mono: ui-monospace, "SF Mono", "Fira Code", monospace;
  --border-radius-md: 8px;
  --border-radius-lg: 12px;
  --border-radius-xl: 16px;
  --p: var(--color-text-primary);
  --s: var(--color-text-secondary);
  --t: var(--color-text-tertiary);
  --bg2: var(--color-background-secondary);
  --b: var(--color-border-tertiary);
}
* { box-sizing: border-box; margin: 0; }
html { background: var(--color-background-primary); scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--lazyvimium-scrollbar) 45%, transparent) transparent; }
body { padding: 12px 14px; font: 14px/1.55 var(--font-sans); color: var(--color-text-primary); overflow-wrap: break-word; }
h1, h2, h3, h4 { font-size: 1em; font-weight: 600; line-height: 1.3; margin-bottom: 6px; }
p, ul, ol, table, figure { margin-bottom: 8px; }
ul, ol { padding-inline-start: 1.4em; }
small, .muted { color: var(--color-text-secondary); }
code, pre { font-family: var(--font-mono); font-size: 0.92em; }
img, svg, canvas, video { max-width: 100%; height: auto; }
button {
  font: inherit; font-size: 13px; padding: 5px 14px;
  border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md);
  background: transparent; color: var(--color-text-primary); cursor: pointer;
  transition: background 0.15s, transform 0.1s;
}
button:hover { background: var(--color-background-secondary); }
button:active { transform: scale(0.98); }
button:disabled { opacity: 0.5; cursor: default; }
input[type="text"], input[type="number"], input[type="email"], input[type="search"], input[type="date"], textarea, select {
  font: inherit; font-size: 13px; padding: 5px 10px; height: 32px;
  border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-md);
  background: var(--color-background-primary); color: var(--color-text-primary);
}
input:hover, textarea:hover, select:hover { border-color: var(--color-border-secondary); }
:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 1px; }
textarea { height: auto; min-height: 72px; resize: vertical; }
input::placeholder, textarea::placeholder { color: var(--color-text-tertiary); }
input[type="range"], input[type="checkbox"], input[type="radio"], progress { accent-color: var(--color-accent); }
label { color: var(--color-text-secondary); font-size: 13px; }
a { color: var(--color-text-info); text-decoration: none; }
a:hover { text-decoration: underline; }
table { border-collapse: collapse; font-size: 13px; }
th, td { padding: 4px 8px; border-bottom: 0.5px solid var(--color-border-tertiary); text-align: start; }
th { color: var(--color-text-secondary); font-weight: 600; }
svg text.t { font: 400 14px var(--font-sans); fill: var(--p); }
svg text.ts { font: 400 12px var(--font-sans); fill: var(--s); }
svg text.th { font: 500 14px var(--font-sans); fill: var(--p); }
svg .box > rect, svg .box > circle, svg .box > ellipse { fill: var(--bg2); stroke: var(--b); }
svg .node { cursor: pointer; }
svg .node:hover { opacity: 0.8; }
svg .arr { stroke: var(--s); stroke-width: 1.5; fill: none; }
svg .leader { stroke: var(--t); stroke-width: 0.5; stroke-dasharray: 4 4; fill: none; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition: none !important; }
}
${svgClassesCss()}
`;

// Text the agent wrote cannot close the element it sits in.
function escapeEnd(text, tag) {
  return text.replace(new RegExp(`</(${tag})`, "gi"), "<\\/$1");
}

function escapeAttribute(text) {
  return text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

/**
 * The document the panel loads for a page: a shell, without scripts of its
 * own, holding the page in a sandboxed frame. The frame inherits the
 * shell's CSP, so the shell's is the page's.
 *
 * @param {object} page What pageFromArgs returned, or a draft of it.
 * @param {object} theme LazyvimiumTheme.variables().
 * @param {object} [options]
 * @param {boolean} [options.preview] A draft: what of its html has arrived,
 *   with nothing run.
 * @returns {string}
 */
export function pageDocument(page, theme, { preview = false } = {}) {
  // Both have frame-src 'none', the preview's through default-src.
  const csp = preview ? PREVIEW_CSP : PAGE_CSP;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html, body { margin: 0; height: 100%; overflow: hidden; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style></head><body><iframe sandbox="allow-scripts" srcdoc="${escapeAttribute(frameDocument(page, theme, { preview }))}"></iframe></body></html>`;
}

/**
 * The page itself, as the frame's srcdoc.
 *
 * @param {object} page
 * @param {object} theme
 * @param {object} [options]
 * @param {boolean} [options.preview]
 * @returns {string}
 */
export function frameDocument(page, theme, { preview = false } = {}) {
  const variables = Object.entries(theme)
    .filter(([name]) => /^--[\w-]+$/.test(name))
    .map(([name, value]) => `${name}: ${String(value).replace(/[;{}<]/g, "")};`)
    .join("\n  ");
  const head = [
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${preview ? PREVIEW_CSP : PAGE_CSP}">`,
    '<meta name="color-scheme" content="light dark">',
    preview
      ? ""
      : `<script type="importmap">${escapeEnd(JSON.stringify(IMPORTMAP), "script")}</script>`,
    `<style>:root {\n  ${variables}\n}${BASE_CSS}</style>`,
    page.css ? `<style>${escapeEnd(page.css, "style")}</style>` : "",
  ].join("");
  const body = preview ? partialHtml(page.html ?? "") : page.html;
  const script =
    !preview && page.js
      ? `<script>${escapeEnd(page.js, "script")}</script>`
      : "";
  return `<!doctype html><html><head>${head}</head><body>${body}${script}</body></html>`;
}

/**
 * @param {string} html
 * @returns {string} A data: address of it, as UTF-8.
 */
export function dataAddress(html) {
  const bytes = new TextEncoder().encode(html);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:text/html;charset=utf-8;base64,${btoa(binary)}`;
}

// Upstream's skills, for this host: ui_show takes title, id, height, css,
// html and js; the bridge is window.lazyvimium; colors come from the
// browser's theme, so the classes replace upstream's fixed hex values.
const GUIDES = {
  diagrams: `# SVG diagrams (after Open Intelligent UI's svg-diagrams skill)

Use a diagram when a picture explains a system, process, architecture or mechanism better than text: how something works, structure and containment, flows and decisions, intuition for an abstract idea.

## Delivery
Put the SVG in ui_show's html. Declare any CSS (animation classes) in css, never in a <style> inside html. A static diagram needs no js. Elements stream top to bottom, so order them that way.

## Setup
<svg width="100%" viewBox="0 0 680 H" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t d">
  <title id="t">Short title</title><desc id="d">One sentence of what it shows</desc>
  <defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </marker>
  </defs>
</svg>
- 680 is the coordinate width; width="100%" scales it to the panel, which is narrow (about 400-900px), so keep labels at the sizes below.
- H = the lowest element's y + height + 40. Compute it, do not guess. Safe area: x 40 to 640, y 40 to H-40.
- The page's background is the theme's; do not paint one.

## Colors: classes, not hex
The browser's theme is light or dark, so never hard-code colors. Put a class on a group or shape:
c-blue, c-teal, c-green, c-amber, c-coral, c-red, c-pink, c-purple, c-gray.
A shape inside <g class="c-blue"> (or a shape with the class) gets the hue's tint as fill and the hue as stroke; text.th and text.t in it get a readable shade of the hue, text.ts the hue itself. Plain text: class t (14px), ts (12px, muted), th (14px, medium). Neutral boxes: <g class="box">. Connectors: class arr; annotation lines: class leader. Presentation attributes cannot read CSS variables; where you need a variable, write style="fill: var(--color-text-secondary)".
Color carries meaning, not sequence: 2-3 hues per diagram (warm for active or hot, cool for calm or passive, gray for structure).

## Type and layout
- Two sizes (14px labels, 12px subtitles), two weights (400, 500). Sentence case.
- Centered text in a box: text-anchor="middle" dominant-baseline="central".
- Width estimate: 14px text is about 8px a character, 12px about 7px; box width = max(title chars x 8, subtitle chars x 7) + 48.
- Borders stroke-width 0.5, connectors 1.5. rx 4 subtle, 8 emphasized, 20 large containers.
- One-line box 44px tall, two-line 56px. At least 60px between boxes, 24px padding inside.
- At most 4-5 nodes in a row. Every connector path has fill="none".

## Patterns
<g class="c-purple"><rect x="100" y="20" width="180" height="44" rx="8" stroke-width="0.5"/><text class="th" x="190" y="42" text-anchor="middle" dominant-baseline="central">Node title</text></g>
<g class="c-blue"><rect x="100" y="20" width="200" height="56" rx="8" stroke-width="0.5"/><text class="th" x="200" y="38" text-anchor="middle" dominant-baseline="central">Title</text><text class="ts" x="200" y="56" text-anchor="middle" dominant-baseline="central">Short subtitle</text></g>
<line class="arr" x1="200" y1="76" x2="200" y2="120" marker-end="url(#arrow)"/>
Dashed flow: add stroke-dasharray="4 3". Annotation: a class="leader" line to a 12px label in the right margin (x > 560).

## Kinds
1. Flowchart: sequences and decisions, one direction, arrows never cross unrelated boxes (route with L-bends), same-type boxes the same height.
2. Structural: containment, nested rects, 2-3 levels, 20px padding inside containers, different hues for parent and child.
3. Illustrative: intuition for how something works; freeform shapes following the subject, color for intensity, labels in the margin with leader lines, strokes never over text.

## Before you send
ViewBox height computed; nothing past x 640 or below H-40; text fits its boxes; no arrow through a box; every path connector fill="none"; every text has a class or fill.
For a complex subject send several small diagrams (3-5 nodes each, overview first) with a sentence between them, rather than one dense one. Do not invent data; label illustrative quantities with units.`,

  interactive: `# Interactive pages (after Open Intelligent UI's master playbook and advanced-visualization skill)

Use a page when it helps the user understand (a mechanism with a variable to change), compare (criteria and trade-offs; adjustable weights or filters only when they help decide) or get something done (a working tool: inputs, validated calculation, outputs, reset). For a plain list or comparison of things with the same fields, ui_table is better. Do not turn every answer into a dashboard.

## Contract
ui_show fields in this order: title, id, height (estimated finished height), css (all styles; lean), html (readable body markup, meaningful before scripts run), js (named functions, then a few calls).
js is a classic script: no top-level await, no static import. Import inside an async function and show failures:
  async function setup() {
    const { Chart } = await import("chart.js/auto");
    // build the chart
  }
  setup().catch(() => { document.getElementById("status").textContent = "The chart could not load."; });
Bare imports: three (and three/examples/jsm/...), d3, chart.js, gsap. Other scripts only from cdnjs.cloudflare.com, esm.sh, cdn.jsdelivr.net, unpkg.com. Stylesheets from those CDNs work as <link> inside html or @import in css.
There is no localStorage, sessionStorage, cookies, IndexedDB or fetch to other sites, no access to the panel or the tab, no forms that submit, no popups and no alert(). Images may come from any https address.

## The panel
The page sits in the browser's side panel, about 400-900px wide, in the browser's light or dark theme. Use the theme variables, never fixed colors: --color-text-primary/secondary/tertiary, --color-background-primary/secondary/tertiary, --color-border-primary/secondary/tertiary, --color-accent, and --color-text-info/success/warning/danger with matching --color-background-* tints. For canvas, read them with getComputedStyle(document.documentElement).getPropertyValue(...). Form controls, buttons, tables and links are already styled.
Layout that wraps: grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)). Bounded chart containers (a fixed height wrapper) and one chart updated on input, not recreated. The page's height follows its content; set height to your estimate.

## Data
Use the user's values or what you read from pages. Label sample values in the page. A chart does not fetch evidence; never invent live prices, weather or business data or source links. Show units, formulas and assumptions in the page.

## Controls
Real buttons (type="button"), labels tied to inputs, visible focus, keyboard use, a role="status" element for results and errors.
Validate numbers: input.valueAsNumber, Number.isFinite, domain limits, no zero divisors; never show NaN, Infinity or a stale result as valid. Format with Intl.NumberFormat. Reset puts inputs and results back together. Never eval what the user typed.
Sorting is a button in the header and keeps the current filter. Render strings with textContent, not HTML interpolation. Use labels and patterns as well as color, give canvas and SVG a text summary, and respect prefers-reduced-motion with pause and reset for animation.
3D: Three.js with lights, antialiasing, a responsive canvas, one animation loop, a visible error if WebGL fails. Prefer SVG or HTML when they explain it with less.

## Maps
Leaflet 1.9.4 from https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js (add a script element in your async setup and await its load) with https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css as a <link>. Tiles from a public https service with its attribution visible, for example OpenStreetMap (https://tile.openstreetmap.org/{z}/{x}/{y}.png, "© OpenStreetMap contributors", maxZoom 19). Give the map a fixed height (about 300px), call map.invalidateSize() after setup, scrollWheelZoom: false, L.circleMarker or L.divIcon markers. Coordinates you know only roughly are labeled approximate; lines between stops are not driving directions unless you have them.

## Asking you back
Sliders, filters and calculations stay in the page. A button the user clicks may ask you something with the values it shows:
  <button type="button" onclick="ask(this)">Ask about this scenario</button><p id="ask-status" role="status"></p>
  async function ask(button) {
    const status = document.getElementById("ask-status");
    button.disabled = true;
    try {
      await lazyvimium.sendPrompt({ text: "Explain the assumptions behind 3 people splitting $120 with 15% tip." });
      status.textContent = "Asked.";
    } catch (e) {
      status.textContent = e.message;
    } finally {
      button.disabled = false;
    }
  }
Never call it on load, on a timer or on input changes: it refuses calls the user did not click. Label the button as something that asks. lazyvimium.openLink({ url }) opens an https page in a new tab and lazyvimium.focusTab({ tab: "t3" }) brings one of the user's tabs to the front, also only from a click; plain <a href="https://..."> links open in a new tab too. Each page stands on its own: a follow-up is a new turn, and you change an earlier page by calling ui_show again with its id.`,
};

/**
 * @param {string} topic
 * @returns {string} The guide for the topic.
 */
export function uiGuide(topic) {
  const guide = GUIDES[topic];
  if (!guide) {
    throw new Error(
      `There is no guide ${JSON.stringify(String(topic))}; topics: ${Object.keys(GUIDES).join(", ")}.`
    );
  }
  return guide;
}
