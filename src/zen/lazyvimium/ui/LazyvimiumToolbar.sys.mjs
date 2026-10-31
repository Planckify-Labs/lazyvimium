// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";
import {
  LazyvimiumHints,
  isOnScreen,
} from "resource:///modules/lazyvimium/ui/LazyvimiumHints.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * The top bar as a row of items, the explorer's counterpart for the toolbar:
 * a cursor over its buttons and the urlbar that h and l move and <CR>
 * presses, the window buttons included. Its keys reach it through the
 * toolbar mode ("t") of the window's key engine.
 */
export class LazyvimiumToolbar {
  mode = "t";

  #window;
  #onChange;
  #open = false;
  /** @type {Element|null} */
  #cursor = null;
  #cursorIndex = 0;
  #focusSink = null;
  #controller = null;
  /** @type {LazyvimiumHints|null} */
  #hints = null;
  /** @type {{element: Element, attribute: string}|null} What #show set. */
  #shown = null;
  /** @type {Element|null} The only bar the items come from, when one is. */
  #scope = null;

  /**
   * @param {Window} window A browser window.
   * @param {object} options
   * @param {() => void} options.onChange Called when it opens or closes.
   */
  constructor(window, { onChange }) {
    this.#window = window;
    this.#onChange = onChange;
  }

  get isOpen() {
    return this.#open;
  }

