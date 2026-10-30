// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Reading and driving a page for an agent, ported from browser-use's
// jev-ultrafast (snapshot.js, browser.py; MIT License, Copyright (c) 2026
// Browser Use). One pass reads the visible controls and text. Element ids
// belong to this code, never to the model: an id names an actual node, and
// acting on it first checks that the node still means what it meant when it
// was observed, then that nothing covers it.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";
import {
  actions as scrollActions,
  scrollTarget,
} from "resource:///modules/lazyvimium/plugins/LazyvimiumScrollContent.sys.mjs";

const ROLES = [
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "gridcell",
  "combobox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "treeitem",
];
const SELECTOR = [
  "a[href]",
  "button",
  "input",
  "textarea",
  "select",
  "summary",
  '[contenteditable="true"]',
  '[contenteditable=""]',
  ...ROLES.map(role => `[role="${role}"]`),
].join(",");
// Passwords and files are left to the user.
const UNSAFE_TYPES = new Set(["password", "file", "hidden"]);
const EDITABLE_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);
const MAX_ELEMENTS = 250;
const MAX_TEXT = 6000;
const MAX_OPTIONS = 30;
const MIN_FRAME_SIZE = 8;
const REVEAL_TIMEOUT_MS = 400;
const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT
const MAX_OUTLINE = 60;
const TREE_TIMEOUT_MS = 300;
// Tables and lists an observation points out, and how a read of one is cut.
const MIN_ROWS = 5;
const MAX_DATA_REGIONS = 6;
const DATA_BUDGET_MS = 60;
const IN_VIEW_ROWS_MAX = 400;
const EXTRACT_ROWS = 100;
const EXTRACT_MAX_ROWS = 500;
const EXTRACT_MAX_CHARS = 30000;
const CELL_MAX = 200;
const FETCH_MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGERS = 8;
const PAGER_LABEL_MAX = 40;
// What the controls that page through a list are called.
const PAGER =
  /^(next|previous|prev|older|newer|first|last|more|next page|previous page|[<>‹›«»]+)$|\b(next|previous|prev)\s+page\b|\bpage\s+\d+\b|\b(load|show|view|see)\s+more\b|\b\d+\s*[-–]\s*\d+\b/i;
// Names, roles and states from Gecko's accessibility tree instead of this
// file's own reading of the DOM. Turning the accessibility engine on costs
// the process some layout work, so it can be turned off.
const PREF_A11Y = "lazyvimium.agent.a11y";

// Landmarks and headings, the page's outline.
const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "dialog",
  "alertdialog",
  "form",
  "main",
  "navigation",
  "region",
  "search",
]);
const IMPLICIT_LANDMARKS = {
  header: "banner",
  nav: "navigation",
  main: "main",
  aside: "complementary",
  footer: "contentinfo",
  dialog: "dialog",
  form: "form",
};
const OUTLINE_SELECTOR = [
  "h1,h2,h3,h4,h5,h6,header,nav,main,aside,footer,dialog,form",
  '[role="heading"]',
  ...[...LANDMARK_ROLES].map(role => `[role="${role}"]`),
].join(",");

let gA11yService;

// Asking for the service turns the accessibility engine on in this process,
// for every page in it, until the browser restarts: letting go of the
// service and collecting garbage left it on in a benchmark. On a 4,000-node
// page it cost tens of megabytes and a slower load, so it is only asked for
// once an agent reads a page, and the pref turns that off.
function a11yService() {
  if (gA11yService === undefined) {
    try {
      gA11yService = Cc["@mozilla.org/accessibilityService;1"].getService(
        Ci.nsIAccessibilityService
      );
    } catch {
      // A build without accessibility.
      gA11yService = null;
    }
  }
  return gA11yService;
}

/**
 * @returns {boolean} Whether this process has the accessibility engine on.
 */
export function a11yActive() {
  return Services.appinfo.accessibilityEnabled;
}

// The accessibility tree of a document is built after layout, not at once:
// wait for it, briefly, so the first observation is not the fallback one.
// The tree of a document is built after layout, and until it is, its
// controls have no accessibles: wait for the document's to settle, but no
// longer than a moment, since a page that keeps loading stays busy. Reading
// goes on without it, controls the tree lacks falling back to the markup.
async function treeReady(window, service) {
  const deadline = Date.now() + TREE_TIMEOUT_MS;
  for (;;) {
    try {
      const accessible = service.getAccessibleFor(window.document);
      if (accessible) {
        const state = {};
        accessible.getState(state, {});
        if (!(state.value & Ci.nsIAccessibleStates.STATE_BUSY)) {
          return true;
        }
      }
    } catch {
      return false;
    }
    if (Date.now() >= deadline) {
      return !!service.getAccessibleFor(window.document);
    }
    await new Promise(resolve => window.setTimeout(resolve, 20));
  }
}

// An accessibility string: null for a control with no name, which is
// common (icon buttons, bare inputs).
function a11yText(text, max = 120) {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

// What the accessibility tree says about an element, or null when it has no
// accessible (yet): role, name, description and the states that matter to
// someone acting on it.
function a11yFacts(service, element) {
  // Whatever the tree does, the page can still be read from its markup.
  try {
    const accessible = service.getAccessibleFor(element);
    return accessible ? factsOf(accessible) : null;
  } catch {
    return null;
  }
}

function factsOf(accessible) {
  const state = {};
  accessible.getState(state, {});
  const has = flag => !!(state.value & Ci.nsIAccessibleStates[flag]);
  const facts = {
    role: accessible.computedARIARole,
    name: a11yText(accessible.name),
    description: a11yText(accessible.description),
    focused: has("STATE_FOCUSED"),
    required: has("STATE_REQUIRED"),
    invalid: has("STATE_INVALID"),
    readonly: has("STATE_READONLY"),
  };
  if (has("STATE_EXPANDED")) {
    facts.expanded = "true";
  } else if (has("STATE_COLLAPSED")) {
    facts.expanded = "false";
  }
  if (has("STATE_CHECKABLE")) {
    facts.checked = has("STATE_MIXED") ? "mixed" : String(has("STATE_CHECKED"));
  }
  if (has("STATE_PRESSED")) {
    facts.pressed = "true";
  }
  if (has("STATE_SELECTABLE")) {
    facts.selected = String(has("STATE_SELECTED"));
  }
  return facts;
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13 },
  Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  " ": { code: "Space", keyCode: 32 },
};

// The names agents give keys, which are not always the DOM's: in dev testing
// they sent "Space" and "Shift+Tab" and were told the key did not exist.
const KEY_ALIASES = {
  space: " ",
  spacebar: " ",
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pgup: "PageUp",
  pgdn: "PageDown",
  pagedown: "PageDown",
  pageup: "PageUp",
};

