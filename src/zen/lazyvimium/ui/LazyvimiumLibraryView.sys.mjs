// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";
import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";
import { LazyvimiumOptions } from "resource:///modules/lazyvimium/config/LazyvimiumOptions.sys.mjs";
import {
  LazyvimiumHints,
  isOnScreen,
} from "resource:///modules/lazyvimium/ui/LazyvimiumHints.sys.mjs";
import { sendKey } from "resource:///modules/lazyvimium/ui/LazyvimiumMenuKeys.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

// The rows of a section's list, the media grid, and the controls under a
// list, like the space routing's default for external links.
const LIST_ITEMS = [
  ".zen-library-search-results .zen-library-row",
  ".zen-library-search-results .zen-library-media-item",
  ".zen-library-media-opt-in-button",
  ".zen-library-routing-footer .zen-library-routing-select",
].join();

// The filter panel, or the space routing's form, that replaces the list.
const PANEL_ITEMS = [
  ".zen-library-filter-header button",
  ".zen-library-filter-panel-inner button",
  ".zen-library-filter-panel-inner input",
].join();

// Keys typed in a section's search box that move over or open the list, as
// in snacks.picker's input.
const SEARCH_MOVES = {
  "<C-j>": 1,
  "<C-n>": 1,
  "<Down>": 1,
  "<C-k>": -1,
  "<C-p>": -1,
  "<Up>": -1,
};

// The media preview listens to the arrow keys and Escape.
const PREVIEW_KEYS = { h: "ArrowLeft", l: "ArrowRight", q: "Escape" };

// What `d` picks from a row's context menu where the row has no trash
// button: downloads leave the list, the file stays.
const DELETE_ACTIONS = { downloads: "hide", boosts: "delete" };

// What `y` picks from a row's context menu, for rows that only it knows the
// address of.
const YANK_ACTIONS = { downloads: "copy-link", media: "copy" };

function isShown(element) {
  return (
    element.checkVisibility({ visibilityProperty: true }) &&
    element.getBoundingClientRect().height > 0
  );
}

function clamp(value, max) {
  return Math.max(0, Math.min(value, max));
}

/**
 * Zen's library panel as a buffer, after snacks.picker: a section opens with
 * the keys in its search box (insert mode), <Esc> moves them to a cursor
 * over the list, the media grid or the cards of the spaces, and the
 * library mode ("l") of the window's key engine acts on it.
 */
export class LazyvimiumLibraryView {
  mode = "l";

  #window;
  #onChange;
  #attached = false;
  /** Whether a click elsewhere handed the keys back to the page. */
  #suspended = false;
  /** Whether it was closed from here and Zen is still animating that. */
  #closing = false;
  /** @type {Element|null} */
  #cursor = null;
  /** @type {[number, number]} The cursor's column and row. */
  #at = [0, 0];
  /** What the cursor was placed in: the section, and its panel or list. */
  #view = null;
  /** Whether the section being switched to keeps the keys in its list. */
  #stayInList = false;
  #focusSink = null;
  #controller = null;
  #content = null;
  #frame = 0;
  /** @type {LazyvimiumHints|null} */
  #hints = null;

