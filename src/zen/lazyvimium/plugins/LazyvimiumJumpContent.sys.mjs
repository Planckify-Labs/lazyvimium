// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumControls } from "resource:///modules/lazyvimium/core/LazyvimiumControls.sys.mjs";
import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";
import {
  assignLabels,
  findMatches,
} from "resource:///modules/lazyvimium/core/LazyvimiumJumpLabels.sys.mjs";
import { LazyvimiumPageText } from "resource:///modules/lazyvimium/core/LazyvimiumPageText.sys.mjs";
import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";
import { hintLabels } from "resource:///modules/lazyvimium/ui/LazyvimiumHints.sys.mjs";
import { reveal } from "resource:///modules/lazyvimium/plugins/LazyvimiumVisualContent.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

// The colors of the browser's own jump labels, and a blue for paragraphs.
const LABEL_BACKGROUND = "#a25772";
const PARAGRAPH_BACKGROUND = "#3d59a1";
const LABEL_TEXT = "#eef5ff";
const MATCH_BACKGROUND = "rgba(255, 199, 119, 0.4)";
const TARGET_OUTLINE = "rgba(162, 87, 114, 0.55)";

const MAX_SEGMENTS = 3000;
const MAX_MATCHES = 500;
const NOT_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "SELECT"]);

function style(element, properties) {
  // Through the CSSOM, which a page's CSP does not block.
  Object.assign(element.style, properties);
}

function distance(rect, from) {
  return Math.hypot(
    rect.left + rect.width / 2 - from.x,
    rect.top + rect.height / 2 - from.y
  );
}

function center(window) {
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/**
 * What a jump can go to: the controls of the page, or the words in it. A
 * source answers which targets a pattern matches.
 *
 * @typedef {object} JumpTarget
 * @property {*} id Stays the same for a target as the pattern grows, which
 *   keeps its label.
 * @property {DOMRect} rect Where it is on screen.
 * @property {string[]} nexts The characters that follow the matches.
 * @property {number} distance From where the user is looking, for which targets get labels first.
 * @property {(options: {newTab: boolean}) => void} pick Goes to the target.
 */

// A frame that does not answer is left out rather than waited for.
const FRAME_TIMEOUT_MS = 1000;

// The controls this frame last offered, by the ids a press asks for.
const gPressable = new WeakMap();

function plainRect(left, top, width, height) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
  };
}

// A message to another frame of the page, through the parent, which only
// passes it to frames of this page. Null if it does not answer.
function askFrame(actor, window, bcId, name, data) {
  return Promise.race([
    actor
      .sendQuery("Lazyvimium:FrameQuery", { bcId, name, data })
      .catch(() => null),
    new Promise(resolve =>
      window.setTimeout(() => resolve(null), FRAME_TIMEOUT_MS)
    ),
  ]);
}

// What a frame sends is not to be trusted: it may be another site's.
function isControlData(item) {
  return (
    typeof item?.id == "string" &&
    typeof item.text == "string" &&
    Array.isArray(item.frame) &&
    item.frame.every(id => Number.isSafeInteger(id)) &&
    ["left", "top", "width", "height"].every(key =>
      Number.isFinite(item.rect?.[key])
    )
  );
}

// The controls in the frames on screen, placed in this window. The frames
// of those frames are asked by them.
async function collectFrames(actor, window) {
  const found = await Promise.all(
    LazyvimiumControls.frames(window).map(async frame => {
      const box = frame.getBoundingClientRect();
      const left = box.left + frame.clientLeft;
      const top = box.top + frame.clientTop;
      const items = await askFrame(
        actor,
        window,
        frame.browsingContext.id,
        "Lazyvimium:CollectControls"
      );
      return (Array.isArray(items) ? items : [])
        .filter(isControlData)
        .map(item => ({
          id: item.id,
          text: item.text.slice(0, 200),
          frame: [frame.browsingContext.id, ...item.frame],
          rect: plainRect(
            item.rect.left + left,
            item.rect.top + top,
            item.rect.width,
            item.rect.height
          ),
        }))
        .filter(({ rect }) => {
          // Only what shows inside the frame.
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          return (
            x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
          );
        });
    })
  );
  return found.flat();
}

/**
 * The controls of this frame and of the frames in it, for the jump of the
 * page they are all in.
 *
 * @param {object} actor
 * @param {Window} window
 * @returns {Promise<object[]>} Plain data: where each is in this window, its
 *   text, and the frames to go through to reach it.
 */