const MODIFIER_KEYS = {
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, flag: "shiftKey" },
  control: {
    key: "Control",
    code: "ControlLeft",
    keyCode: 17,
    flag: "ctrlKey",
  },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17, flag: "ctrlKey" },
  alt: { key: "Alt", code: "AltLeft", keyCode: 18, flag: "altKey" },
  option: { key: "Alt", code: "AltLeft", keyCode: 18, flag: "altKey" },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91, flag: "metaKey" },
  cmd: { key: "Meta", code: "MetaLeft", keyCode: 91, flag: "metaKey" },
};

/**
 * A key as an agent names it, such as "Enter", "Space", "Shift+Tab" or
 * "Control+a": the key and the modifiers held with it.
 *
 * @param {string} text
 * @returns {{key: string, info: {code: string, keyCode: number}, modifiers: object[]}|null}
 */
export function parseKey(text) {
  const parts = text.length > 1 ? text.split("+") : [text];
  // "Control++" holds Control and presses +.
  if (parts.length > 1 && parts.at(-1) == "" && parts.at(-2) == "") {
    parts.splice(-2, 2, "+");
  }
  const name = parts.pop();
  const modifiers = [];
  for (const part of parts) {
    const modifier = MODIFIER_KEYS[part.trim().toLowerCase()];
    if (!modifier) {
      return null;
    }
    modifiers.push(modifier);
  }
  let key = KEY_ALIASES[name.toLowerCase()] ?? name;
  key =
    Object.keys(KEYS).find(k => k.toLowerCase() == key.toLowerCase()) ?? key;
  if (KEYS[key]) {
    return { key, info: KEYS[key], modifiers };
  }
  if ([...key].length != 1) {
    return null;
  }
  // Letters and digits carry their key code, which shortcuts such as
  // Control+A read.
  const upper = key.toUpperCase();
  const keyCode = /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0;
  return { key, info: { code: "", keyCode }, modifiers };
}

export class LazyvimiumStalePage extends Error {
  /**
   * @param {string} message
   * @param {object} [options]
   * @param {boolean} [options.hidden] The element is there and unchanged,
   *   only hidden, as auto-hiding player controls are.
   */
  constructor(message, { hidden = false } = {}) {
    super(message);
    this.name = "LazyvimiumStalePage";
    this.hidden = hidden;
  }
}

/**
 * Per document: the ids handed out, what each control looked like when last
 * observed (guards), what it was (kinds, to find its replacement when the
 * page swaps it out), the regions that were named as outline entries, and a
 * counter that moves whenever the page does.
 *
 * @type {WeakMap<Document, {ids: WeakMap<Element, number>, nodes: Map<number, WeakRef<Element>>, guards: Map<number, string>, kinds: Map<number, {role: string, label: string}>, regions: Set<number>, version: number, watching: boolean}>}
 */
const gPages = new WeakMap();

// Ids count up across every document of the process, so an id from the page
// before a navigation never names an element of the next one. In dev
// testing, a fresh e3 on the next page told the agent its old e3 was gone
// while listing an e3 right below.
let gNextId = 1;

function pageOf(document) {
  let page = gPages.get(document);
  if (!page) {
    page = {
      ids: new WeakMap(),
      nodes: new Map(),
      guards: new Map(),
      kinds: new Map(),
      regions: new Set(),
      version: 0,
      watching: false,
    };
    gPages.set(document, page);
  }
  return page;
}

// Count what changes the page shows, from the first observation on: markup,
// attributes and text, but also what people do to it that markup does not
// show, typing and scrolling. page_wait waits on this counter rather than
// for a fixed time.
function watch(window, page) {
  if (page.watching) {
    return;
  }
  page.watching = true;
  const bump = () => {
    page.version++;
  };
  new window.MutationObserver(bump).observe(window.document, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  // Not focus: clicking a button that does nothing focuses it, and that
  // would read as the page answering.
  for (const type of ["input", "change", "scroll", "resize", "load"]) {
    window.addEventListener(type, bump, { capture: true, passive: true });
  }
}

function identity(page, element) {
  let id = page.ids.get(element);
  if (!id) {
    id = gNextId++;
    page.ids.set(element, id);
  }
  page.nodes.set(id, new WeakRef(element));
  return id;
}

function visible(element) {
  return (
    !element.closest('[aria-hidden="true"],[inert]') &&
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  );
}

function disabled(element) {
  return (
    element.matches(":disabled") || !!element.closest('[aria-disabled="true"]')
  );
}

function accessibleName(element, seen = new Set()) {
  if (!element || seen.has(element)) {
    return "";
  }
  seen.add(element);
  const root = element.getRootNode();
  const referenced = (element.getAttribute("aria-labelledby") || "")
    .split(/\s+/)
    .filter(Boolean)
    .map(id => accessibleName(root.getElementById?.(id), seen))
    .filter(Boolean)
    .join(" ");
  const type = element.getAttribute("type");
  const ownText = () =>
    [...element.childNodes]
      .map(node => {
        if (node.nodeType == node.TEXT_NODE) {
          return node.textContent;
        }
        if (
          node.nodeType == node.ELEMENT_NODE &&
          node.getAttribute("aria-hidden") != "true"
        ) {
          return accessibleName(node, seen);
        }
        return "";
      })
      .join(" ");
  const name =
    referenced ||
    element.getAttribute("aria-label") ||
    [...(element.labels ?? [])]
      .map(label => accessibleName(label, seen))
      .filter(Boolean)
      .join(" ") ||
    (["button", "submit", "reset"].includes(type) ? element.value : "") ||
    element.getAttribute("alt") ||
    (element.localName == "input" || element.localName == "select"
      ? ""
      : ownText()) ||
    element.getAttribute("title") ||
    element.getAttribute("placeholder") ||
    "";
  return name.replace(/\s+/g, " ").trim().slice(0, 120);
}

function roleOf(element) {
  const explicit = element.getAttribute("role");
  if (ROLES.includes(explicit)) {
    return explicit;
  }
  switch (element.localName) {
    case "button":
    case "summary":
      return "button";
    case "a":
      return "link";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "input": {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio"].includes(type)) {
        return type;
      }
      if (["button", "submit", "reset", "image"].includes(type)) {
        return "button";
      }
      if (type == "search") {
        return "searchbox";
      }
      if (type == "number") {
        return "spinbutton";
      }
      if (type == "range") {
        return "slider";
      }
      return "textbox";
    }
  }
  return element.isContentEditable ? "textbox" : null;
}

function isEditable(element, role) {
  if (element.readOnly || element.getAttribute("aria-readonly") == "true") {
    return false;
  }
  return (
    EDITABLE_ROLES.has(role) ||
    (role == "combobox" &&
      (element.localName == "input" || element.localName == "textarea"))
  );
}