  /**
   * @param {Window} window A browser window.
   * @param {object} options
   * @param {() => void} options.onChange Called when it opens, closes or
   *   moves between the search box and the list.
   */
  constructor(window, { onChange }) {
    this.#window = window;
    this.#onChange = onChange;
    const library = this.#library;
    if (library) {
      // Zen sets these as the library starts opening and once it is closed.
      new window.MutationObserver(() => this.#sync()).observe(library, {
        attributes: true,
        attributeFilter: ["open", "transitioning"],
      });
    }
  }

  get #library() {
    return this.#window.document.querySelector("zen-library");
  }

  get #libraryClass() {
    return this.#window.customElements.get("zen-library");
  }

  get isOpen() {
    return this.#attached && !this.#suspended;
  }

  /**
   * @returns {boolean} Whether the keys go to a field of the library, which
   *   is snacks.picker's insert mode.
   */
  get inserting() {
    const field = this.#field;
    return !!field && !!this.#library?.contains(field);
  }

  // The field that keys type into. A search box behind an open filter panel,
  // or in the section just left, keeps the focus but takes no keys.
  get #field() {
    const active = LazyvimiumDom.deepActiveElement(this.#window.document);
    return LazyvimiumDom.isEditable(active) &&
      !active.closest("[inert]") &&
      active.checkVisibility()
      ? active
      : null;
  }

  /** @returns {Element|null} The section on screen. */
  get section() {
    const library = this.#library;
    const content = library?.querySelector("#zen-library-content");
    return (
      [...(content?.children ?? [])].find(
        section => section.dataset?.section == library.activeTab
      ) ?? null
    );
  }

  /** @returns {string|null} The id of the section on screen. */
  get sectionId() {
    return this.section?.dataset.section ?? null;
  }

  /**
   * Close the library.
   */
  close() {
    if (!this.#attached) {
      return;
    }
    this.#closing = true;
    this.#libraryClass?.close();
    this.#detach();
  }

  /**
   * Stop taking keys, leaving the library as it is.
   */
  release() {
    this.#detach();
  }

  /**
   * Take the keys again after a click elsewhere handed them to the page,
   * as opening a section with its keys does.
   */
  resume() {
    if (this.#attached && this.#suspended) {
      this.#suspended = false;
      this.#refresh();
      this.#focusListUnlessTyping();
      this.#onChange();
    } else {
      this.#sync();
    }
  }

  /**
   * Who a key belongs to while the library mode is on.
   *
   * @param {KeyboardEvent} event
   * @returns {"library"|"handled"|"other"} "library" for the key engine,
   *   "handled" when the library took it here, "other" when a field,
   *   picker or the media preview should get it.
   */
  routeKey(event) {
    if (this.#hints && !this.#hints.done) {
      this.#hints.handleKey(event);
      return "handled";
    }
    const window = this.#window;
    const document = window.document;
    const token = LazyvimiumKeys.fromEvent(event);
    if (document.querySelector(".zen-library-media-preview")) {
      const key = PREVIEW_KEYS[token];
      if (!key) {
        return "other";
      }
      this.#consume(event);
      window.setTimeout(() => sendKey(window, key), 0);
      return "handled";
    }
    if (document.getElementById("lazyvimium-picker")) {
      return "other";
    }
    const field = this.#field;
    if (field) {
      return field.closest(".zen-library-search-box") &&
        this.#searchKey(token, event)
        ? "handled"
        : "other";
    }
    return "library";
  }

  // <C-j> and <C-k> move over the list while typing a search, <CR> opens
  // the item under the cursor, <Tab> and <S-Tab> switch sections and <Esc>
  // goes to the list.
  #searchKey(token, event) {
    if (SEARCH_MOVES[token]) {
      this.#consume(event);
      this.move(SEARCH_MOVES[token]);
      return true;
    }
    if (token == "<Tab>" || token == "<S-Tab>") {
      this.#consume(event);
      this.switchSection(token == "<Tab>" ? 1 : -1, { fromSearch: true });
      return true;
    }
    if (token == "<CR>" && this.item) {
      this.#consume(event);
      this.activate();
      return true;
    }
    if (token == "<Esc>") {
      this.#consume(event);
      this.focusList();
      return true;
    }
    return false;
  }

  #consume(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  /** @returns {Element|null} The item under the cursor. */
  get item() {
    const grid = this.#grid();
    const [column, row] = this.#locate(grid);
    return grid[column]?.[row] ?? null;
  }

  /**
   * @param {number} delta Rows to move down, or up when negative.
   */
  move(delta) {
    const grid = this.#grid();
    const [column, row] = this.#locate(grid);
    this.#setCursor(grid, column, row + delta);
  }

  /**
   * Move across the media grid's columns or the spaces.
   *
   * @param {number} delta Columns to move right, or left when negative.
   */
  moveAcross(delta) {
    const grid = this.#grid();
    const [column, row] = this.#locate(grid);
    this.#setCursor(grid, column + delta, row);
  }

  /**
   * @param {number} row A row of the cursor's column; negative counts from
   *   the end.
   */
  moveTo(row) {
    const grid = this.#grid();
    const [column] = this.#locate(grid);
    const rows = grid[column]?.length ?? 0;
    this.#setCursor(grid, column, row < 0 ? rows + row : row);
  }

  /**
   * Move half the list's height, as <C-d> and <C-u> do.
   *
   * @param {1|-1} direction
   */
  moveHalfPage(direction) {
    const item = this.item;
    const list = item?.closest(
      ".zen-library-search-results, .zen-library-space-body"
    );
    const height = item?.getBoundingClientRect().height;
    const visible = list && height ? list.clientHeight / height : 16;
    this.move(direction * Math.max(1, Math.floor(visible / 2)));
  }

  /**
   * Open the item under the cursor the way clicking it does: a visit, a
   * download, a picture, a tab of a space. A space's header switches to
   * that space.
   */
  activate() {
    const item = this.item;
    if (!item) {
      return;
    }
    if (item.classList.contains("zen-library-space-header")) {
      const uuid = item.closest(".zen-library-space").dataset.uuid;
      this.close();
      this.#window.gZenWorkspaces.changeWorkspaceWithID(uuid);
    } else if (LazyvimiumDom.isEditable(item)) {
      item.focus();
    } else {
      item.click();
    }
  }

  /**
   * Open the context menu of the item under the cursor, or a space's menu
   * on its header.
   */
  openMenu() {
    const item = this.item;
    if (!item) {
      return;
    }
    if (item.classList.contains("zen-library-space-header")) {
      this.#card(item)?.querySelector(".zen-library-space-actions")?.click();
    } else {
      this.#contextMenu(item);
    }
  }

  /**
   * Forget a visit, drop a download from the list, delete a boost or a
   * route, close a space's tab.
   */
  delete() {
    const item = this.item;
    if (!item) {
      return;
    }
    if (item.localName == "tab") {
      item.querySelector(".tab-close-button")?.click();
      return;
    }
    const trash = [
      ...item.querySelectorAll(".zen-library-row-actions toolbarbutton"),
    ].find(button => button.querySelector("img")?.src.endsWith("/trash.svg"));
    if (trash) {
      trash.click();
    } else if (DELETE_ACTIONS[this.sectionId]) {
      this.#menuAction(item, DELETE_ACTIONS[this.sectionId]);
    }
  }

  /**
   * Copy what the item under the cursor points at: a visit's or download's
   * address, a picture, a boost's site, a route's link.
   */
  yank() {
    const item = this.item;
    const section = this.section;
    if (!item || !section) {
      return;
    }
    const id = section.dataset.section;
    if (YANK_ACTIONS[id]) {
      this.#menuAction(item, YANK_ACTIONS[id]);
      return;
    }
    let text = null;
    if (id == "history") {
      text = this.#visitOf(section, item)?.url;
    } else if (id == "boosts") {
      text = item.querySelector(".zen-library-row-subtitle")?.textContent;
    } else if (id == "space-routing") {
      text = item.querySelector(".zen-library-routing-value")?.textContent;
    }
    if (text?.trim()) {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(text.trim());
    }
  }

  /**
   * Label every item on screen, flash.nvim style, and move the cursor to
   * the one typed.
   *
   * @returns {Promise<void>}
   */
  async jump() {
    this.#hints?.finish(null);
    const items = this.#grid().flat().filter(isOnScreen);
    const hints = new LazyvimiumHints(items);
    this.#hints = hints;
    const index = await hints.picked;
    if (this.#hints == hints) {
      this.#hints = null;
    }
    if (index !== null && this.isOpen) {
      this.#moveToElement(items[index]);
    }
  }

  /**
   * Put the keys in the section's search box.
   */
  async search() {
    const section = this.section;
    if (!section?.focusSearch) {
      return;
    }
    if (section.filtersOpen) {
      section.onEscape?.();
      await section.updateComplete;
    }
    section.focusSearch();
  }

  /**
   * Put the keys in the list, out of the search box.
   */
  focusList() {
    const document = this.#window.document;
    if (!this.#focusSink) {
      this.#focusSink = document.createElementNS(HTML_NS, "div");
      this.#focusSink.id = "lazyvimium-library-focus";
      this.#focusSink.tabIndex = -1;
      this.#focusSink.setAttribute("role", "listbox");
      this.#focusSink.setAttribute("aria-label", "Library");
      (document.getElementById("browser") ?? document.documentElement).append(
        this.#focusSink
      );
    }
    this.#focusSink.focus();
    this.#onChange();
  }

  /**
   * Open the filter panel of a section that has one.
   */
  openFilters() {
    const section = this.section;
    if (section?.filterGroups?.length && !section.filtersOpen) {
      section.querySelector(".zen-library-filter-button")?.click();
    }
  }

  /**
   * Add a space, or a route.
   */
  add() {
    const section = this.section;
    if (this.sectionId == "spaces") {
      section.querySelector(".zen-swipe-add-space-progress-badge")?.click();
    } else if (this.sectionId == "space-routing") {
      section.querySelector(".zen-library-filter-button")?.click();
    }
  }

  /**
   * Leave the filter panel or the route being edited, or else close the
   * library.
   */
  quit() {
    if (this.section?.onEscape?.()) {
      return;
    }
    this.close();
  }

  /**
   * @param {number} delta Sections to move down the rail, or up when
   *   negative, wrapping around.
   * @param {object} [options]
   * @param {boolean} [options.fromSearch] Switched from a search box, so
   *   the next section's search box takes the keys, as Zen has it.
   */
  switchSection(delta, { fromSearch = false } = {}) {
    const tabs = [
      ...(this.#library?.querySelectorAll(
        ".zen-library-tab:not([hidden-tab])"
      ) ?? []),
    ];
    if (!tabs.length) {
      return;
    }
    const current = tabs.findIndex(tab => tab.hasAttribute("active"));
    const next = (current + delta + tabs.length) % tabs.length;
    this.#stayInList = !fromSearch;
    tabs[next].click();
  }

  /**
   * @param {string} id A section's id, like "history".
   */
  showSection(id) {
    const library = this.#library;
    const tab = library?.querySelector(
      `.zen-library-tab[data-section="${id}"]`
    );
    this.#stayInList = library?.activeTab != id;
    if (tab) {
      tab.click();
    } else if (library && id in (library.zenLibrarySections ?? {})) {
      library.activeTab = id;
    }
  }

  /**
   * Act on the space of the cursor's card: "rename", "theme" or "icon".
   *
   * @param {"rename"|"theme"|"icon"} what
   */
  editSpace(what) {
    const card = this.#card(this.item);
    const selector = {
      rename: ".zen-library-space-name",
      theme: ".zen-library-space-header > toolbarbutton",
      icon: ".zen-library-space-icon",
    }[what];
    card?.querySelector(selector)?.click();
  }

  /**
   * Move the cursor's space along the others.
   *
   * @param {number} delta
   */
  async moveSpace(delta) {
    const card = this.#card(this.item);
    const { gZenWorkspaces } = this.#window;
    const spaces = gZenWorkspaces.getWorkspaces();
    const index = spaces.findIndex(space => space.uuid == card?.dataset.uuid);
    const target = index + delta;
    if (index == -1 || target < 0 || target >= spaces.length) {
      return;
    }
    const uuid = card.dataset.uuid;
    await gZenWorkspaces.reorderWorkspace(uuid, target);
    await this.section?.updateComplete;
    const header = this.section?.querySelector(
      `.zen-library-space[data-uuid="${uuid}"] .zen-library-space-header`
    );
    if (header) {
      this.#moveToElement(header);
    }
  }

  #card(item) {
    return item?.closest(".zen-library-space") ?? null;
  }

  // Zen keeps the visits of the list in the order it draws them.
  #visitOf(section, row) {
    const rows = [...section.querySelectorAll(".zen-library-row")];
    const visits = section.visits;
    const list = Array.isArray(visits)
      ? visits
      : [...(visits?.values() ?? [])].flat();
    return list[rows.indexOf(row)] ?? null;
  }

  // A right click on the item, which the sections answer with their menu at
  // the click.
  #contextMenu(item) {
    const window = this.#window;
    const rect = item.getBoundingClientRect();
    const clientX = rect.left + Math.min(rect.width / 2, 24);
    const clientY = rect.bottom;
    item.dispatchEvent(
      new window.MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        composed: true,
        button: 2,
        clientX,
        clientY,
        screenX: window.mozInnerScreenX + clientX,
        screenY: window.mozInnerScreenY + clientY,
      })
    );
  }

  // Pick an entry of the item's context menu without showing it: the
  // sections only know which row a menu entry is for while it is open.
  #menuAction(item, action) {
    const document = this.#window.document;
    this.#contextMenu(item);
    const popup = [
      ...document.querySelectorAll("menupopup[class^='zen-library-']"),
    ].find(menu => menu.state != "closed");
    const entry = popup?.querySelector(`menuitem[data-action="${action}"]`);
    if (entry && !entry.disabled && !entry.hidden) {
      entry.doCommand();
    }
    popup?.hidePopup();
  }

  /**
   * The items the cursor moves over as columns of rows: one column for a
   * list or a panel, the media grid's columns, a column per space with its
   * header above its tabs and folders.
   *
   * @returns {Element[][]}
   */
  #grid() {
    const section = this.section;
    if (!section) {
      return [];
    }
    if (section.dataset.section == "spaces") {
      return this.#spaceColumns(section);
    }
    const items = [
      ...section.querySelectorAll(
        section.filtersOpen ? PANEL_ITEMS : LIST_ITEMS
      ),
    ].filter(isShown);
    if (!items.length) {
      return [];
    }
    let perRow = 1;
    if (items[0].classList.contains("zen-library-media-item")) {
      const top = items[0].getBoundingClientRect().top;
      perRow = items.findIndex(item => item.getBoundingClientRect().top != top);
      if (perRow <= 0) {
        perRow = items.length;
      }
    }
    return Array.from({ length: perRow }, (_, column) =>
      items.filter((item, index) => index % perRow == column)
    );
  }

  #spaceColumns(section) {
    const columns = [...section.querySelectorAll(".zen-library-space")].map(
      card => [
        card.querySelector(".zen-library-space-header"),
        ...[
          ...card.querySelectorAll(
            ".zen-library-space-tabs :is(tab:not([zen-empty-tab]), .tab-group-label-container)"
          ),
        ].filter(isShown),
      ]
    );
    const add = section.querySelector(".zen-swipe-add-space-progress-badge");
    if (add) {
      columns.push([add]);
    }
    return columns.filter(column => column[0]);
  }

  #locate(grid) {
    for (const [column, rows] of grid.entries()) {
      const row = rows.indexOf(this.#cursor);
      if (row != -1) {
        return [column, row];
      }
    }
    const column = clamp(this.#at[0], grid.length - 1);
    return [column, clamp(this.#at[1], (grid[column]?.length ?? 1) - 1)];
  }

  #moveToElement(element) {
    const grid = this.#grid();
    for (const [column, rows] of grid.entries()) {
      if (rows.includes(element)) {
        this.#setCursor(grid, column, rows.indexOf(element));
        return;
      }
    }
  }

  #setCursor(grid, column, row) {
    this.#cursor?.removeAttribute("lazyvimium-cursor");
    if (!grid.length) {
      this.#cursor = null;
      return;
    }
    column = clamp(column, grid.length - 1);
    row = clamp(row, grid[column].length - 1);
    this.#at = [column, row];
    this.#cursor = grid[column][row];
    this.#cursor.setAttribute("lazyvimium-cursor", "true");
    this.#scrollToCursor();
  }

  // Bring the cursor into view in the lists that scroll: the section's
  // results, the row of spaces and a space's tabs. scrollIntoView would
  // also scroll the library's overflow: hidden boxes, which its open and
  // close animation sizes.
  #scrollToCursor() {
    const window = this.#window;
    const library = this.#library;
    let item = this.#cursor;
    for (
      let box = item.parentElement;
      box && box != library && library?.contains(box);
      box = box.parentElement
    ) {
      const { overflowX, overflowY } = window.getComputedStyle(box);
      const scrolls = value => value == "auto" || value == "scroll";
      if (!scrolls(overflowX) && !scrolls(overflowY)) {
        continue;
      }
      const itemRect = item.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      if (scrolls(overflowY)) {
        if (itemRect.top < boxRect.top) {
          box.scrollTop -= boxRect.top - itemRect.top;
        } else if (itemRect.bottom > boxRect.bottom) {
          box.scrollTop += itemRect.bottom - boxRect.bottom;
        }
      }
      if (scrolls(overflowX)) {
        if (itemRect.left < boxRect.left) {
          box.scrollLeft -= boxRect.left - itemRect.left;
        } else if (itemRect.right > boxRect.right) {
          box.scrollLeft += itemRect.right - boxRect.right;
        }
      }
      item = box;
    }
  }

  #sync() {
    const open = !!this.#libraryClass?.isLibraryOpen;
    if (!open) {
      this.#closing = false;
    }
    if (open && !this.#attached && !this.#closing) {
      this.#attach();
    } else if (!open && this.#attached) {
      this.#detach();
    }
  }

  #attach() {
    const window = this.#window;
    if (!LazyvimiumOptions.enabled) {
      return;
    }
    this.#attached = true;
    this.#suspended = false;
    this.#view = null;
    window.document.documentElement.setAttribute("lazyvimium-library", "true");

    this.#controller = new window.AbortController();
    const options = { capture: true, signal: this.#controller.signal };
    // A click on the page hands it the keys; one in the library takes them
    // back.
    window.addEventListener(
      "mousedown",
      event => {
        const target = event.target;
        if (
          !this.#suspended &&
          !this.#library.contains(target) &&
          !target.closest?.(
            "menupopup, panel, .zen-library-media-preview, #lazyvimium-picker"
          )
        ) {
          this.#suspend();
        }
      },
      options
    );
    window.addEventListener(
      "focusin",
      event => {
        if (this.#library.contains(event.target)) {
          this.#suspended = false;
          this.#onChange();
        } else if (event.target.localName == "browser" && this.isOpen) {
          window.setTimeout(() => this.isOpen && this.focusList(), 0);
        }
      },
      options
    );
    // Leaving a field, like a space's name, gives the keys back to the list.
    window.addEventListener(
      "focusout",
      event => {
        if (this.#library.contains(event.target)) {
          window.setTimeout(() => this.#focusListUnlessTyping(), 0);
        }
      },
      options
    );
    // Typing a search starts the cursor over at the top, as in a picker.
    window.addEventListener(
      "input",
      event => {
        if (event.target.closest?.(".zen-library-search-box")) {
          this.#view = null;
        }
      },
      options
    );

    // The sections draw their lists, switch and open panels as they please;
    // the cursor follows.
    this.#content = new window.MutationObserver(() => this.#scheduleRefresh());
    this.#content.observe(this.#library, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["showing", "open", "transitioning"],
    });
    this.#scheduleRefresh();
    this.#onChange();
  }

  #detach() {
    if (!this.#attached) {
      return;
    }
    const window = this.#window;
    const document = window.document;
    this.#attached = false;
    this.#suspended = false;
    this.#hints?.finish(null);
    this.#hints = null;
    this.#controller.abort();
    this.#content.disconnect();
    window.cancelAnimationFrame(this.#frame);
    this.#frame = 0;
    this.#cursor?.removeAttribute("lazyvimium-cursor");
    this.#cursor = null;
    document.documentElement.removeAttribute("lazyvimium-library");
    const active = document.activeElement;
    if (this.#focusSink?.contains(active) || this.#library?.contains(active)) {
      window.gBrowser.selectedBrowser.focus();
    }
    this.#focusSink?.remove();
    this.#focusSink = null;
    this.#onChange();
  }

  #suspend() {
    this.#suspended = true;
    this.#hints?.finish(null);
    this.#onChange();
  }

  #focusListUnlessTyping() {
    const document = this.#window.document;
    const active = document.activeElement;
    if (
      this.isOpen &&
      !this.inserting &&
      !this.#focusSink?.contains(active) &&
      !document.getElementById("lazyvimium-picker")
    ) {
      this.focusList();
    }
  }

  // Measuring the list flushes layout, which would hold up the frames of
  // the library sliding in or out; the cursor waits until it is still.
  #scheduleRefresh() {
    if (!this.#frame) {
      this.#frame = this.#window.requestAnimationFrame(() => {
        this.#frame = 0;
        if (this.#attached && !this.#library.hasAttribute("transitioning")) {
          this.#refresh();
        }
      });
    }
  }

  // Keep the cursor on the list as it changes. A new section, panel or
  // search starts it at the top, and a section without a search box takes
  // the keys in its list. Moving to a section with the list's keys stays in
  // its list, where Zen would put them in its search box.
  #refresh() {
    const section = this.section;
    const view = section
      ? `${section.dataset.section}:${!!section.filtersOpen}`
      : null;
    const grid = this.#grid();
    if (view != this.#view) {
      this.#view = view;
      this.#setCursor(grid, 0, 0);
      if (this.#stayInList && this.isOpen) {
        this.focusList();
      } else if (!this.#suspended) {
        this.#focusListUnlessTyping();
      }
      this.#stayInList = false;
      return;
    }
    if (!grid.some(column => column.includes(this.#cursor))) {
      const [column, row] = this.#locate(grid);
      this.#setCursor(grid, column, row);
    }
  }
}
