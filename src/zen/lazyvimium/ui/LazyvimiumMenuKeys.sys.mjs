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

/** @type {WeakMap<Window, nsITextInputProcessor>} */
const processors = new WeakMap();

/**
 * Type a key the way the keyboard would, for browser UI that only listens
 * to the arrow keys and Escape. It is trusted, so it passes through the
 * window's key listeners like a real one.
 *
 * @param {Window} window
 * @param {"ArrowDown"|"ArrowUp"|"ArrowLeft"|"ArrowRight"|"Escape"} key
 */
export function sendKey(window, key) {
  let tip = processors.get(window);
  if (!tip) {
    tip = Cc["@mozilla.org/text-input-processor;1"].createInstance(
      Ci.nsITextInputProcessor
    );
    processors.set(window, tip);
  }
  if (!tip.beginInputTransaction(window, () => true)) {
    return;
  }
  const keyEvent = new window.KeyboardEvent("", {
    key,
    code: key,
    keyCode: KEY_CODES[key],
  });
  tip.keydown(keyEvent);
  tip.keyup(keyEvent);
}

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

// Whether a panel shows an extension's page, like a toolbar button's popup.
// Its keys are that page's, as they are in a tab.
function showsExtensionPage(popup) {
  return [
    ...popup.querySelectorAll('browser[webextension-view-type="popup"]'),
  ].some(browser => browser.checkVisibility());
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
    return [...this.#open].some(popup => !showsExtensionPage(popup));
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
    this.#window.setTimeout(() => sendKey(this.#window, key), 0);
  }
}
