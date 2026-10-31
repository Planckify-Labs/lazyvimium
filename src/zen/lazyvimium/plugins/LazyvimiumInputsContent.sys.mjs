// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";

const FIELDS =
  "input, textarea, select, [contenteditable='true'], [contenteditable='']";

// Fields whose tops are this close sit on the same row.
const ROW_TOLERANCE = 4;

function isShown(element) {
  if (
    !element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
  ) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * The page's editable fields in reading order.
 *
 * @param {Document} document
 * @returns {Element[]}
 */
function fields(document) {
  return [...LazyvimiumDom.deepElements(document)]
    .filter(
      element =>
        element.matches(FIELDS) &&
        LazyvimiumDom.isEditable(element) &&
        isShown(element)
    )
    .map(element => ({ element, rect: element.getBoundingClientRect() }))
    .sort((a, b) =>
      Math.abs(a.rect.top - b.rect.top) > ROW_TOLERANCE
        ? a.rect.top - b.rect.top
        : a.rect.left - b.rect.left
    )
    .map(({ element }) => element);
}

function inViewport(element, window) {
  const rect = element.getBoundingClientRect();
  return (
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

function focusField(element) {
  element.focus();
  try {
    // Continue typing after what is there, as `A` would in vim.
    const end = element.value?.length;
    if (end !== undefined) {
      element.setSelectionRange(end, end);
    }
  } catch {
    // Some input types (email, number) have no selection.
  }
}

function step({ document, window }, offset) {
  const list = fields(document);
  if (!list.length) {
    return;
  }
  const current = list.indexOf(LazyvimiumDom.deepActiveElement(document));
  let index;
  if (current == -1) {
    // Nothing focused: start from what is on screen.
    const onScreen = list.findIndex(element => inViewport(element, window));
    const start = onScreen == -1 ? 0 : onScreen;
    index = offset > 0 ? start + offset - 1 : start + offset;
  } else {
    index = current + offset;
  }
  focusField(list[((index % list.length) + list.length) % list.length]);
}

export const actions = {
  "input.first": function ({ actor, document, window }, { count = 1 }) {
    const visible = fields(document).filter(element =>
      inViewport(element, window)
    );
    if (!visible.length) {
      // No field to type in: pass keys to the page, like `I`.
      actor.setMode("i", { explicit: true });
      return;
    }
    focusField(visible[Math.min(count, visible.length) - 1]);
  },

  "input.last": function ({ actor, document }, { count = 1 }) {
    const last = actor.lastInput;
    if (last && LazyvimiumDom.isEditable(last) && isShown(last)) {
      focusField(last);
      return;
    }
    const list = fields(document);
    if (list.length) {
      focusField(list[Math.min(count, list.length) - 1]);
    }
  },

  "input.next": (context, { count = 1 }) => step(context, count),
  "input.prev": (context, { count = 1 }) => step(context, -count),
};