function fieldValue(element, role) {
  // A checkbox's or button's value is what the form sends ("on"), not
  // anything a person sees; their state says the rest.
  if (
    ["checkbox", "radio", "switch", "button"].includes(role) ||
    ["checkbox", "radio", "submit", "reset", "button", "image"].includes(
      element.type
    )
  ) {
    return null;
  }
  if ("value" in element && element.localName != "button") {
    return String(element.value ?? "");
  }
  if (element.isContentEditable || role == "combobox") {
    return element.innerText.trim().slice(0, 200);
  }
  return null;
}

// What an element means, compared before acting on it: the same node with
// the same role, name, state and surroundings. Geometry is left out; it is
// measured again right before any input.
function guardOf(element) {
  const scope =
    element.closest('form,dialog,[role="dialog"],article,li,tr,[role="row"]') ??
    element.parentElement;
  return JSON.stringify([
    roleOf(element),
    accessibleName(element),
    element.value ?? null,
    element.checked ?? null,
    element.selectedIndex ?? null,
    disabled(element),
    element.getAttribute("aria-expanded"),
    element.getAttribute("aria-checked"),
    element.getAttribute("aria-selected"),
    element.getAttribute("href"),
    stableText(scope?.innerText?.slice(0, 2000) ?? ""),
  ]);
}

// The words around a control, without the numbers: a ticking table (prices,
// counts, ages) rewrites its rows every few seconds, and in dev testing the
// agent was told "changed since it was observed" on the same row over and
// over. A node a framework reuses for another row still changes the words.
function stableText(text) {
  return text.replace(/[$€£+\-−]?\d[\d.,:]*[%a-zA-Z]{0,2}(?![a-zA-Z])/g, "#");
}

// Controls in the document and in every shadow root under it, including
// closed ones, which privileged code can see.
function* controls(root) {
  yield* root.querySelectorAll(SELECTOR);
  for (const element of root.querySelectorAll("*")) {
    const shadow = element.openOrClosedShadowRoot;
    if (shadow) {
      yield* controls(shadow);
    }
  }
}

// Frames in the document and in every shadow root under it.
function* iframes(root) {
  yield* root.querySelectorAll("iframe,frame");
  for (const element of root.querySelectorAll("*")) {
    const shadow = element.openOrClosedShadowRoot;
    if (shadow) {
      yield* iframes(shadow);
    }
  }
}

// The frames a person can see here, which the agent reads through their own
// actors: a frame's document may live in another process, so only its
// browsing context id crosses over. Tracking pixels and hidden frames are
// left out.
function visibleFrames(window) {
  const frames = [];
  for (const element of iframes(window.document)) {
    const id = element.browsingContext?.id;
    const rect = element.getBoundingClientRect();
    if (
      !id ||
      rect.width < MIN_FRAME_SIZE ||
      rect.height < MIN_FRAME_SIZE ||
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= window.innerWidth ||
      rect.top >= window.innerHeight ||
      !visible(element)
    ) {
      continue;
    }
    frames.push({
      id,
      title: (element.title || element.name || "").slice(0, 80),
      src: (element.src || "").slice(0, 200),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
    });
  }
  return frames;
}

function inViewport(rect, window) {
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    x >= 0 &&
    y >= 0 &&
    x < window.innerWidth &&
    y < window.innerHeight
  );
}

// The text in view, or with everywhere set all of the root's, as a scoped
// reading wants: a form taller than the window is still the one form.
function visibleText(
  document,
  window,
  root = document.body,
  everywhere = false
) {
  const words = [];
  let length = 0;
  const walker = document.createTreeWalker(root, SHOW_TEXT);
  const range = document.createRange();
  let node;
  while ((node = walker.nextNode()) && length < MAX_TEXT) {
    const value = node.textContent.replace(/\s+/g, " ").trim();
    const parent = node.parentElement;
    if (
      !value ||
      !parent ||
      parent.closest("script,style,noscript,template") ||
      !visible(parent)
    ) {
      continue;
    }
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      (everywhere ||
        (rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth))
    ) {
      words.push(value);
      length += value.length + 1;
    }
  }
  const text = words.join("\n");
  return { text: text.slice(0, MAX_TEXT), cut: text.length > MAX_TEXT };
}

// Whether the agent is told about an element, and with which role: one it can
// use and that shows, in view or, for a scoped reading, anywhere in the scope.
function listable(window, element, everywhere) {
  const type = (element.getAttribute("type") || "").toLowerCase();
  if (
    (element.localName == "input" && UNSAFE_TYPES.has(type)) ||
    disabled(element)
  ) {
    return null;
  }
  const target = pressTarget(element);
  if (!target) {
    return null;
  }
  const role = roleOf(element);
  const rect = target.getBoundingClientRect();
  const shown = everywhere
    ? rect.width > 0 && rect.height > 0
    : inViewport(rect, window);
  if (!role || !shown) {
    return null;
  }
  if (role == "gridcell" && element.querySelector('button,[role="button"]')) {
    return null;
  }
  return { role, rect, target };
}

// What to press for an element: itself, or for a checkbox or radio the
// page hides behind a styled label, as most design systems do, that label.
// jev and the first port left those out, so "I agree" boxes could not be
// ticked.
function pressTarget(element) {
  if (visible(element)) {
    return element;
  }
  if (
    element.localName == "input" &&
    ["checkbox", "radio"].includes(element.type) &&
    !element.closest('[aria-hidden="true"],[inert]')
  ) {
    return (
      [...(element.labels ?? [])].find(label => {
        const rect = label.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && visible(label);
      }) ?? null
    );
  }
  return null;
}

const LABEL_MAX = 80;

function textOf(node) {
  const text =
    node.nodeType == node.TEXT_NODE ? node.textContent : node.innerText;
  return (text ?? "").replace(/\s+/g, " ").trim();
}

// The text a person reads as a field's label when the markup does not tie
// one to it: the cell before it in a table row, else the text just before
// it (just after, for a checkbox or radio). Another control in between
// means the text belongs to that one. In dev testing a sign-up form laid out
// as a table showed thirty fields all named "textbox", and the agent filled
// them by counting.
function nearbyLabel(element) {
  const after = ["checkbox", "radio"].includes(element.type);
  const cell = element.closest("td,th,[role='cell'],[role='gridcell']");
  if (cell && !after) {
    for (let prev = cell.previousElementSibling; prev; ) {
      if (prev.querySelector(SELECTOR)) {
        break;
      }
      const text = textOf(prev);
      if (text) {
        return text.length <= LABEL_MAX ? text : "";
      }
      prev = prev.previousElementSibling;
    }
  }
  let node = element;
  for (let depth = 0; node && depth < 3; depth++) {
    for (
      let sibling = after ? node.nextSibling : node.previousSibling;
      sibling;
      sibling = after ? sibling.nextSibling : sibling.previousSibling
    ) {
      if (
        sibling.nodeType == sibling.ELEMENT_NODE &&
        (sibling.matches(SELECTOR) || sibling.querySelector(SELECTOR))
      ) {
        return "";
      }
      if (
        sibling.nodeType != sibling.TEXT_NODE &&
        sibling.nodeType != sibling.ELEMENT_NODE
      ) {
        continue;
      }
      const text = textOf(sibling);
      if (text) {
        return text.length <= LABEL_MAX ? text : "";
      }
    }
    node = node.parentElement;
    if (!node || node.matches("form,body,[role='form'],fieldset")) {
      break;
    }
  }
  return "";
}