export async function collectControls(actor, window) {
  const pressable = new Map();
  const own = LazyvimiumControls.find(window).map((element, i) => {
    const id = `c${i}`;
    pressable.set(id, new WeakRef(element));
    const { left, top, width, height } = element.getBoundingClientRect();
    return {
      id,
      text: LazyvimiumControls.textOf(element),
      rect: { left, top, width, height },
      frame: [],
    };
  });
  gPressable.set(window, pressable);
  return [...own, ...(await collectFrames(actor, window))];
}

/**
 * Press a control this frame, or a frame in it, offered.
 *
 * @param {object} actor
 * @param {Window} window
 * @param {{frame: number[], id: string, newTab: boolean}} target
 */
export async function pressControl(actor, window, target) {
  const { frame, id, newTab } = target ?? {};
  if (
    !Array.isArray(frame) ||
    !frame.every(each => Number.isSafeInteger(each)) ||
    typeof id != "string"
  ) {
    return;
  }
  if (frame.length) {
    await askFrame(actor, window, frame[0], "Lazyvimium:PressControl", {
      frame: frame.slice(1),
      id,
      newTab: !!newTab,
    });
    return;
  }
  const element = gPressable.get(window)?.get(id)?.deref();
  if (element?.isConnected) {
    pressElement(window, element, { newTab: !!newTab });
  }
}

async function controlsSource(window, actor) {
  const from = center(window);
  const local = LazyvimiumControls.find(window).map(element => ({
    key: element,
    text: LazyvimiumControls.textOf(element),
    rect: element.getBoundingClientRect(),
    pick: options => pressElement(window, element, options),
  }));
  const remote = (await collectFrames(actor, window)).map(item => ({
    key: `${item.frame.join(".")}:${item.id}`,
    text: item.text,
    rect: item.rect,
    pick: ({ newTab }) =>
      askFrame(actor, window, item.frame[0], "Lazyvimium:PressControl", {
        frame: item.frame.slice(1),
        id: item.id,
        newTab,
      }),
  }));
  const items = [...local, ...remote];
  return {
    isText: false,
    // With nothing typed every control is a target, to be seen but not yet
    // labeled.
    matches(pattern) {
      return items.flatMap(({ key, text, rect, pick }) => {
        const found = findMatches(text, pattern);
        if (pattern && !found.length) {
          return [];
        }
        return [
          {
            id: key,
            rect,
            nexts: found.map(match => match.next),
            distance: distance(rect, from),
            pick,
          },
        ];
      });
    },
  };
}

// Where the caret is on screen, if it is.
function caretPoint(window) {
  const selection = window.getSelection();
  if (!selection.focusNode) {
    return null;
  }
  try {
    const range = window.document.createRange();
    range.setStart(selection.focusNode, selection.focusOffset);
    const rect = range.getBoundingClientRect();
    return rect.height ? { x: rect.left, y: rect.top } : null;
  } catch {
    return null;
  }
}

function textSource(window, actor) {
  const from = caretPoint(window) ?? center(window);
  const segments = [];
  const walker = window.document.createTreeWalker(
    window.document.body ?? window.document.documentElement,
    window.NodeFilter.SHOW_TEXT
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (segments.length >= MAX_SEGMENTS) {
      break;
    }
    const parent = node.parentElement;
    if (
      !node.data.trim() ||
      !parent ||
      NOT_TEXT.has(parent.tagName) ||
      !parent.checkVisibility()
    ) {
      continue;
    }
    const box = parent.getBoundingClientRect();
    if (
      box.bottom > 0 &&
      box.top < window.innerHeight &&
      box.right > 0 &&
      box.left < window.innerWidth
    ) {
      segments.push(node);
    }
  }
  return {
    isText: true,
    matches(pattern) {
      const targets = [];
      for (const node of segments) {
        for (const match of findMatches(node.data, pattern)) {
          const range = window.document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + pattern.length);
          const rect = range.getBoundingClientRect();
          if (
            rect.width &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth
          ) {
            targets.push({
              id: `${segments.indexOf(node)}:${match.index}`,
              rect,
              nexts: [match.next],
              distance: distance(rect, from),
              pick: () => moveCaret(window, actor, node, match.index),
            });
          }
          if (targets.length >= MAX_MATCHES) {
            return targets;
          }
        }
      }
      return targets;
    },
  };
}

