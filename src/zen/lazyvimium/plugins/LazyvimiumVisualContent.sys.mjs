// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Visual mode on a page's text, after vim's: `v` starts a selection where the
// cursor is, motions and text objects (`vi{`, `vap`, `va/`) grow it, and `y`
// yanks it. A page has no cursor of its own, so a bar is drawn at the end of
// the selection that moves.

import {
  chooseRange,
  findTextObject,
  paragraphEdge,
} from "resource:///modules/lazyvimium/core/LazyvimiumTextObjects.sys.mjs";
import { LazyvimiumPageText } from "resource:///modules/lazyvimium/core/LazyvimiumPageText.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

// The cursor has the pink of NORMAL, which the window wears.
const CURSOR_COLOR = "#fca7ea";
const YANK_HIGHLIGHT_MS = 300;
const YANK_COLOR = "rgba(255, 199, 119, 0.55)";

const NOT_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "SELECT"]);

/** @type {WeakMap<Window, {bar: Element, scroll: Function}>} */
const gCursors = new WeakMap();

function selectionController(window) {
  return window.docShell
    .QueryInterface(Ci.nsIInterfaceRequestor)
    .getInterface(Ci.nsISelectionDisplay)
    .QueryInterface(Ci.nsISelectionController);
}

function overlay(window, cssText) {
  const element = window.document.createElementNS(HTML_NS, "div");
  element.style.cssText = `all: initial; position: fixed; z-index: 2147483647; pointer-events: none; ${cssText}`;
  return element;
}

function focusRect(window) {
  const selection = window.getSelection();
  if (!selection.focusNode) {
    return null;
  }
  try {
    const range = window.document.createRange();
    range.setStart(selection.focusNode, selection.focusOffset);
    range.collapse(true);
    const rect =
      range.getClientRects()[0] ??
      (selection.focusNode.nodeType == 1
        ? selection.focusNode.getBoundingClientRect()
        : null);
    return rect?.height ? rect : null;
  } catch {
    return null;
  }
}

/**
 * Draw the cursor where the selection's focus is.
 *
 * @param {Window} window
 */
export function showCaret(window) {
  let cursor = gCursors.get(window);
  if (!cursor) {
    cursor = {
      bar: overlay(window, `width: 2px; background: ${CURSOR_COLOR};`),
      scroll: () => showCaret(window),
    };
    window.document.documentElement.append(cursor.bar);
    window.addEventListener("scroll", cursor.scroll, true);
    window.addEventListener("resize", cursor.scroll);
    gCursors.set(window, cursor);
  }
  const rect = focusRect(window);
  cursor.bar.style.display = rect ? "block" : "none";
  if (rect) {
    Object.assign(cursor.bar.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      height: `${rect.height}px`,
    });
  }
}

/**
 * @param {Window} window
 */
export function hideCaret(window) {
  const cursor = gCursors.get(window);
  if (!cursor) {
    return;
  }
  gCursors.delete(window);
  try {
    window.removeEventListener("scroll", cursor.scroll, true);
    window.removeEventListener("resize", cursor.scroll);
    cursor.bar.remove();
  } catch {
    // The window is already gone.
  }
}

/**
 * Scroll the focus of the selection into view and draw the cursor there.
 *
 * @param {Window} window
 */
export function reveal(window) {
  const { SELECTION_NORMAL, SELECTION_FOCUS_REGION, SCROLL_SYNCHRONOUS } =
    Ci.nsISelectionController;
  try {
    selectionController(window).scrollSelectionIntoView(
      SELECTION_NORMAL,
      SELECTION_FOCUS_REGION,
      SCROLL_SYNCHRONOUS
    );
  } catch {
    // No presentation to scroll yet.
  }
  showCaret(window);
}

/**
 * The first text node on screen, where the cursor starts when nothing tells
 * otherwise.
 *
 * @param {Window} window
 * @returns {{node: Node, offset: number}|null}
 */
function firstVisibleText(window) {
  const walker = window.document.createTreeWalker(
    window.document.body ?? window.document.documentElement,
    window.NodeFilter.SHOW_TEXT
  );
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      !node.data.trim() ||
      !parent ||
      NOT_TEXT.has(parent.tagName) ||
      !parent.checkVisibility()
    ) {
      continue;
    }
    const range = window.document.createRange();
    const offset = node.data.search(/\S/);
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width && rect.bottom > 0 && rect.top < window.innerHeight) {
      return { node, offset };
    }
  }
  return null;
}

