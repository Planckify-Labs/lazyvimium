// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const NOT_TEXT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA", "SELECT"]);
const MAX_LENGTH = 2_000_000;

/**
 * The text a page shows as one string, with a line per block of text, and
 * the way back from a position in it to the page's nodes. Text objects run on
 * the string; the selection is made from the nodes.
 */
export class LazyvimiumPageText {
  #window;
  #nodes = [];
  #bases = [];
  #index = new Map();
  #text = "";

  /**
   * @param {Window} window
   */
  constructor(window) {
    this.#window = window;
    // The block a text belongs to: the nearest element that is not inline.
    const blocks = new Map();
    const blockOf = element => {
      if (!blocks.has(element)) {
        const display = window.getComputedStyle(element).display;
        const inline = display.startsWith("inline") || display == "contents";
        blocks.set(
          element,
          inline && element.parentElement
            ? blockOf(element.parentElement)
            : element
        );
      }
      return blocks.get(element);
    };
    const visible = new Map();
    const walker = window.document.createTreeWalker(
      window.document.body ?? window.document.documentElement,
      window.NodeFilter.SHOW_TEXT
    );
    let previousBlock = null;
    const parts = [];
    let length = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.data || !parent || NOT_TEXT.has(parent.tagName)) {
        continue;
      }
      if (!visible.has(parent)) {
        visible.set(parent, parent.checkVisibility());
      }
      if (!visible.get(parent) || !node.data.trim()) {
        continue;
      }
      const block = blockOf(parent);
      if (previousBlock && block !== previousBlock) {
        parts.push("\n");
        length++;
      }
      previousBlock = block;
      this.#index.set(node, this.#nodes.length);
      this.#nodes.push(node);
      this.#bases.push(length);
      // Source whitespace shows as a space; the length stays, so offsets
      // stay the nodes' own.
      parts.push(node.data.replace(/[\n\r\t]/g, " "));
      length += node.data.length;
      if (length > MAX_LENGTH) {
        break;
      }
    }
    this.#text = parts.join("");
  }

  /** @returns {string} */
  get text() {
    return this.#text;
  }

  /**
   * @param {Node} node
   * @param {number} offset
   * @returns {number} The position in the text of a point in the page; of
   *   the text after it when the point is not in a text of the page.
   */
  offsetOf(node, offset) {
    const index = this.#index.get(node);
    if (index !== undefined) {
      return this.#bases[index] + Math.min(offset, node.data.length);
    }
    const point = this.#window.document.createRange();
    point.setStart(node, offset);
    point.collapse(true);
    const next = this.#firstIndex(text => point.comparePoint(text, 0) >= 0);
    return next == this.#nodes.length ? this.#text.length : this.#bases[next];
  }

  /**
   * The point of the page at a position in the text.
   *
   * @param {number} offset
   * @param {"start"|"end"} side A position between two blocks belongs to the
   *   block after it for the start of a range, and the one before it for
   *   its end.
   * @returns {{node: Node, offset: number}|null}
   */
  pointAt(offset, side) {
    if (!this.#nodes.length) {
      return null;
    }
    // The last node that starts at or before the offset.
    let index = this.#firstIndex((_, i) => this.#bases[i] > offset) - 1;
    index = Math.max(index, 0);
    const node = this.#nodes[index];
    const inside = offset - this.#bases[index];
    if (inside <= node.data.length) {
      if (
        side == "start" &&
        inside == node.data.length &&
        this.#nodes[index + 1]
      ) {
        return { node: this.#nodes[index + 1], offset: 0 };
      }
      return { node, offset: Math.max(inside, 0) };
    }
    // In the line break after the node.
    return side == "start" && this.#nodes[index + 1]
      ? { node: this.#nodes[index + 1], offset: 0 }
      : { node, offset: node.data.length };
  }

  /**
   * @param {Element} element
   * @returns {{start: number, end: number}|null} Where the element's text is.
   */
  elementRange(element) {
    const inside = this.#window.document.createRange();
    inside.selectNodeContents(element);
    const first = this.#firstIndex(text => inside.comparePoint(text, 0) >= 0);
    const after = this.#firstIndex(text => inside.comparePoint(text, 0) > 0);
    if (first >= after) {
      return null;
    }
    const last = this.#nodes[after - 1];
    return {
      start: this.#bases[first],
      end: this.#bases[after - 1] + last.data.length,
    };
  }

  // The first node for which a test holds, given that it holds for every
  // node after it too.
  #firstIndex(test) {
    let low = 0;
    let high = this.#nodes.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (test(this.#nodes[middle], middle)) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }
    return low;
  }
}
