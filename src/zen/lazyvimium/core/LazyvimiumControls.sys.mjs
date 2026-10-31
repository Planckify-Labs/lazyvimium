// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";

// What a user can press, type in or toggle, by its markup.
const CONTROLS = [
  // The controls of the browser's own pages, like its settings.
  "checkbox",
  "radio",
  "menulist",
  "richlistitem",
  "tab",
  "toolbarbutton",
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=switch]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=radio]",
  "[role=option]",
  "[role=combobox]",
  "[role=textbox]",
  "[role=slider]",
  "[contenteditable]:not([contenteditable=false])",
  "[tabindex]:not([tabindex='-1'])",
  "[onclick]",
].join(",");

const MAX_ELEMENTS = 5000;
const MIN_SIZE = 4;

/**
 * Whether the element is on screen and nothing covers it.
 *
 * @param {Window} window
 * @param {Element} element
 * @returns {boolean}
 */
function isShown(window, element) {
  const rect = element.getBoundingClientRect();
  if (
    !element.checkVisibility() ||
    rect.width < MIN_SIZE ||
    rect.height < MIN_SIZE ||
    rect.bottom <= 0 ||
    rect.right <= 0 ||
    rect.top >= window.innerHeight ||
    rect.left >= window.innerWidth
  ) {
    return false;
  }
  const hit = LazyvimiumDom.deepElementFromPoint(
    window.document,
    Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1),
    Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
  );
  return (
    !!hit &&
    (LazyvimiumDom.composedContains(element, hit) ||
      LazyvimiumDom.composedContains(hit, element) ||
      hit.closest("label")?.control === element)
  );
}

export const LazyvimiumControls = {
  /**
   * The controls on screen, in document order.
   *
   * @param {Window} window
   * @returns {Element[]}
   */
  find(window) {
    const found = [];
    let seen = 0;
    const root = window.document.body ?? window.document.documentElement;
    for (const element of LazyvimiumDom.deepElements(root)) {
      if (++seen > MAX_ELEMENTS) {
        break;
      }
      const isControl = element.matches(CONTROLS);
      // A div with a click handler has no markup to say so, only a hand for
      // a cursor; its children share it.
      const parent = LazyvimiumDom.composedParent(element);
      const hasHand =
        !isControl &&
        window.getComputedStyle(element).cursor == "pointer" &&
        !found.some(other => LazyvimiumDom.composedContains(other, element)) &&
        parent &&
        window.getComputedStyle(parent).cursor != "pointer";
      if (
        (isControl || hasHand) &&
        !element.disabled &&
        isShown(window, element)
      ) {
        found.push(element);
      }
    }
    return found;
  },

  /**
   * The frames on screen: what is in them is for their own page to find.
   *
   * @param {Window} window
   * @returns {Element[]}
   */
  frames(window) {
    const frames = [...LazyvimiumDom.deepElements(window.document)].filter(
      element => element.matches("iframe, frame")
    );
    return frames.filter(frame => {
      const rect = frame.getBoundingClientRect();
      return (
        frame.browsingContext &&
        frame.checkVisibility() &&
        rect.width >= MIN_SIZE &&
        rect.height >= MIN_SIZE &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth
      );
    });
  },

  /**
   * Top to bottom, then left to right.
   *
   * @param {Element[]} elements
   * @returns {Element[]}
   */
  inReadingOrder(elements) {
    const line = element => Math.round(element.getBoundingClientRect().top / 8);
    return [...elements].sort(
      (a, b) =>
        line(a) - line(b) ||
        a.getBoundingClientRect().left - b.getBoundingClientRect().left
    );
  },

  /**
   * What a control says to the user, for matching a pattern against.
   *
   * @param {Element} element
   * @returns {string}
   */
  textOf(element) {
    const text =
      element.getAttribute("aria-label") ||
      element.innerText ||
      element.value ||
      element.getAttribute("title") ||
      element.getAttribute("alt") ||
      element.getAttribute("placeholder") ||
      element.querySelector("img[alt]")?.getAttribute("alt") ||
      "";
    return String(text).replace(/\s+/g, " ").trim().slice(0, 200);
  },
};
