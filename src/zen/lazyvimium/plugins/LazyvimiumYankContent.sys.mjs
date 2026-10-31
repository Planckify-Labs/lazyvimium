// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PUT_FLASH_MS = 300;
const PUT_COLOR = "rgba(255, 199, 119, 0.45)";

function isTextField(element) {
  return element?.localName == "input" || element?.localName == "textarea";
}

// A brief highlight over the field a put went into.
function highlight(window, element) {
  const rect = element.getBoundingClientRect();
  const box = window.document.createElementNS(HTML_NS, "div");
  box.style.cssText =
    `all: initial; position: fixed; z-index: 2147483647; pointer-events: none; ` +
    `left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; ` +
    `height: ${rect.height}px; background: ${PUT_COLOR}; border-radius: 3px;`;
  window.document.documentElement.append(box);
  window.setTimeout(() => box.remove(), PUT_FLASH_MS);
}

/**
 * Put a text where the caret is, or over the last put when cycling. The
 * editor's own insert keeps undo and fires input events, so pages see it as
 * typing.
 *
 * @param {{actor: object, document: Document, window: Window}} context
 * @param {string} text
 * @param {number} index Where the text is in the ring.
 * @param {{end: number, length: number}|null} replace The put to replace.
 * @returns {boolean} Whether there was a field to put in.
 */
function put({ actor, document, window }, text, index, replace) {
  const field = LazyvimiumDom.deepActiveElement(document);
  if (!LazyvimiumDom.isEditable(field) || field.localName == "select") {
    return false;
  }
  if (replace && isTextField(field)) {
    field.setSelectionRange(replace.end - replace.length, replace.end);
  }
  document.execCommand("insertText", false, text);
  actor.lastPut = isTextField(field)
    ? {
        field: new WeakRef(field),
        end: field.selectionEnd,
        length: text.length,
        index,
      }
    : null;
  highlight(window, field);
  return true;
}

// The put the caret still sits at the end of, if there is one.
function cyclingPut({ actor, document }) {
  const last = actor.lastPut;
  const field = LazyvimiumDom.deepActiveElement(document);
  return last?.field.deref() === field &&
    field.selectionStart == last.end &&
    field.selectionEnd == last.end
    ? last
    : null;
}

async function cycle(context, step) {
  const last = cyclingPut(context);
  // Not after a put: start from the newest yank.
  const index = last ? Math.max(last.index + step, 0) : 0;
  const text = await context.actor.sendQuery("Lazyvimium:YankAt", { index });
  if (text !== null) {
    put(context, text, index, last);
  }
}

export const actions = {
  "yank.put": (context, { text, index = 0 }) => put(context, text, index, null),
  // Older yanks are further from the front of the ring.
  "yank.putPrev": context => cycle(context, 1),
  "yank.putNext": context => cycle(context, -1),
};
