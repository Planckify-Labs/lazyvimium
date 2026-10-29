// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";
import { LABELS } from "resource:///modules/lazyvimium/ui/LazyvimiumPicker.sys.mjs";

function hintLabels(count) {
  if (count <= LABELS.length) {
    return [...LABELS].slice(0, count);
  }
  const labels = [];
  for (const first of LABELS) {
    for (const second of LABELS) {
      labels.push(first + second);
    }
  }
  return labels.slice(0, count);
}

/**
 * @param {Element} element
 * @returns {boolean} Whether a label on it would be seen.
 */
export function isOnScreen(element) {
  const rect = element.getBoundingClientRect();
  return (
    element.checkVisibility() &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.bottom > 0 &&
    rect.top < element.documentGlobal.innerHeight
  );
}

/**
 * Jump labels on browser UI elements, flash.nvim style: each element gets a
 * label (shown by lazyvimium.css from the lazyvimium-hint attribute), and
 * typing one picks its element. Any other key cancels.
 */
export class LazyvimiumHints {
  #hosts;
  #labels;
  #typed = "";
  #result = Promise.withResolvers();
  #done = false;

  /**
   * @param {Element[]} hosts The elements to label.
   */
  constructor(hosts) {
    this.#hosts = hosts;
    this.#labels = hintLabels(hosts.length);
    hosts.forEach((host, index) =>
      host.setAttribute("lazyvimium-hint", this.#labels[index])
    );
    if (!hosts.length) {
      this.finish(null);
    }
  }

  /** @returns {Promise<number|null>} The picked index, or null. */
  get picked() {
    return this.#result.promise;
  }

  /** @returns {boolean} Whether a label was picked or the hints dropped. */
  get done() {
    return this.#done;
  }

  /**
   * @param {KeyboardEvent} event
   */
  handleKey(event) {
    event.preventDefault();
    event.stopPropagation();
    const token = LazyvimiumKeys.fromEvent(event);
    if (!token) {
      return;
    }
    if (token.length != 1) {
      this.finish(null);
      return;
    }
    this.#typed += token;
    const index = this.#labels.indexOf(this.#typed);
    if (index != -1) {
      this.finish(index);
      return;
    }
    let any = false;
    this.#hosts.forEach((host, i) => {
      if (this.#labels[i].startsWith(this.#typed)) {
        any = true;
      } else {
        host.removeAttribute("lazyvimium-hint");
      }
    });
    if (!any) {
      this.finish(null);
    }
  }

  /**
   * @param {number|null} index
   */
  finish(index) {
    this.#done = true;
    for (const host of this.#hosts) {
      host.removeAttribute("lazyvimium-hint");
    }
    this.#result.resolve(index);
  }
}