const WORD = /[\p{L}\p{N}_]+/gu;
// The most labels at once: two letters of the alphabet make 576.
const MAX_WORD_TARGETS = 560;

function onScreen(window, rect) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

/**
 * Every word and every paragraph on screen, for choosing where visual mode
 * starts or where it goes: a word label puts the cursor there and a
 * paragraph label selects the paragraph, so `y` after it yanks it.
 *
 * @param {Window} window
 * @param {object} actor
 * @param {{land: boolean}} options Whether a word label puts the cursor
 *   there, rather than growing the selection to it.
 */
function wordsSource(window, actor, { land }) {
  const page = new LazyvimiumPageText(window);
  const from = caretPoint(window) ?? center(window);
  const rangeOf = (start, end) => {
    const first = page.pointAt(start, "start");
    const last = page.pointAt(end, "end");
    if (!first || !last) {
      return null;
    }
    const range = window.document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset);
    return range;
  };
  const targets = [];
  let lineStart = 0;
  for (const line of page.text.split("\n")) {
    const start = lineStart;
    lineStart += line.length + 1;
    if (!line.trim()) {
      continue;
    }
    const lineRange = rangeOf(start, start + line.length);
    const lineRect = lineRange?.getBoundingClientRect();
    if (!lineRect || !onScreen(window, lineRect)) {
      continue;
    }
    targets.push({
      id: `p${start}`,
      kind: "paragraph",
      rect: lineRect,
      nexts: [],
      distance: distance(lineRect, from),
      pick: () => {
        const selection = window.getSelection();
        const { startContainer, startOffset, endContainer, endOffset } =
          lineRange;
        selection.setBaseAndExtent(
          startContainer,
          startOffset,
          endContainer,
          endOffset
        );
        actor.setMode("v");
        reveal(window);
      },
    });
    for (const match of line.matchAll(WORD)) {
      const range = rangeOf(
        start + match.index,
        start + match.index + match[0].length
      );
      const rect = range?.getBoundingClientRect();
      if (rect && onScreen(window, rect)) {
        targets.push({
          id: `w${start + match.index}`,
          kind: "word",
          rect,
          nexts: [],
          distance: distance(rect, from),
          pick: () =>
            moveCaret(
              window,
              actor,
              range.startContainer,
              range.startOffset,
              !land
            ),
        });
      }
    }
  }
  return {
    isText: true,
    plain: true,
    // The paragraphs first, then the words nearest to where the user is.
    matches: () =>
      [
        ...targets.filter(target => target.kind == "paragraph"),
        ...targets
          .filter(target => target.kind == "word")
          .sort((a, b) => a.distance - b.distance),
      ].slice(0, MAX_WORD_TARGETS),
  };
}

// The cursor goes to the match: the selection grows to it in visual mode,
// and from normal mode visual mode starts there, for `viw` and its kind.
function moveCaret(window, actor, node, offset, extend = true) {
  const selection = window.getSelection();
  if (extend && actor.engine?.mode == "v" && selection.rangeCount) {
    selection.extend(node, offset);
  } else {
    selection.collapse(node, offset);
    actor.setMode("v");
  }
  reveal(window);
}

function pressElement(window, element, { newTab }) {
  if (LazyvimiumDom.isEditable(element)) {
    element.focus();
    return;
  }
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  // The mouse input a user's would be, for the handlers that listen to
  // mousedown rather than click.
  const modifiers = newTab ? Ci.nsIDOMWindowUtils.MODIFIER_CONTROL : 0;
  window.synthesizeMouseEvent("mousemove", x, y, {});
  for (const type of ["mousedown", "mouseup"]) {
    window.synthesizeMouseEvent(type, x, y, {
      button: 0,
      clickCount: 1,
      modifiers,
    });
  }
}

/**
 * Jump labels in a page. Typing characters narrows the targets to those that
 * contain them and labels what is left; typing a label (with Shift: in a new
 * tab) goes there. In `hints` mode every target is labeled at once and keys
 * only pick a label, as in the browser's own pickers.
 */
class JumpSession {
  #window;
  #makeSource;
  #source;
  #hints;
  #pattern = "";
  #typed = "";
  #shown = [];
  #labels = [];
  #previous = new Map();
  #root = null;
  #done = false;
  #redraw = 0;
  #generation = 0;

  constructor(window, makeSource, source, { hints = false } = {}) {
    this.#window = window;
    this.#makeSource = makeSource;
    this.#source = source;
    this.#hints = hints;
    window.addEventListener("pagehide", this);
    window.addEventListener("resize", this);
    // Labels follow the page as it scrolls.
    window.addEventListener("scroll", this, true);
    this.#update();
    if (this.#hints && !this.#shown.length) {
      this.finish();
    }
  }