// What a form field needs and what the page refused, from the markup too,
// so forms say it without the accessibility tree.
function addFormState(element, facts, item) {
  if (
    !facts &&
    (element.required || element.getAttribute("aria-required") == "true")
  ) {
    item.required = true;
  }
  // What the page refused, after the agent typed or submitted: the reason a
  // form will not go through.
  if (
    element.matches(":user-invalid") ||
    (!facts && element.getAttribute("aria-invalid") == "true")
  ) {
    item.invalid = true;
    if (element.validationMessage) {
      item.error = element.validationMessage.slice(0, 120);
    }
  }
}

// One control as the agent reads it: what it is called and says, and the
// state it is in. The accessibility tree answers where it has an accessible,
// the markup where it does not.
function controlItem(window, element, { id, role, rect, target, facts }) {
  const item = {
    id: `e${id}`,
    role,
    label:
      facts?.name || accessibleName(element) || nearbyLabel(element) || role,
  };
  if (facts?.description) {
    item.description = facts.description;
  }
  for (const flag of ["focused", "required", "invalid"]) {
    if (facts?.[flag]) {
      item[flag] = true;
    }
  }
  addFormState(element, facts, item);
  if (isEditable(element, role)) {
    item.editable = true;
  }
  // Said up front, so the agent does not click what a panel covers: in
  // dev testing it tried YouTube Music's Play under the player three times.
  const cover = inViewport(rect, window) ? coverOf(window, target, rect) : null;
  if (cover) {
    item.covered = describe(cover).slice(0, 80);
  }
  const value = fieldValue(element, role);
  if (value || (value !== null && item.editable)) {
    item.value = value.slice(0, 200);
  }
  for (const key of ["checked", "selected", "expanded"]) {
    const state = facts?.[key] ?? element.getAttribute(`aria-${key}`);
    if (state !== null && state !== undefined) {
      item[key] = state;
    }
  }
  if (facts?.pressed) {
    item.pressed = facts.pressed;
  }
  if (role == "checkbox" || role == "radio") {
    item.checked ??= String(!!element.checked);
  }
  if (element.localName == "select") {
    item.value = [...element.selectedOptions].map(o => o.label).join(", ");
    const options = [...element.options].filter(o => !o.disabled);
    item.options = options.slice(0, MAX_OPTIONS).map(o => o.label);
    // A year or country list runs past what is shown; select still takes
    // any of them by its text.
    if (options.length > MAX_OPTIONS) {
      item.moreOptions = options.length - MAX_OPTIONS;
    }
  }
  return item;
}

/**
 * Read the page: its address, the controls in view with their ids and the
 * visible text.
 *
 * @param {Window} window
 * @param {object} [options]
 * @param {string} [options.scope] An outline entry's id: read only what is
 *   inside it, all of it rather than what is in view.
 * @param {boolean} [options.outline] Also list the page's landmarks and
 *   headings, to pick a scope from.
 * @param {boolean} [options.a11y] Read names and states from the
 *   accessibility tree; the pref decides when left out.
 * @returns {Promise<object>}
 */
export async function observe(window, { scope, outline = false, a11y } = {}) {
  const document = window.document;
  const service =
    (a11y ?? Services.prefs.getBoolPref(PREF_A11Y, false)) && a11yService();
  let treeBuilt = false;
  if (service && document.body) {
    treeBuilt = await treeReady(window, service);
  }
  const scroll = scrollState(window);
  const base = {
    url: document.URL,
    title: document.title,
    loading: document.readyState == "loading",
    scroll,
  };
  if (!document.body) {
    return {
      ...base,
      elements: [],
      text: "",
      omitted: 0,
      frames: [],
      version: 0,
    };
  }
  const page = pageOf(document);
  watch(window, page);
  for (const [id, ref] of page.nodes) {
    if (!ref.deref()?.isConnected) {
      page.nodes.delete(id);
      page.guards.delete(id);
      page.kinds.delete(id);
      page.regions.delete(id);
    }
  }
  const root = scope ? resolveRegion(window, scope) : document;
  const elements = [];
  const pagers = [];
  let omitted = 0;
  const seen = new Set();
  for (const element of controls(root)) {
    if (seen.has(element)) {
      continue;
    }
    seen.add(element);
    const listed = listable(window, element, !!scope);
    if (!listed) {
      if (!scope && pagers.length < MAX_PAGERS) {
        const pager = pagerOf(window, page, element);
        if (pager) {
          pagers.push(pager);
        }
      }
      continue;
    }
    const { role, rect, target } = listed;
    if (elements.length >= MAX_ELEMENTS) {
      omitted++;
      continue;
    }
    const id = identity(page, element);
    page.guards.set(id, guardOf(element));
    page.kinds.set(id, { role, label: accessibleName(element) });
    const facts = service && treeBuilt ? a11yFacts(service, element) : null;
    elements.push(
      controlItem(window, element, { id, role, rect, target, facts })
    );
  }
  const read = scope
    ? visibleText(document, window, root, true)
    : visibleText(document, window);
  return {
    ...base,
    elements,
    omitted,
    frames: scope ? [] : visibleFrames(window),
    text: read.text,
    textCut: read.cut,
    ...(!scope && { data: dataRegions(window, page), pagers }),
    selection: window.getSelection()?.toString().slice(0, 2000) ?? "",
    version: page.version,
    ...(scope && { scope }),
    ...(outline && { outline: outlineOf(window, page, service && treeBuilt) }),
  };
}

// The headings and landmarks of the whole page, each with an id to scope a
// reading to, so the agent can ask for the payment form rather than a page
// of navigation. The ids are for scoping only; none of them can be clicked.
function outlineOf(window, page, service) {
  const entries = [];
  const seen = new Set();
  const visit = root => {
    for (const element of root.querySelectorAll(OUTLINE_SELECTOR)) {
      if (seen.has(element) || !visible(element)) {
        continue;
      }
      seen.add(element);
      const explicit = element.getAttribute("role");
      const heading =
        /^h[1-6]$/.test(element.localName) || explicit == "heading";
      let kind = heading ? "heading" : IMPLICIT_LANDMARKS[element.localName];
      if (LANDMARK_ROLES.has(explicit)) {
        kind = explicit;
      }
      if (!kind) {
        continue;
      }
      const label =
        (service && a11yFacts(service, element)?.name) ||
        accessibleName(element) ||
        (heading
          ? element.textContent.replace(/\s+/g, " ").trim().slice(0, 80)
          : "");
      // A form or region with no name says nothing a scope would not.
      if (!heading && !label && (kind == "form" || kind == "region")) {
        continue;
      }
      const id = identity(page, element);
      page.regions.add(id);
      const level = heading
        ? Number(element.getAttribute("aria-level") || element.localName[1]) ||
          2
        : undefined;
      const rect = element.getBoundingClientRect();
      entries.push({
        id: `e${id}`,
        role: kind,
        label: label.slice(0, 80),
        ...(level && { level }),
        inView:
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth,
      });
    }
    for (const element of root.querySelectorAll("*")) {
      const shadow = element.openOrClosedShadowRoot;
      if (shadow) {
        visit(shadow);
      }
    }
  };
  visit(window.document);
  return entries.slice(0, MAX_OUTLINE);
}