  get #wrapper() {
    return this.#window.document.getElementById(
      "zen-appcontent-navbar-wrapper"
    );
  }

  // Zen's single toolbar layout moves the buttons and the urlbar to the top
  // of the sidebar; the other one keeps them in a bar above the page.
  get #isSingleToolbar() {
    return this.#window.document.documentElement.hasAttribute(
      "zen-single-toolbar"
    );
  }

  // Where the toolbar's items live, in either layout.
  get #roots() {
    const document = this.#window.document;
    return [
      document.getElementById("zen-sidebar-top-buttons"),
      document.getElementById("nav-bar"),
      document.getElementById("PanelUI-button"),
      this.#window.gZenVerticalTabsManager?.actualWindowButtons,
    ].filter(Boolean);
  }

  /**
   * The buttons and the urlbar of the toolbar in reading order: top to
   * bottom, then left to right.
   *
   * @returns {Element[]}
   */
  items() {
    const items = new Set();
    for (const root of this.#roots) {
      for (const item of root.querySelectorAll(
        "toolbarbutton, #urlbar-container"
      )) {
        if (
          !item.parentElement.closest("#urlbar-container") &&
          (!this.#scope || this.#scope.contains(item)) &&
          isOnScreen(item)
        ) {
          items.add(item);
        }
      }
    }
    const line = item => Math.round(item.getBoundingClientRect().top / 16);
    return [...items].sort(
      (a, b) =>
        line(a) - line(b) ||
        a.getBoundingClientRect().left - b.getBoundingClientRect().left
    );
  }

  /** @returns {Element|null} The item under the cursor. */
  get item() {
    const items = this.items();
    return items[this.#index(items)] ?? null;
  }

  /**
   * Show the top bar, if compact mode hides it, and put the cursor on an
   * item: `at`, or the urlbar.
   *
   * @param {object} [options]
   * @param {Element} [options.at]
   * @param {boolean} [options.fromSidebar] Opened from the explorer, whose
   *   compact sidebar stays out for the toolbar.
   */
  async open({ at, fromSidebar = false } = {}) {
    if (this.#open) {
      this.#moveToElement(at);
      return;
    }
    const window = this.#window;
    const bar = this.#compactBar(fromSidebar);
    // The top bar alone: the cursor stays on what is on screen.
    this.#scope =
      bar?.element == this.#wrapper && this.#isSingleToolbar
        ? bar.element
        : null;
    this.#open = true;
    window.document.documentElement.setAttribute("lazyvimium-toolbar", "true");

    this.#controller = new window.AbortController();
    const options = { capture: true, signal: this.#controller.signal };
    window.addEventListener(
      "mousedown",
      event => {
        if (
          ![this.#wrapper, ...this.#roots].some(root =>
            root?.contains(event.target)
          ) &&
          !event.target.closest?.("menupopup, panel")
        ) {
          this.close();
        }
      },
      options
    );
    window.addEventListener(
      "focusin",
      event => {
        if (event.target.localName == "browser") {
          window.setTimeout(() => this.#open && this.#focus(), 0);
        }
      },
      options
    );

    this.#focus();
    this.#onChange();
    // Once the explorer this replaces has let go of the compact sidebar,
    // so the toolbar holds it instead of finding it shown and losing it.
    this.#show(bar);
    // The bar may still be sliding in; place the cursor where it ends up.
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    // Closed again before the bar came to rest.
    if (!this.#open) {
      return;
    }
    const items = this.items();
    const start =
      at ??
      (this.#scope
        ? items[0]
        : window.document.getElementById("urlbar-container"));
    const index = items.indexOf(start);
    this.#setCursor(items, index == -1 ? 0 : index);
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.keepBar] Leave a compact top bar on screen.
   */
  close({ keepBar = false } = {}) {
    if (!this.#open) {
      return;
    }
    const window = this.#window;
    this.#open = false;
    this.#hints?.finish(null);
    this.#controller.abort();
    this.#cursor?.removeAttribute("lazyvimium-cursor");
    this.#cursor = null;
    this.#scope = null;
    window.document.documentElement.removeAttribute("lazyvimium-toolbar");
    if (!keepBar) {
      this.#hide();
    }
    if (this.#focusSink?.contains(window.document.activeElement)) {
      window.gBrowser.selectedBrowser.focus();
    }
    this.#focusSink?.remove();
    this.#focusSink = null;
    this.#onChange();
  }

  /**
   * Who a key belongs to while the toolbar mode is on.
   *
   * @param {KeyboardEvent} event
   * @returns {"toolbar"|"handled"|"other"}
   */
  routeKey(event) {
    if (this.#hints && !this.#hints.done) {
      this.#hints.handleKey(event);
      return "handled";
    }
    const document = this.#window.document;
    if (
      document.getElementById("lazyvimium-picker") ||
      LazyvimiumDom.isEditable(LazyvimiumDom.deepActiveElement(document))
    ) {
      return "other";
    }
    return "toolbar";
  }

  /**
   * @param {number} delta Items to move right, or left when negative.
   */
  move(delta) {
    const items = this.items();
    this.#setCursor(items, this.#index(items) + delta);
  }

  /**
   * @param {number} index An item index; negative counts from the end.
   */
  moveTo(index) {
    const items = this.items();
    this.#setCursor(items, index < 0 ? items.length + index : index);
  }

  /**
   * Press the item under the cursor, the way clicking it does, leaving the
   * toolbar mode. The urlbar takes the keys for typing an address. A menu
   * it opens keeps the bar on screen, as Zen does for one opened by mouse.
   */
  activate() {
    const window = this.#window;
    const item = this.item;
    if (!item) {
      this.close();
      return;
    }
    // Hand focus back to the page first, so what the item opens can take
    // it, but keep the bar up for a menu to anchor on.
    this.close({ keepBar: true });
    this.#press(item);
    window.setTimeout(() => !this.#open && this.#hide(), 300);
  }

  #press(item) {
    const window = this.#window;
    if (item.id == "urlbar-container") {
      window.gURLBar.select();
    } else if (item == window.PanelUI?.menuButton) {
      window.PanelUI.show();
    } else if (
      item.id == "zen-create-new-button" &&
      !window.gZenWorkspaces.privateWindowOrDisabled
    ) {
      // Zen opens this menu on mousedown, which a press has none of.
      window.document
        .getElementById("zenCreateNewPopup")
        .openPopup(item, "before_start", 0, 0, true);
    } else if (item.getAttribute("type") == "menu") {
      item.open = true;
    } else if (item.hasAttribute("command") || item.hasAttribute("oncommand")) {
      item.doCommand();
    } else {
      item.click();
    }
  }

  /**
   * Open the context menu of the item under the cursor: the history of the
   * back and forward buttons, or the toolbar's own.
   *
   * @returns {Promise<void>} Resolves once the menu is closed.
   */
  openMenu() {
    const window = this.#window;
    const item = this.item;
    const popup = window.document.getElementById(
      item?.getAttribute("context") || "toolbar-context-menu"
    );
    if (!item || !popup) {
      return Promise.resolve();
    }
    // The menus find what they are for through the node that triggered
    // them, which only an event carries.
    const triggerEvent = new window.CustomEvent("LazyvimiumMenu");
    item.dispatchEvent(triggerEvent);
    const { promise, resolve } = Promise.withResolvers();
    // A command picked from the menu is done with the toolbar, the way
    // pressing an item is; a menu closed without one returns to it.
    // An item with a command attribute has its command event sent to the
    // <command> element instead, with the item's event as its source.
    let commanded = false;
    const onCommand = event => {
      const source = event.sourceEvent?.target ?? event.target;
      if (popup.contains(source)) {
        commanded = true;
      }
    };
    window.addEventListener("command", onCommand, true);
    const onHidden = event => {
      if (event.target != popup) {
        return;
      }
      window.removeEventListener("command", onCommand, true);
      popup.removeEventListener("popuphidden", onHidden);
      // Zen keeps the bar its menu opened from on screen (has-popup-menu)
      // until the pointer comes back into the window. A menu opened from
      // the keys has no pointer to wait for: let the bar go now, after
      // Zen's own popuphidden handler.
      window.setTimeout(() => this.#releasePopupHold(), 0);
      if (commanded) {
        this.close();
      }
      resolve();
    };
    popup.addEventListener("popuphidden", onHidden);
    popup.openPopup(item, {
      position: "after_start",
      isContextMenu: true,
      triggerEvent,
    });
    return promise;
  }

  /**
   * Label every item and move the cursor to the one typed.
   *
   * @returns {Promise<void>}
   */
  async jump() {
    const items = this.items();
    this.#hints = new LazyvimiumHints(items);
    const index = await this.#hints.picked;
    this.#hints = null;
    if (index !== null && this.#open) {
      this.#setCursor(this.items(), this.items().indexOf(items[index]));
    }
  }

  #moveToElement(element) {
    const items = this.items();
    const index = items.indexOf(element);
    if (index != -1) {
      this.#setCursor(items, index);
    }
  }

  #index(items) {
    const index = items.indexOf(this.#cursor);
    return index == -1 ? Math.min(this.#cursorIndex, items.length - 1) : index;
  }

  #setCursor(items, index) {
    this.#cursor?.removeAttribute("lazyvimium-cursor");
    if (!items.length) {
      this.#cursor = null;
      return;
    }
    this.#cursorIndex = Math.max(0, Math.min(index, items.length - 1));
    this.#cursor = items[this.#cursorIndex];
    this.#cursor.setAttribute("lazyvimium-cursor", "true");
  }

  #focus() {
    const document = this.#window.document;
    if (!this.#focusSink) {
      this.#focusSink = document.createElementNS(HTML_NS, "div");
      this.#focusSink.id = "lazyvimium-toolbar-focus";
      this.#focusSink.tabIndex = -1;
      this.#focusSink.setAttribute("role", "toolbar");
      this.#focusSink.setAttribute("aria-label", "Toolbar");
      (this.#wrapper ?? document.documentElement).append(this.#focusSink);
    }
    this.#focusSink.focus();
  }

  /**
   * The bar compact mode should bring out, or null when it hides nothing.
   * With the single toolbar the buttons are in the sidebar, which stays out
   * when the toolbar is opened from it. Opened from the page, it is the top
   * bar alone when Zen has moved the window buttons there (should-hide),
   * the way pointing at the top edge shows it.
   *
   * @param {boolean} fromSidebar Whether it opens from the explorer.
   * @returns {{element: Element, attribute: string}|null}
   */
  #compactBar(fromSidebar) {
    const compact = this.#window.gZenCompactModeManager;
    const wrapper = this.#wrapper;
    if (!compact?.preference) {
      return null;
    }
    if (
      this.#isSingleToolbar &&
      (fromSidebar || !wrapper?.hasAttribute("should-hide"))
    ) {
      return { element: compact.sidebar, attribute: "zen-user-show" };
    }
    return wrapper ? { element: wrapper, attribute: "zen-has-hover" } : null;
  }

  // Compact mode hides the top bar until the pointer reaches the top edge,
  // and the sidebar until it reaches the side; the attribute each of those
  // sets keeps the toolbar on screen while the cursor is in it.
  #show(bar) {
    const compact = this.#window.gZenCompactModeManager;
    // Still ours when reopened before a press let the bar go.
    if (this.#shown || !bar) {
      return;
    }
    const { element, attribute } = bar;
    const showing =
      element.hasAttribute(attribute) ||
      (element == compact.sidebar && compact.isSidebarPotentiallyOpen());
    if (!showing) {
      element.setAttribute(attribute, "true");
      this.#shown = bar;
    }
  }

  #releasePopupHold() {
    const compact = this.#window.gZenCompactModeManager;
    for (const element of [compact?.sidebar, this.#wrapper]) {
      if (element?.hasAttribute("has-popup-menu")) {
        compact._setElementExpandAttribute(element, false, "has-popup-menu");
      }
    }
  }

  #hide() {
    const { element, attribute } = this.#shown || {};
    if (element && !element.matches(":hover")) {
      element.removeAttribute(attribute);
    }
    this.#shown = null;
  }
}