  get done() {
    return this.#done;
  }

  handleEvent(event) {
    if (event.type == "pagehide") {
      this.finish();
    } else {
      this.#queueUpdate();
    }
  }

  handleKey(event) {
    const token = LazyvimiumKeys.fromEvent(event);
    if (!token) {
      return;
    }
    if (token == "<Esc>") {
      this.finish();
    } else if (token == "<CR>") {
      this.#pickAt(0, { newTab: false });
    } else if (token == "<BS>") {
      this.#backspace();
    } else if (token == "<Space>" && !this.#hints) {
      this.#type(" ");
    } else if (token.length == 1) {
      this.#type(token);
    }
  }

  finish() {
    if (this.#done) {
      return;
    }
    this.#done = true;
    try {
      this.#window.removeEventListener("pagehide", this);
      this.#window.removeEventListener("resize", this);
      this.#window.removeEventListener("scroll", this, true);
      this.#window.cancelAnimationFrame(this.#redraw);
      this.#root?.remove();
    } catch {
      // The window is already gone.
    }
    this.#root = null;
  }

  #backspace() {
    if (this.#hints ? this.#typed : this.#pattern) {
      if (this.#hints) {
        this.#typed = this.#typed.slice(0, -1);
      } else {
        this.#pattern = this.#pattern.slice(0, -1);
      }
      this.#update();
    } else {
      this.finish();
    }
  }

  #type(char) {
    if (this.#hints) {
      this.#typeHint(char);
      return;
    }
    // A label wins over a pattern character: labels are never the character
    // after a match, so one key cannot be both.
    const lower = char.toLowerCase();
    const index = this.#labels.indexOf(lower);
    if (index != -1 && this.#pattern) {
      this.#pickAt(index, { newTab: char != lower });
      return;
    }
    const target = this.#pattern + char;
    if (this.#source.matches(target).length) {
      this.#pattern = target;
      this.#update();
    }
  }

  #typeHint(char) {
    const typed = this.#typed + char.toLowerCase();
    const index = this.#labels.indexOf(typed);
    if (index != -1) {
      this.#pickAt(index, { newTab: char != char.toLowerCase() });
    } else if (this.#labels.some(label => label?.startsWith(typed))) {
      this.#typed = typed;
      this.#update();
    }
  }

  #pickAt(index, options) {
    const target = this.#shown[index];
    this.finish();
    target?.pick(options);
  }

  #queueUpdate() {
    this.#window.cancelAnimationFrame(this.#redraw);
    this.#redraw = this.#window.requestAnimationFrame(async () => {
      const latest = ++this.#generation;
      const source = await this.#makeSource();
      // Not if the page moved again meanwhile, or the jump is over.
      if (!this.#done && latest == this.#generation) {
        this.#source = source;
        this.#update();
      }
    });
  }

  #update() {
    const targets = this.#source
      .matches(this.#pattern)
      .sort((a, b) => a.distance - b.distance);
    if (this.#hints) {
      this.#shown = targets.sort(
        (a, b) =>
          Math.round(a.rect.top / 8) - Math.round(b.rect.top / 8) ||
          a.rect.left - b.rect.left
      );
      this.#labels = hintLabels(this.#shown.length);
    } else {
      this.#shown = targets;
      // Labels wait for the first character: until then every key would be
      // a label.
      this.#labels = this.#pattern
        ? assignLabels(targets.length, {
            skip: targets.flatMap(target => target.nexts),
            previous: targets.map(target => this.#previous.get(target.id)),
          })
        : targets.map(() => null);
      this.#previous = new Map(
        targets.map((target, i) => [target.id, this.#labels[i]])
      );
    }
    this.#draw();
  }

  #draw() {
    const window = this.#window;
    const document = window.document;
    this.#root?.remove();
    const root = document.createElementNS(HTML_NS, "div");
    root.style.cssText =
      "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    this.#shown.forEach((target, i) => {
      const label = this.#labels[i];
      if (this.#hints && !label?.startsWith(this.#typed)) {
        return;
      }
      const { rect } = target;
      // A word is marked by its label alone; a paragraph by a bar along it.
      if (target.kind != "word") {
        const box = document.createElementNS(HTML_NS, "div");
        style(box, {
          position: "absolute",
          left: `${rect.left}px`,
          top: `${rect.top}px`,
          height: `${rect.height}px`,
          boxSizing: "border-box",
        });
        if (target.kind == "paragraph") {
          style(box, {
            width: "3px",
            marginLeft: "-6px",
            borderRadius: "2px",
            background: PARAGRAPH_BACKGROUND,
          });
        } else if (this.#source.isText) {
          style(box, {
            width: `${rect.width}px`,
            borderRadius: "3px",
            background: MATCH_BACKGROUND,
          });
        } else {
          style(box, {
            width: `${rect.width}px`,
            borderRadius: "3px",
            outline: `1px solid ${TARGET_OUTLINE}`,
          });
        }
        root.append(box);
      }
      if (label) {
        root.append(this.#tag(label, target));
      }
    });
    if (!this.#hints) {
      root.append(this.#prompt());
    }
    this.#root = root;
    document.documentElement.append(root);
  }

  // A word's label sits on its first letters, a paragraph's in the margin
  // beside it in its own color, and a typed match's after it.
  #tag(label, { rect, kind }) {
    const window = this.#window;
    const tag = window.document.createElementNS(HTML_NS, "span");
    tag.textContent = label;
    const small = kind == "word" || kind == "paragraph";
    const width = label.length * (small ? 6.5 : 7) + 8;
    let left = rect.left + 2;
    let top = rect.top + 2;
    if (kind == "paragraph") {
      left = rect.left - width - 8;
      top = rect.top;
    } else if (kind == "word") {
      top = rect.top + Math.max(0, (rect.height - 14) / 2);
      left = rect.left;
    } else if (this.#source.isText) {
      left = rect.right;
      top = rect.top;
    }
    style(tag, {
      position: "absolute",
      left: `${Math.max(0, Math.min(left, window.innerWidth - width))}px`,
      top: `${Math.max(0, Math.min(top, window.innerHeight - 18))}px`,
      padding: small ? "0 3px" : "0 4px",
      borderRadius: "4px",
      background: kind == "paragraph" ? PARAGRAPH_BACKGROUND : LABEL_BACKGROUND,
      color: LABEL_TEXT,
      font: small
        ? "700 10px/14px ui-monospace, monospace"
        : "700 11px/16px ui-monospace, monospace",
      boxShadow: "0 1px 3px rgba(0, 0, 0, 0.4)",
    });
    return tag;
  }

  #prompt() {
    const tag = this.#window.document.createElementNS(HTML_NS, "span");
    tag.textContent = `› ${this.#pattern}`;
    style(tag, {
      position: "absolute",
      left: "50%",
      bottom: "16px",
      transform: "translateX(-50%)",
      padding: "2px 10px",
      borderRadius: "6px",
      background: LABEL_BACKGROUND,
      color: LABEL_TEXT,
      font: "700 13px/20px ui-monospace, monospace",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.4)",
    });
    return tag;
  }
}

