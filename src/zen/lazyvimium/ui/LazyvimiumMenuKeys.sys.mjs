// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";
import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";

// Keys that move through a menu or panel the way the arrow keys do.
const MENU_KEYS = {
  j: "ArrowDown",
  "<C-n>": "ArrowDown",
  "<C-j>": "ArrowDown",
  k: "ArrowUp",
  "<C-p>": "ArrowUp",
  "<C-k>": "ArrowUp",
  h: "ArrowLeft",
  l: "ArrowRight",
  q: "Escape",
};

const KEY_CODES = {
  ArrowDown: 40,
  ArrowUp: 38,
  ArrowLeft: 37,
  ArrowRight: 39,
  Escape: 27,
};

// Popups that take the keyboard: menus, and panels that are focused or
// navigate with the arrow keys (PanelMultiView, like the main menu).
// Autocomplete popups follow a field the user types in, and other
// noautofocus panels, like permission prompts, leave the keys with the
// page.
function isKeyNavigable(popup) {
  if (popup.localName == "menupopup") {
    return true;
  }
  return (
    popup.localName == "panel" &&
    !popup.getAttribute("type")?.startsWith("autocomplete") &&
    (popup.getAttribute("noautofocus") != "true" ||
      !!popup.querySelector("panelmultiview"))
  );
}

/**
 * vim keys in the window's open menus and panels: the main menu, context
 * menus, a toolbar button's dropdown. While one is open, keys belong to it;
 * j and k move like the arrow keys, l opens a submenu and h leaves it.
 */
export class LazyvimiumMenuKeys {
  #window;
  /** @type {Set<Element>} */
  #open = new Set();
  #tip = null;

  /**
   * @param {Window} window A browser window.
   */
  constructor(window) {
    this.#window = window;
    window.addEventListener(
      "popupshown",
      event => {
        if (isKeyNavigable(event.target)) {
          this.#open.add(event.target);
        }
      },
      true
    );
    window.addEventListener(
      "popuphidden",
      event => this.#open.delete(event.target),
      true
    );
  }

  /**
   * @returns {boolean} Whether a menu or panel is open, so keys are its.
   */
  get active() {
    for (const popup of this.#open) {
      if (!popup.isConnected || popup.state == "closed") {
        this.#open.delete(popup);
      }
    }
    return this.#open.size > 0;
  }

  /**
   * Turn a vim key into the arrow key a menu understands. Keys typed into a
   * field in a panel are left alone.
   *
   * @param {KeyboardEvent} event
   */
  handleKey(event) {
    const document = this.#window.document;
    const key = MENU_KEYS[LazyvimiumKeys.fromEvent(event)];
    if (
      !key ||
      LazyvimiumDom.isEditable(LazyvimiumDom.deepActiveElement(document))
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Once the key being handled is done: a key cannot be sent while
    // another is still being dispatched.
    this.#window.setTimeout(() => this.#send(key), 0);
  }

  #send(key) {
    const window = this.#window;
    this.#tip ??= Cc["@mozilla.org/text-input-processor;1"].createInstance(
      Ci.nsITextInputProcessor
    );
    if (!this.#tip.beginInputTransaction(window, () => true)) {
      return;
    }
    const keyEvent = new window.KeyboardEvent("", {
      key,
      code: key,
      keyCode: KEY_CODES[key],
    });
    this.#tip.keydown(keyEvent);
    this.#tip.keyup(keyEvent);
  }
}