// A control that pages through a list and is out of view, so the agent
// knows there is more than it reads: "Pairs 201-300" sits under a table of
// a hundred rows, past the view and past the 250 controls an observation
// lists. It is given an id like any control, and clicking it scrolls to it.
function pagerOf(window, page, element) {
  // The cheap tests first: this runs for every control out of view.
  const rel = element.getAttribute("rel");
  const raw =
    element.getAttribute("aria-label") ||
    element.textContent ||
    element.title ||
    "";
  if (raw.length > PAGER_LABEL_MAX * 4 && rel != "next" && rel != "prev") {
    return null;
  }
  const label = raw.replace(/\s+/g, " ").trim();
  const named =
    !!label.length && label.length <= PAGER_LABEL_MAX && PAGER.test(label);
  if (!named && rel != "next" && rel != "prev") {
    return null;
  }
  const role = roleOf(element);
  if (!role || disabled(element) || !pressTarget(element)) {
    return null;
  }
  const id = identity(page, element);
  page.guards.set(id, guardOf(element));
  page.kinds.set(id, { role, label: accessibleName(element) });
  const rect = pressTarget(element).getBoundingClientRect();
  return {
    id: `e${id}`,
    role,
    label: label || rel,
    where: rect.top >= window.innerHeight ? "below" : "above",
  };
}

// What a cell says, in one line.
function cellText(element) {
  return (element.innerText ?? element.textContent ?? "")
    .replace(/\s*\n\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CELL_MAX);
}

function hasOwnText(element) {
  return [...element.childNodes].some(
    node => node.nodeType == node.TEXT_NODE && node.textContent.trim()
  );
}

const CELLS = [
  ":scope > td",
  ":scope > th",
  ":scope > [role=cell]",
  ":scope > [role=gridcell]",
  ":scope > [role=columnheader]",
  ":scope > [role=rowheader]",
].join(",");

// The cells of a row: those a table or grid names, else the children of the
// first level where the row splits in more than one, since div grids wrap
// their cells in a layer or two.
function cellsOf(row) {
  const named = [...row.querySelectorAll(CELLS)];
  if (named.length) {
    return named;
  }
  let level = row;
  while (level.children.length == 1 && !hasOwnText(level)) {
    level = level.firstElementChild;
  }
  const parts = [...level.children].filter(
    child =>
      !child.matches("script,style,template") &&
      child.checkVisibility({ checkVisibilityCSS: true })
  );
  return parts.length > 1 ? parts : [level];
}

const TABLES = "table,[role=table],[role=grid],[role=treegrid]";

function signatureOf(element) {
  return `${element.localName}.${element.classList[0] ?? ""}`;
}

// The children of an element that repeat: the most common kind among them,
// if they are most of what it holds.
function repeatedRows(container) {
  const groups = new Map();
  let all = 0;
  for (const child of container.children) {
    if (child.matches("script,style,template")) {
      continue;
    }
    all++;
    const key = signatureOf(child);
    const group = groups.get(key);
    if (group) {
      group.push(child);
    } else {
      groups.set(key, [child]);
    }
  }
  let best = [];
  for (const group of groups.values()) {
    if (group.length > best.length) {
      best = group;
    }
  }
  return best.length >= 2 && best.length >= all * 0.6 ? best : [];
}

// Rows and the header of a table, grid or repeating structure.
function rowsOf(container) {
  if (container.matches(TABLES)) {
    const rows = [...container.querySelectorAll("tr,[role=row]")].filter(
      row => row.closest(TABLES) == container
    );
    const isHeader = row =>
      row.querySelector(":scope > th, :scope > [role=columnheader]") &&
      !row.querySelector(
        ":scope > td, :scope > [role=cell], :scope > [role=gridcell]"
      );
    return {
      header: rows.find(isHeader) ?? null,
      rows: rows.filter(row => !isHeader(row)),
    };
  }
  const rows = repeatedRows(container);
  // A header the grid names, kept out of the rows.
  const header =
    container.parentElement?.querySelector("[role=columnheader]")
      ?.parentElement ?? null;
  return { header: rows.includes(header) ? null : header, rows };
}

// What to call a table or list: its own name, a caption, or the heading
// above it.
function regionLabel(container) {
  const named =
    container.getAttribute("aria-label") ||
    container.querySelector(":scope > caption")?.textContent ||
    container
      .closest("section,[role=region],article")
      ?.querySelector("h1,h2,h3,h4")?.textContent ||
    "";
  return named.replace(/\s+/g, " ").trim().slice(0, 80);
}

// The tables and lists on the page with more rows than a screen shows: where
// the data is, so the agent reads all of it rather than what is in view.
// Found as a person finds them: tables and grids, and parents most of whose
// children are alike with several cells each (rows are often divs).
function dataRegions(window, page) {
  const candidates = [];
  const deadline = Date.now() + DATA_BUDGET_MS;
  const consider = container => {
    if (!visible(container)) {
      return;
    }
    const { rows } = rowsOf(container);
    if (rows.length < MIN_ROWS) {
      return;
    }
    const sample = rows
      .slice(0, 3)
      .map(row => cellsOf(row).length)
      .sort((a, b) => a - b);
    const cols = sample[Math.floor(sample.length / 2)];
    if (cols < 2 && !container.matches(TABLES)) {
      return;
    }
    candidates.push({ container, rows, cols });
  };
  for (const table of window.document.querySelectorAll(TABLES)) {
    consider(table);
  }
  // The parents of every fifth child: the elements with enough children,
  // found in one query rather than by asking each of thousands.
  const parents = new Set();
  for (const fifth of window.document.body.querySelectorAll(
    `:nth-child(${MIN_ROWS})`
  )) {
    parents.add(fifth.parentElement);
  }
  for (const parent of parents) {
    if (Date.now() > deadline) {
      break;
    }
    if (
      parent &&
      !parent.closest(TABLES) &&
      !parent.matches("select,datalist,nav,head")
    ) {
      consider(parent);
    }
  }
  candidates.sort((a, b) => b.rows.length * b.cols - a.rows.length * a.cols);
  const regions = [];
  for (const candidate of candidates) {
    if (regions.length >= MAX_DATA_REGIONS) {
      break;
    }
    if (
      regions.some(
        kept =>
          kept.container.contains(candidate.container) ||
          candidate.container.contains(kept.container)
      )
    ) {
      continue;
    }
    regions.push(candidate);
  }
  return regions.map(({ container, rows, cols }) => {
    const id = identity(page, container);
    page.regions.add(id);
    let inView = 0;
    for (const row of rows.slice(0, IN_VIEW_ROWS_MAX)) {
      const rect = row.getBoundingClientRect();
      if (rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight) {
        inView++;
      }
    }
    return {
      id: `e${id}`,
      kind: container.matches(TABLES) ? "table" : "list",
      label: regionLabel(container),
      rows: rows.length,
      cols,
      inView,
      first: cellsOf(rows[0])
        .map(cellText)
        .filter(Boolean)
        .join(" | ")
        .slice(0, 100),
    };
  });
}

