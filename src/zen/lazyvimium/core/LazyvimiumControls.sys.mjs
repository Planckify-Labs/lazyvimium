// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// What a user can press, type in or toggle, by its markup.
const CONTROLS = [
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
  const hit = window.document.elementFromPoint(
    Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1),
    Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1)
  );
  return (
    !!hit &&
    (element.contains(hit) ||
      hit.contains(element) ||
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
    const semantic = new Set(window.document.querySelectorAll(CONTROLS));
    let seen = 0;
    for (const element of window.document.querySelectorAll("body *")) {
      if (++seen > MAX_ELEMENTS) {
        break;
      }
      const isControl = semantic.has(element);
      // A div with a click handler has no markup to say so, only a hand for
      // a cursor; its children share it.
      const hasHand =
        !isControl &&
        window.getComputedStyle(element).cursor == "pointer" &&
        !found.some(other => other.contains(element)) &&
        element.parentElement &&
        window.getComputedStyle(element.parentElement).cursor != "pointer";
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
    return [...window.document.querySelectorAll("iframe, frame")].filter(
      frame => {
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
      }
    );
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
