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
import { actions as scrollActions } from "resource:///modules/lazyvimium/plugins/LazyvimiumScrollContent.sys.mjs";

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
const REVEAL_TIMEOUT_MS = 400;
const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT

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
 * Per document: the ids handed out and what each element looked like when
 * last observed.
 *
 * @type {WeakMap<Document, {ids: WeakMap<Element, number>, nodes: Map<number, WeakRef<Element>>, guards: Map<number, string>}>}
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
    page = { ids: new WeakMap(), nodes: new Map(), guards: new Map() };
    gPages.set(document, page);
  }
  return page;
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
    scope?.innerText?.slice(0, 2000) ?? "",
  ]);
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

function visibleText(document, window) {
  const words = [];
  let length = 0;
  const walker = document.createTreeWalker(document.body, SHOW_TEXT);
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
      rect.bottom > 0 &&
      rect.top < window.innerHeight &&
      rect.right > 0 &&
      rect.left < window.innerWidth
    ) {
      words.push(value);
      length += value.length + 1;
    }
  }
  return words.join("\n").slice(0, MAX_TEXT);
}

/**
 * Read the page: its address, the controls in view with their ids and the
 * visible text.
 *
 * @param {Window} window
 * @returns {object}
 */
export function observe(window) {
  const document = window.document;
  const scroll = {
    y: Math.round(window.scrollY),
    height: document.documentElement?.scrollHeight ?? 0,
    viewport: window.innerHeight,
  };
  const base = {
    url: document.URL,
    title: document.title,
    loading: document.readyState == "loading",
    scroll,
  };
  if (!document.body) {
    return { ...base, elements: [], text: "", omitted: 0 };
  }
  const page = pageOf(document);
  for (const [id, ref] of page.nodes) {
    if (!ref.deref()?.isConnected) {
      page.nodes.delete(id);
      page.guards.delete(id);
    }
  }
  const elements = [];
  let omitted = 0;
  const seen = new Set();
  for (const element of controls(document)) {
    if (seen.has(element)) {
      continue;
    }
    seen.add(element);
    const type = (element.getAttribute("type") || "").toLowerCase();
    if (
      (element.localName == "input" && UNSAFE_TYPES.has(type)) ||
      !visible(element) ||
      disabled(element)
    ) {
      continue;
    }
    const role = roleOf(element);
    const rect = element.getBoundingClientRect();
    if (!role || !inViewport(rect, window)) {
      continue;
    }
    if (role == "gridcell" && element.querySelector('button,[role="button"]')) {
      continue;
    }
    if (elements.length >= MAX_ELEMENTS) {
      omitted++;
      continue;
    }
    const id = identity(page, element);
    page.guards.set(id, guardOf(element));
    const item = {
      id: `e${id}`,
      role,
      label: accessibleName(element) || role,
    };
    if (isEditable(element, role)) {
      item.editable = true;
    }
    // Said up front, so the agent does not click what a panel covers: in
    // dev testing it tried YouTube Music's Play under the player three times.
    const cover = coverOf(window, element, rect);
    if (cover) {
      item.covered = describe(cover).slice(0, 80);
    }
    const value = fieldValue(element, role);
    if (value || (value !== null && item.editable)) {
      item.value = value.slice(0, 200);
    }
    for (const key of ["checked", "selected", "expanded"]) {
      const state = element.getAttribute(`aria-${key}`);
      if (state !== null) {
        item[key] = state;
      }
    }
    if (role == "checkbox" || role == "radio") {
      item.checked ??= String(!!element.checked);
    }
    if (element.localName == "select") {
      item.value = [...element.selectedOptions].map(o => o.label).join(", ");
      item.options = [...element.options]
        .filter(o => !o.disabled)
        .slice(0, MAX_OPTIONS)
        .map(o => o.label);
    }
    elements.push(item);
  }
  return {
    ...base,
    elements,
    omitted,
    text: visibleText(document, window),
    selection: window.getSelection()?.toString().slice(0, 2000) ?? "",
  };
}

function resolveElement(window, elementId) {
  const match = /^e(\d+)$/.exec(String(elementId ?? ""));
  if (!match) {
    throw new LazyvimiumStalePage(
      `"${elementId}" is not an element id from page_observe`
    );
  }
  const id = Number(match[1]);
  const page = pageOf(window.document);
  const element = page.nodes.get(id)?.deref();
  if (!element?.isConnected || !page.guards.has(id)) {
    throw new LazyvimiumStalePage(
      `${elementId} is no longer on the page. Observe again.`
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
  if (!visible(element)) {
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
  const { x, y } = hitPoint(window, element);
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

function select(window, element, choice) {
  if (element.localName != "select") {
    throw new Error(
      `${describe(element)} is not a native list; click it and then its option`
    );
  }
  const option = [...element.options].find(
    o => !o.disabled && (o.value === choice || o.label === choice)
  );
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
function press(window, key) {
  const info = KEYS[key] ?? (key.length == 1 ? { code: "", keyCode: 0 } : null);
  if (!info) {
    throw new Error(`Unknown key "${key}"`);
  }
  let pressed = false;
  try {
    const tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(
      Ci.nsITextInputProcessor
    );
    // The "for tests" transaction dispatches in this process only. A plain
    // one in a content process also goes through the parent, and the page
    // got every key twice.
    if (tip.beginInputTransactionForTests(window, () => true)) {
      const event = new window.KeyboardEvent("", { key, ...info });
      tip.keydown(event);
      pressed = true;
      tip.keyup(event);
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
  const down = new window.KeyboardEvent("keydown", init);
  const proceed = target.dispatchEvent(down);
  target.dispatchEvent(new window.KeyboardEvent("keyup", init));
  if (proceed && key == "Enter" && target.form && target.localName == "input") {
    target.form.requestSubmit();
  }
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
      const options = autocomplete
        ? [...window.document.querySelectorAll('[role="option"]')]
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
 * @returns {Promise<string>} What was done.
 */
export async function act(window, { action, element: elementId, text }) {
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
      scrollActions[up ? "scroll.pageUp" : "scroll.pageDown"](
        { document, opts: { smooth: false } },
        { count: 1 }
      );
      await settle(window, null, false);
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
  throw new Error(`Unknown action "${action}"`);
}

export const actions = {
  "agent.observe": ({ window }) => observe(window),
  "agent.act": async ({ window }, args) => {
    try {
      return { ok: true, done: await act(window, args) };
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