/**
 * Every row of a table or list, in view or not, as tab-separated lines with
 * the header first: what a page shows a screenful of at a time.
 *
 * @param {Window} window
 * @param {object} args
 * @param {string} args.id A data region's id from an observation.
 * @param {number} [args.offset] The row to start at.
 * @param {number} [args.limit] How many rows at most.
 * @returns {object} {text, total, from, to}
 */
export function extract(window, { id, offset = 0, limit } = {}) {
  let container = resolveRegion(window, id);
  let { header, rows } = rowsOf(container);
  if (rows.length < 2) {
    // A region of the outline that holds the table, not the table.
    const inside = container.querySelector(TABLES);
    if (inside) {
      container = inside;
      ({ header, rows } = rowsOf(container));
    }
  }
  if (!rows.length) {
    throw new LazyvimiumStalePage(
      `${id} has no rows to read. Use an id from the "Data on the page" lines of an observation.`
    );
  }
  const from = Math.max(0, Math.min(rows.length, Number(offset) || 0));
  const to = Math.min(
    rows.length,
    from + Math.min(EXTRACT_MAX_ROWS, Number(limit) || EXTRACT_ROWS)
  );
  const origin = window.location.origin;
  const linkOf = row => {
    const anchor = row.localName == "a" ? row : row.querySelector("a[href]");
    if (!anchor?.href) {
      return "";
    }
    return anchor.href.startsWith(origin)
      ? anchor.href.slice(origin.length)
      : anchor.href;
  };
  const lines = [];
  let chars = 0;
  let last = from;
  const links = rows.slice(from, to).map(linkOf);
  const withLinks = links.filter(Boolean).length > (to - from) / 2;
  if (header) {
    lines.push(
      [...cellsOf(header).map(cellText), ...(withLinks ? ["link"] : [])].join(
        "\t"
      )
    );
  }
  for (let i = from; i < to; i++) {
    const cells = cellsOf(rows[i]).map(cellText);
    if (withLinks) {
      cells.push(links[i - from]);
    }
    const line = cells.join("\t");
    if (chars + line.length > EXTRACT_MAX_CHARS && i > from) {
      break;
    }
    chars += line.length + 1;
    lines.push(line);
    last = i + 1;
  }
  return { text: lines.join("\n"), total: rows.length, from, to: last };
}

// A region an outline listed, as a scope: present and showing, but without
// the check controls get, since a dialog's text changes as it is used.
function resolveRegion(window, elementId) {
  const match = /^e(\d+)$/.exec(String(elementId ?? ""));
  const id = match && Number(match[1]);
  const page = pageOf(window.document);
  const element = id && page.nodes.get(id)?.deref();
  if (!element?.isConnected || !page.regions.has(id)) {
    throw new LazyvimiumStalePage(
      `${elementId} is not a region from the page's outline, or it is gone. Observe with the outline again.`
    );
  }
  return element;
}

// The one control now showing with the role and name a lost id had, if there
// is exactly one: frameworks replace nodes they re-render, and what the
// agent meant is usually still there. It is offered, never used on the
// agent's behalf: an equal-looking control can be a different one.
function replacementOf(window, page, id) {
  const kind = page.kinds.get(id);
  if (!kind?.label) {
    return null;
  }
  const matches = [];
  for (const element of controls(window.document)) {
    if (
      roleOf(element) == kind.role &&
      accessibleName(element) == kind.label &&
      visible(element) &&
      !disabled(element)
    ) {
      matches.push(element);
    }
  }
  if (matches.length != 1) {
    return null;
  }
  const found = identity(page, matches[0]);
  page.guards.set(found, guardOf(matches[0]));
  page.kinds.set(found, kind);
  return `e${found}`;
}

function resolveElement(window, elementId) {
  const match = /^e(\d+)$/.exec(String(elementId ?? ""));
  if (!match) {
    throw new LazyvimiumStalePage(
      elementId == null
        ? 'This needs "element": an id such as e12 from page_observe'
        : `"${elementId}" is not an element id from page_observe`
    );
  }
  const id = Number(match[1]);
  const page = pageOf(window.document);
  const element = page.nodes.get(id)?.deref();
  if (page.regions.has(id) && !page.guards.has(id)) {
    throw new LazyvimiumStalePage(
      `${elementId} is a region of the outline, not a control. Use it as scope, or pick a control from an observation of it.`
    );
  }
  if (!element?.isConnected || !page.guards.has(id)) {
    const successor = replacementOf(window, page, id);
    throw new LazyvimiumStalePage(
      successor
        ? `${elementId} was replaced by the page; ${successor} has the same role and name. Observe again to check, then use it.`
        : `${elementId} is no longer on the page. Observe again.`
    );
  }
  if (guardOf(element) != page.guards.get(id)) {
    throw new LazyvimiumStalePage(
      `${elementId} changed since it was observed. Observe again.`
    );
  }
  if (disabled(element)) {
    throw new LazyvimiumStalePage(
      `${elementId} is disabled now. Observe again.`
    );
  }
  if (!pressTarget(element)) {
    const error = new LazyvimiumStalePage(
      `${elementId} is hidden now, even with the mouse over it. Observe again.`,
      { hidden: true }
    );
    error.element = element;
    throw error;
  }
  return element;
}

// The element, shown first if it hides until hovered: in dev testing
// YouTube's player controls faded out between observing and clicking, and
// the agent reloaded the page to see them again.
async function revealElement(window, elementId) {
  try {
    return resolveElement(window, elementId);
  } catch (e) {
    const rect = e.hidden ? e.element.getBoundingClientRect() : null;
    if (!rect?.width || !rect.height) {
      throw e;
    }
    // Real movement onto the element: a mousemove where the mouse already
    // is wakes nothing up, and players fade their controls in.
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    for (const [dx, dy] of [
      [-12, -8],
      [-4, -2],
      [0, 0],
    ]) {
      window.synthesizeMouseEvent("mousemove", x + dx, y + dy, {});
    }
    const deadline = Date.now() + REVEAL_TIMEOUT_MS;
    while (!visible(e.element) && Date.now() < deadline) {
      await settle(window, e.element, false);
    }
    return resolveElement(window, elementId);
  }
}

