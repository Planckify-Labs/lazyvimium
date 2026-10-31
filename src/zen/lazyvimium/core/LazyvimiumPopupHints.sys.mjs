// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumControls } from "resource:///modules/lazyvimium/core/LazyvimiumControls.sys.mjs";
import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";
import { hintLabels } from "resource:///modules/lazyvimium/ui/LazyvimiumHints.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

// The popup keeps changing for a while after it loads.
const SETTLE_MS = [100, 300, 800];

/**
 * Jump labels over every control of an extension's popup, flash.nvim style,
 * the way the sidebar's rows get them: typing a label presses its control,
 * and any other key goes to the popup. They follow the popup as it changes,
 * and stay out of the way while a field has focus.
 */
export class LazyvimiumPopupHints {
  #window;
  #colors;
  #root = null;
  #targets = [];
  #labels = [];
  #typed = "";
  #suspended = false;
  #scan = 0;
  #observer;
  #timers = new Set();

  /**
   * @param {Window} window The popup's window.
   * @param {{background: string, color: string}} colors
   */
  constructor(window, colors) {
    this.#window = window;
    this.#colors = colors;
    window.addEventListener("keydown", this, true);
    window.addEventListener("focusin", this, true);
    window.addEventListener("focusout", this, true);
    window.addEventListener("resize", this);
    this.#observer = new window.MutationObserver(() => this.#rescan());
    this.#observer.observe(window.document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    this.#syncFocus();
    for (const delay of SETTLE_MS) {
      const timer = window.setTimeout(() => {
        this.#timers.delete(timer);
        this.#rescan();
      }, delay);
      this.#timers.add(timer);
    }
  }

  destroy() {
    const window = this.#window;
    try {
      window.removeEventListener("keydown", this, true);
      window.removeEventListener("focusin", this, true);
      window.removeEventListener("focusout", this, true);
      window.removeEventListener("resize", this);
      this.#observer.disconnect();
      for (const timer of this.#timers) {
        window.clearTimeout(timer);
      }
      window.cancelAnimationFrame(this.#scan);
      this.#root?.remove();
    } catch {
      // The window is already gone.
    }
    this.#root = null;
  }

  handleEvent(event) {
    switch (event.type) {
      case "keydown":
        this.#onKeyDown(event);
        break;
      case "focusin":
      case "focusout":
        Promise.resolve().then(() => this.#syncFocus());
        break;
      case "resize":
        this.#rescan();
        break;
    }
  }

  // Typing in a field is typing: the labels step aside until focus leaves.
  #syncFocus() {
    const document = this.#window.document;
    const editing = LazyvimiumDom.isEditable(
      LazyvimiumDom.deepActiveElement(document)
    );
    if (editing == this.#suspended) {
      return;
    }
    this.#suspended = editing;
    this.#typed = "";
    this.#rescan();
  }

  #rescan() {
    if (this.#typed) {
      return;
    }
    const window = this.#window;
    window.cancelAnimationFrame(this.#scan);
    this.#scan = window.requestAnimationFrame(() => this.#label());
  }

  #label() {
    this.#observer.takeRecords();
    this.#root?.remove();
    this.#root = null;
    this.#targets = [];
    if (this.#suspended || !this.#window.document.documentElement) {
      return;
    }
    this.#targets = LazyvimiumControls.inReadingOrder(
      LazyvimiumControls.find(this.#window)
    );
    this.#labels = hintLabels(this.#targets.length);
    this.#draw();
    // Drawing the labels changed the document, which is not the popup's doing.
    this.#observer.takeRecords();
  }

  #draw() {
    const window = this.#window;
    const document = window.document;
    const root = document.createElementNS(HTML_NS, "div");
    root.setAttribute(
      "style",
      "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;"
    );
    this.#targets.forEach((element, index) => {
      const label = this.#labels[index];
      if (!label.startsWith(this.#typed)) {
        return;
      }
      const rect = element.getBoundingClientRect();
      const tag = document.createElementNS(HTML_NS, "span");
      tag.textContent = label;
      const left = Math.max(0, Math.min(rect.left + 2, window.innerWidth - 24));
      const top = Math.max(0, Math.min(rect.top + 2, window.innerHeight - 18));
      tag.setAttribute(
        "style",
        `position: absolute; left: ${left}px; top: ${top}px; padding: 0 4px; ` +
          `border-radius: 4px; background: ${this.#colors.background}; ` +
          `color: ${this.#colors.color}; font: 700 11px/16px ui-monospace, monospace; ` +
          "box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);"
      );
      root.append(tag);
    });
    this.#root = root;
    document.documentElement.append(root);
  }

  #onKeyDown(event) {
    if (
      !event.isTrusted ||
      this.#suspended ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.key.length != 1
    ) {
      // Escape drops a half-typed label; anything else is the popup's.
      if (this.#typed && event.key == "Escape") {
        event.preventDefault();
        event.stopPropagation();
        this.#typed = "";
        this.#redraw();
      }
      return;
    }
    const typed = this.#typed + event.key;
    if (!this.#labels.some(label => label.startsWith(typed))) {
      this.#typed = "";
      this.#redraw();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const index = this.#labels.indexOf(typed);
    if (index == -1) {
      this.#typed = typed;
      this.#redraw();
      return;
    }
    this.#typed = "";
    const element = this.#targets[index];
    this.#redraw();
    this.#press(element);
  }

  #redraw() {
    this.#root?.remove();
    this.#draw();
    this.#observer.takeRecords();
  }

  // Focus a field; press anything else with the mouse input a user's would
  // be, for the handlers that listen to mousedown rather than click.
  #press(element) {
    const window = this.#window;
    if (LazyvimiumDom.isEditable(element)) {
      element.focus();
      return;
    }
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    window.synthesizeMouseEvent("mousemove", x, y, {});
    for (const type of ["mousedown", "mouseup"]) {
      window.synthesizeMouseEvent(type, x, y, { button: 0, clickCount: 1 });
    }
    // What the press did shows on the next look.
    this.#rescan();
  }
}