// Whether the selection's focus is on screen: a cursor left from long ago is
// not where the user is looking.
function focusOnScreen(window) {
  const rect = focusRect(window);
  return (
    !!rect &&
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function modify(window, direction, granularity, count = 1) {
  const selection = window.getSelection();
  for (let i = 0; i < count; i++) {
    selection.modify("extend", direction, granularity);
  }
  reveal(window);
}

// A motion grows the selection from its start to the new place.
function motion(direction, granularity) {
  return ({ window }, { count = 1 } = {}) =>
    modify(window, direction, granularity, count);
}

// A motion over the page's text, for the places the selection cannot reach
// by itself: the top and bottom of the page and its paragraphs. `find` says
// where the end that moves goes from where it is. A motion that goes to an
// end of the page also scrolls there, as `gg` and `G` do outside visual mode,
// rather than only far enough to show the cursor.
function textMotion(find, { scrollAction = null } = {}) {
  return ({ actor, window }, { count = 1 } = {}) => {
    const selection = window.getSelection();
    if (!selection.focusNode) {
      return;
    }
    const page = new LazyvimiumPageText(window);
    let place = {
      offset: page.offsetOf(selection.focusNode, selection.focusOffset),
    };
    for (let i = 0; i < count; i++) {
      place = find(page.text, place.offset);
    }
    const point = page.pointAt(place.offset, place.side);
    if (point) {
      selection.extend(point.node, point.offset);
      if (scrollAction) {
        showCaret(window);
        actor.runAction(scrollAction, {});
      } else {
        reveal(window);
      }
    }
  };
}

function highlightRanges(window, ranges) {
  const root = overlay(window, "inset: 0;");
  for (const range of ranges) {
    for (const rect of range.getClientRects()) {
      root.append(
        overlay(
          window,
          `left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; ` +
            `height: ${rect.height}px; background: ${YANK_COLOR}; border-radius: 2px;`
        )
      );
    }
  }
  window.document.documentElement.append(root);
  window.setTimeout(() => root.remove(), YANK_HIGHLIGHT_MS);
}

// The selection as offsets in the page's text.
function selectedRange(page, selection) {
  const anchor = page.offsetOf(selection.anchorNode, selection.anchorOffset);
  const focus = page.offsetOf(selection.focusNode, selection.focusOffset);
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

// The elements around the selection, as text objects: `t`, which has no
// tags to leave out, so `at` and `it` are the same.
function elementRanges(page, selection) {
  let element = selection.focusNode;
  if (element?.nodeType != 1) {
    element = element?.parentElement;
  }
  const ranges = [];
  for (; element; element = element.parentElement) {
    const range = page.elementRange(element);
    const last = ranges[ranges.length - 1];
    if (
      range &&
      (!last || last.start != range.start || last.end != range.end)
    ) {
      ranges.push(range);
    }
  }
  return ranges;
}

function selectText(window, page, range) {
  const start = page.pointAt(range.start, "start");
  const end = page.pointAt(range.end, "end");
  if (start && end) {
    window
      .getSelection()
      .setBaseAndExtent(start.node, start.offset, end.node, end.offset);
    reveal(window);
  }
}

export const actions = {
  "visual.enter": ({ actor, window }) => {
    const selection = window.getSelection();
    if (!selection.rangeCount || !focusOnScreen(window)) {
      const start = firstVisibleText(window);
      if (!start) {
        return;
      }
      selection.collapse(start.node, start.offset);
    }
    actor.setMode("v");
    showCaret(window);
    // Every word and paragraph gets a label, to say where to start. <Esc>
    // keeps the cursor where it is; a selection made before is kept.
    if (selection.isCollapsed) {
      actor.runAction("jump.land", {});
    }
  },

  // The cursor stays where the selection ended.
  "visual.exit": ({ actor, window }) => {
    const selection = window.getSelection();
    if (selection.focusNode) {
      selection.collapse(selection.focusNode, selection.focusOffset);
    }
    actor.setMode("n");
  },

  // The other end of the selection.
  "visual.swapEnds": ({ window }) => {
    const { anchorNode, anchorOffset, focusNode, focusOffset } =
      window.getSelection();
    window
      .getSelection()
      .setBaseAndExtent(focusNode, focusOffset, anchorNode, anchorOffset);
    reveal(window);
  },

  "visual.left": motion("left", "character"),
  "visual.right": motion("right", "character"),
  "visual.down": motion("forward", "line"),
  "visual.up": motion("backward", "line"),
  "visual.wordForward": motion("forward", "word"),
  "visual.wordBackward": motion("backward", "word"),
  "visual.lineStart": motion("backward", "lineboundary"),
  "visual.lineEnd": motion("forward", "lineboundary"),
  "visual.paragraphForward": textMotion((text, offset) =>
    paragraphEdge(text, offset, true)
  ),
  "visual.paragraphBackward": textMotion((text, offset) =>
    paragraphEdge(text, offset, false)
  ),
  // From the cursor's start to the first or last text of the page.
  "visual.top": textMotion(() => ({ offset: 0, side: "start" }), {
    scrollAction: "scroll.top",
  }),
  "visual.bottom": textMotion(text => ({ offset: text.length, side: "end" }), {
    scrollAction: "scroll.bottom",
  }),

  // `a` or `i` and an object: the keys that ran this say which. Again on
  // its own result, it grows.
  "visual.object": ({ window }, { lhs = "", count = 1 }) => {
    const selection = window.getSelection();
    if (!selection.rangeCount) {
      return;
    }
    const kind = lhs[0];
    const key = lhs.slice(1) == "<lt>" ? "<" : lhs.slice(1);
    const page = new LazyvimiumPageText(window);
    let current = selectedRange(page, selection);
    let range;
    if (key == "t") {
      range = elementRanges(page, selection);
      for (let i = 0; i < count && range; i++) {
        const grown = chooseRange(range, current);
        range = grown && (current = grown);
      }
    } else {
      range = findTextObject(page.text, kind, key, current, { times: count });
    }
    if (range) {
      selectText(window, page, range);
    }
  },

  // Into the clipboard, and so the yank ring, which sees every copy. The
  // cursor goes to where the yank began.
  "visual.yank": ({ actor, window }) => {
    const selection = window.getSelection();
    if (selection.rangeCount && !selection.isCollapsed) {
      const ranges = [...Array(selection.rangeCount).keys()].map(i =>
        selection.getRangeAt(i).cloneRange()
      );
      window.docShell.doCommand("cmd_copy");
      highlightRanges(window, ranges);
      selection.collapse(ranges[0].startContainer, ranges[0].startOffset);
    }
    actor.setMode("n");
  },
};