function describe(element) {
  const label = accessibleName(element);
  return label ? `${element.localName} "${label}"` : element.localName;
}

// Whether a hit lands on the element, counting the anonymous content of a
// text field and anything in its shadow root.
function isWithin(hit, element) {
  for (let node = hit; node; ) {
    if (node == element) {
      return true;
    }
    node = node.flattenedTreeParentNode ?? node.parentNode ?? node.host;
  }
  return false;
}

// What is on top at the center of a rect, if it is not the element: what
// covers it, or the document when nothing visible is there.
function coverOf(window, element, rect) {
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  let hit = window.document.elementFromPoint(x, y);
  // Into shadow roots, down to the element actually under the point.
  while (hit?.openOrClosedShadowRoot) {
    const inner = hit.openOrClosedShadowRoot.elementFromPoint(x, y);
    if (!inner || inner == hit) {
      break;
    }
    hit = inner;
  }
  if (hit && (isWithin(hit, element) || hit.contains(element))) {
    return null;
  }
  return hit ?? window.document.documentElement;
}

// Bring the element into view and find the point to press, refusing one
// that something else covers.
function hitPoint(window, element) {
  let rect = element.getBoundingClientRect();
  if (!inViewport(rect, window)) {
    element.scrollIntoView({ block: "center", inline: "center" });
    rect = element.getBoundingClientRect();
  }
  const cover = coverOf(window, element, rect);
  if (cover) {
    throw new LazyvimiumStalePage(
      `${describe(element)} is covered by ${describe(cover)}. Close what covers it or observe again.`
    );
  }
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// Trusted mouse input through the page's presshell, as a user's would be.
function click(window, element) {
  const { x, y } = hitPoint(window, pressTarget(element) ?? element);
  window.synthesizeMouseEvent("mousemove", x, y, {});
  for (const type of ["mousedown", "mouseup"]) {
    window.synthesizeMouseEvent(type, x, y, { button: 0, clickCount: 1 });
  }
}

function fill(window, element, text) {
  if (!isEditable(element, roleOf(element))) {
    throw new Error(`${describe(element)} cannot be typed into`);
  }
  click(window, element);
  element.focus();
  if (element.localName == "input" || element.localName == "textarea") {
    // As the user typing it, which framework value trackers notice.
    element.setUserInput(text);
  } else {
    window.getSelection().selectAllChildren(element);
    window.document.execCommand("insertText", false, text);
  }
}

// The option an agent means: its exact text or value, else the same text
// ignoring case and spacing, else the one option whose text contains it.
// Agents write "Visa" for "Visa (Preferred)" and "usa" for "USA".
function optionFor(element, choice) {
  const options = [...element.options].filter(
    o => !o.disabled && !o.closest("optgroup[disabled]")
  );
  const exact = options.find(o => o.value === choice || o.label === choice);
  if (exact) {
    return exact;
  }
  const norm = text => text.replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = norm(choice);
  if (!wanted) {
    return null;
  }
  const same = options.find(
    o => norm(o.label) == wanted || norm(o.value) == wanted
  );
  if (same) {
    return same;
  }
  const containing = options.filter(o => norm(o.label).includes(wanted));
  return containing.length == 1 ? containing[0] : null;
}

function select(window, element, choice) {
  if (element.localName != "select") {
    throw new Error(
      `${describe(element)} is not a native list; click it and then its option`
    );
  }
  const option = optionFor(element, choice);
  if (!option) {
    throw new Error(`${describe(element)} has no option "${choice}"`);
  }
  hitPoint(window, element);
  element.focus();
  element.value = option.value;
  element.dispatchEvent(new window.Event("input", { bubbles: true }));
  element.dispatchEvent(new window.Event("change", { bubbles: true }));
}

// A trusted key press through a text input processor, the way EventUtils
// types. That needs the page focused; in a tab the user is not looking at,
// the page gets the events untrusted, and Enter in a form field submits.
function press(window, text) {
  const parsed = parseKey(text);
  if (!parsed) {
    throw new Error(
      `Unknown key "${text}". Use a key such as Enter, Escape, Tab, Space, ArrowDown or a character, with modifiers like Shift+Tab or Control+a.`
    );
  }
  const { key, info, modifiers } = parsed;
  let pressed = false;
  try {
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(
      Ci.nsITextInputProcessor
    );
    // The "for tests" transaction dispatches in this process only. A plain
    // one in a content process also goes through the parent, and the page
    // got every key twice.
    if (tip.beginInputTransactionForTests(window, () => true)) {
      // Modifiers go down first and hold until the key comes up, as a
      // person's fingers do; the processor keeps their state.
      const held = modifiers.map(
        ({ key: name, code, keyCode }) =>
          new window.KeyboardEvent("", { key: name, code, keyCode })
      );
      for (const modifier of held) {
        tip.keydown(modifier);
      }
      const event = new window.KeyboardEvent("", { key, ...info });
      tip.keydown(event);
      pressed = true;
      tip.keyup(event);
      for (const modifier of held.reverse()) {
        tip.keyup(modifier);
      }
    }
  } catch {
    // Not focused: fall through, unless the key already went down.
  }
  if (pressed) {
    return;
  }
  const target = window.document.activeElement ?? window.document.body;
  const init = {
    key,
    code: info.code,
    keyCode: info.keyCode,
    bubbles: true,
    cancelable: true,
  };
  for (const modifier of modifiers) {
    init[modifier.flag] = true;
  }
  const down = new window.KeyboardEvent("keydown", init);
  const proceed = target.dispatchEvent(down);
  target.dispatchEvent(new window.KeyboardEvent("keyup", init));
  if (
    proceed &&
    key == "Enter" &&
    !modifiers.length &&
    target.form &&
    target.localName == "input"
  ) {
    target.form.requestSubmit();
  }
}

// Where the page scrolls: the box a scroll would move, which on app-like
// pages is a panel rather than the document. Reading the window there said
// "0 of 0px" on pages with plenty below, and the agent could not tell.
function scrollState(window) {
  const document = window.document;
  const target = document.body ? scrollTarget(document, true) : null;
  if (!target || target == document.scrollingElement) {
    return {
      y: Math.round(window.scrollY),
      height: document.documentElement?.scrollHeight ?? 0,
      viewport: window.innerHeight,
    };
  }
  return {
    y: Math.round(target.scrollTop),
    height: target.scrollHeight,
    viewport: target.clientHeight,
  };
}

// Let the page answer: two frames, or for a combobox the suggestions it
// shows, capped as jev caps them.
function settle(window, element, autocomplete) {
  return new Promise(resolve => {
    let frames = 0;
    let stopped = false;
    const finish = () => {
      stopped = true;
      resolve();
    };
    window.setTimeout(finish, autocomplete ? 200 : 50);
    const ready = () => {
      if (stopped) {
        return;
      }
      // The suggestions of this field, as jev scopes them: another list on
      // the page that already shows options says nothing about this one.
      const ids = (
        element?.getAttribute("aria-controls") ||
        element?.getAttribute("aria-owns") ||
        ""
      )
        .split(/\s+/)
        .filter(Boolean);
      const roots = ids.length
        ? ids.map(id => window.document.getElementById(id)).filter(Boolean)
        : [window.document];
      const options = autocomplete
        ? roots.flatMap(root => [...root.querySelectorAll('[role="option"]')])
        : [];
      if (
        ++frames >= 2 &&
        (!autocomplete || options.some(option => visible(option)))
      ) {
        finish();
      } else {
        window.requestAnimationFrame(ready);
      }
    };
    window.requestAnimationFrame(ready);
  });
}

/**
 * Do one thing on the page.
 *
 * @param {Window} window
 * @param {object} args
 * @param {"click"|"fill"|"select"|"press"|"scroll"} args.action
 * @param {string} [args.element] An id from observe().
 * @param {string} [args.text] For fill: the text; for select: the option;
 *   for press: the key; for scroll: "up" or "down".
 * @returns {Promise<{done: string, navigated: string|null, changed: boolean}>}
 *   What was done, whether it started a navigation ("document" or
 *   "same-document") and whether anything on the page changed.
 */
export async function act(window, args) {
  const document = window.document;
  const page = document.body ? pageOf(document) : null;
  if (page) {
    watch(window, page);
  }
  const before = page?.version;
  // Whether the action started a navigation, as the page itself reports it,
  // so the caller waits for a new page only when one is coming instead of
  // a fixed quarter second after every click.
  let navigated = null;
  const onNavigate = event => {
    navigated = event.destination?.sameDocument ? "same-document" : "document";
  };
  const navigation = window.navigation;
  navigation?.addEventListener("navigate", onNavigate);
  try {
    const done = await perform(window, args);
    return {
      done,
      navigated,
      changed: navigated !== null || page?.version !== before,
    };
  } finally {
    navigation?.removeEventListener("navigate", onNavigate);
  }
}

async function perform(window, { action, element: elementId, text }) {
  const document = window.document;
  switch (action) {
    case "scroll": {
      if (elementId) {
        const element = resolveElement(window, elementId);
        element.scrollIntoView({ block: "center" });
        await settle(window, element, false);
        return `Scrolled ${describe(element)} into view`;
      }
      const up = text == "up";
      const from = scrollState(window).y;
      scrollActions[up ? "scroll.pageUp" : "scroll.pageDown"](
        { document, opts: { smooth: false } },
        { count: 1 }
      );
      await settle(window, null, false);
      // Said plainly, so the agent stops: in dev testing it scrolled a
      // finished page down and up again for minutes.
      if (scrollState(window).y == from) {
        return `Did not scroll: already at the ${up ? "top" : "bottom"}`;
      }
      return `Scrolled ${up ? "up" : "down"}`;
    }
    case "press": {
      const element = elementId ? await revealElement(window, elementId) : null;
      element?.focus();
      LazyvimiumDom.agentTyping = true;
      try {
        press(window, String(text ?? "Enter"));
      } finally {
        LazyvimiumDom.agentTyping = false;
      }
      await settle(window, element, false);
      return `Pressed ${text ?? "Enter"}${element ? ` in ${describe(element)}` : ""}`;
    }
    case "click":
    case "fill":
    case "select": {
      const element = await revealElement(window, elementId);
      const what = describe(element);
      if (action == "click") {
        click(window, element);
      } else if (action == "fill") {
        fill(window, element, String(text ?? ""));
      } else {
        select(window, element, String(text ?? ""));
      }
      const autocomplete =
        action == "fill" && element.getAttribute("role") == "combobox";
      await settle(window, element, autocomplete);
      return {
        click: `Clicked ${what}`,
        fill: `Typed into ${what}`,
        select: `Selected "${text}" in ${what}`,
      }[action];
    }
  }
  throw new Error(
    `Unknown action "${action}". Use click, fill, select, press or scroll.`
  );
}

export const actions = {
  "agent.observe": async ({ window }, args) => {
    try {
      return await observe(window, args);
    } catch (e) {
      if (e instanceof LazyvimiumStalePage) {
        return { error: e.message };
      }
      throw e;
    }
  },
  // A request made as the page: its origin, its cookies, its CORS rules, so
  // what a page's own script could ask for and nothing more. The network
  // log records the response; this only says how it went.
  "agent.fetch": async (
    { window },
    { url, method = "GET", headers = {}, body = null }
  ) => {
    const started = Date.now();
    const send = credentials =>
      window.fetch(url, {
        method,
        credentials,
        headers: { Accept: "application/json, text/plain, */*", ...headers },
        ...(body !== null && { body }),
      });
    try {
      // With cookies for another site first, which only works if that site
      // allows credentials; one that answers "*" refuses them, so ask again
      // as the page's own scripts do by default. Only a read is asked twice:
      // a request that changes something is sent once.
      const safe = method == "GET" || method == "HEAD";
      const response = await send("include").catch(e => {
        if (!safe) {
          throw e;
        }
        return send("same-origin");
      });
      const length = Number(response.headers.get("content-length")) || 0;
      if (length > FETCH_MAX_BYTES) {
        response.body?.cancel();
        return {
          error: `That response is ${length} bytes, more than the ${FETCH_MAX_BYTES} that can be read.`,
        };
      }
      await response.text();
      return {
        status: response.status,
        mime: response.headers.get("content-type") ?? "",
        ms: Date.now() - started,
      };
    } catch (e) {
      return {
        error: `The page could not fetch it: ${e.message}. A request to another site that does not allow this page's origin fails; page_navigate opens it in a tab instead.`,
      };
    }
  },
  "agent.extract": ({ window }, args) => {
    try {
      return extract(window, args);
    } catch (e) {
      if (e instanceof LazyvimiumStalePage) {
        return { error: e.message };
      }
      throw e;
    }
  },
  // Cheap to ask, for page_wait: where the page's change counter stands, and
  // which frames to ask next.
  "agent.version": ({ window }) => {
    const document = window.document;
    // Counting starts here if no observation did it, so a wait after a
    // navigation sees the new page's changes.
    if (document.body) {
      watch(window, pageOf(document));
    }
    return {
      version: document.body ? pageOf(document).version : 0,
      loading: document.readyState == "loading",
      frames: document.body ? visibleFrames(window).map(frame => frame.id) : [],
    };
  },
  "agent.act": async ({ window }, args) => {
    try {
      return { ok: true, ...(await act(window, args)) };
    } catch (e) {
      // Errors cross the actor boundary as plain text.
      return {
        ok: false,
        stale: e instanceof LazyvimiumStalePage,
        error: String(e.message ?? e),
      };
    }
  },
};