async function begin(actor, window, makeSource, options) {
  const source = await makeSource();
  actor.startCapture(new JumpSession(window, makeSource, source, options));
}

// Labels for the controls of the whole page, frames included. They are
// drawn by its top window, so a key typed in a frame starts them there, and
// focus leaves the frame, so the keys that pick a label reach the top.
const labelControls = (id, options) => async context => {
  const { actor, window } = context;
  if (window.browsingContext.parent) {
    await actor.sendQuery("Lazyvimium:FrameQuery", {
      bcId: window.browsingContext.top.id,
      name: "Lazyvimium:RunContent",
      data: { id, args: {} },
    });
    return;
  }
  const focused = window.document.activeElement;
  if (focused?.browsingContext) {
    focused.blur();
    window.focus();
  }
  await begin(actor, window, () => controlsSource(window, actor), options);
};

const labelWords =
  land =>
  ({ actor, window }) =>
    begin(actor, window, () => wordsSource(window, actor, { land }), {
      hints: true,
    });

export const actions = {
  // Type some of a control's text, then its label.
  "jump.controls": labelControls("jump.controls"),

  // Every control labeled at once.
  "jump.hints": labelControls("jump.hints", { hints: true }),

  "jump.text": ({ actor, window }) =>
    begin(actor, window, () => textSource(window, actor)),

  // Every word and paragraph at once; the choice grows the selection.
  "jump.words": labelWords(false),

  // The same, for where visual mode starts: the choice puts the cursor.
  "jump.land": labelWords(true),
};
