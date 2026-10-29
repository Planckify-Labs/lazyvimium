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
 * @typedef {object} LazyvimiumExplorerRow
 * @property {"tab"|"split"|"folder"} kind What the row shows.
 * @property {Element} element The tab, the split view's group or the folder.
 * @property {Element[]} tabs The tabs the row stands for.
 * @property {Element|null} folder The folder the row sits in.
 */

/**
 * The rows of the sidebar from top to bottom: essentials, pinned tabs and
 * folders, then the space's other tabs. A split view is one row, and the
 * rows of a collapsed folder are hidden, as on screen.
 *
 * @param {Window} window
 * @returns {LazyvimiumExplorerRow[]}
 */
export function explorerRows(window) {
  const { gBrowser, gZenWorkspaces } = window;
  const rows = [];
  const isOpenTab = tab => !tab.closing && !tab.hasAttribute("zen-empty-tab");
  const visit = (node, folder) => {
    if (gBrowser.isTab(node)) {
      if (node.visible && isOpenTab(node)) {
        rows.push({ kind: "tab", element: node, tabs: [node], folder });
      }
    } else if (
      gBrowser.isSplitViewWrapper(node) ||
      (gBrowser.isTabGroup(node) && node.hasAttribute("split-view-group"))
    ) {
      const tabs = node.tabs.filter(tab => tab.visible && isOpenTab(tab));
      if (tabs.length) {
        rows.push({ kind: "split", element: node, tabs, folder });
      }
    } else if (gBrowser.isTabGroup(node) && node.visible) {
      const tabs = node.tabs.filter(isOpenTab);
      rows.push({ kind: "folder", element: node, tabs, folder });
      for (const child of node.groupContainer?.children ?? []) {
        visit(child, node);
      }
    }
  };
  const pinned = gZenWorkspaces.activeWorkspaceElement?.hasCollapsedPinnedTabs
    ? []
    : (gZenWorkspaces.pinnedTabsContainer?.children ?? []);
  for (const node of [
    ...(gZenWorkspaces.getCurrentEssentialsContainer()?.children ?? []),
    ...pinned,
    ...gZenWorkspaces.tabboxChildrenWithoutEmpty,
  ]) {
    visit(node, null);
  }
  return rows;
}

// The elements that show a row's cursor and selection.
function highlightOf(row) {
  return row.kind == "folder" ? [row.element.labelContainerElement] : row.tabs;
}

// The element a row's jump label sits on.
function hintHostOf(row) {
  if (row.kind == "folder") {
    return row.element.labelContainerElement;
  }
  return row.tabs[0].querySelector(".tab-content") ?? row.tabs[0];
}

/**
 * The sidebar as a buffer, after LazyVim's explorer: a cursor over its rows
 * that keys move and act on, selections, jump labels and the native menus
 * of a tab or folder. The keys themselves reach it through the explorer
 * mode ("e") of the window's key engine.
 */
export class LazyvimiumExplorer {
  mode = "e";

  #window;
  #onChange;
  #open = false;
  /** @type {Element|null} The cursor row's element. */
  #cursor = null;
  #cursorIndex = 0;
  /** @type {Element|null} The button of the sidebar's foot the cursor is on. */
  #footer = null;
  #footerIndex = 0;
  /** @type {Element|null} Where visual mode started. */
  #anchor = null;
  /** @type {Set<Element>} Rows picked with <Tab>. */
  #picked = new Set();
  /** @type {Element[]} Elements carrying the cursor or selection. */
  #marked = [];
  #focusSink = null;
  #controller = null;
  #renaming = null;
  /** @type {LazyvimiumHints|null} */
  #hints = null;
  /** @type {Set<Element>} Popups open in the window. */
  #popups = new Set();

  /**
   * @param {Window} window A browser window.
   * @param {object} options
   * @param {() => void} options.onChange Called when the explorer opens,
   *   closes or enters or leaves visual mode.
   */
  constructor(window, { onChange }) {
    this.#window = window;
    this.#onChange = onChange;
  }

  get isOpen() {
    return this.#open;
  }

  get visual() {
    return this.#anchor !== null;
  }

  get #sidebar() {
    return (
      this.#window.gZenCompactModeManager?.sidebar ??
      this.#window.document.getElementById("navigator-toolbox")
    );
  }

  /**
   * Show the sidebar, if compact mode hides it, and put the cursor on the
   * current tab.
   */
  open() {
    if (this.#open) {
      return;
    }
    const window = this.#window;
    this.#open = true;
    this.#showSidebar();
    window.document.documentElement.setAttribute("lazyvimium-explorer", "true");

    this.#controller = new window.AbortController();
    const options = { capture: true, signal: this.#controller.signal };
    window.addEventListener(
      "mousedown",
      event => {
        const target = event.target;
        if (
          !this.#sidebar.contains(target) &&
          !target.closest?.("menupopup, panel, #lazyvimium-picker")
        ) {
          this.close();
        }
      },
      options
    );
    // A click in the page closes the explorer above; focus that moves to the
    // page without one comes from switching tabs, and keys stay here.
    window.addEventListener(
      "focusin",
      event => {
        if (event.target.localName == "browser") {
          window.setTimeout(() => this.#open && this.#focus(), 0);
        }
      },
      options
    );
    window.addEventListener(
      "popupshown",
      event => {
        if (event.target.localName != "tooltip") {
          this.#popups.add(event.target);
        }
      },
      options
    );
    window.addEventListener(
      "popuphidden",
      event => this.#popups.delete(event.target),
      options
    );
    window.gBrowser.tabContainer.addEventListener(
      "TabSelect",
      () => this.#followSelectedTab(),
      { signal: this.#controller.signal }
    );
    // Renaming a tab or folder types into a field in the sidebar; the keys
    // come back to the explorer once it is gone.
    this.#renaming = new window.MutationObserver(() => {
      if (!this.#isRenaming) {
        this.refresh();
        this.#focus();
      }
    });
    this.#renaming.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ["zen-renaming-tab"],
    });

    this.#followSelectedTab();
    this.#focus();
    this.#onChange();
  }

  close() {
    if (!this.#open) {
      return;
    }
    const window = this.#window;
    this.#open = false;
    this.#hints?.finish(null);
    this.#controller.abort();
    this.#renaming.disconnect();
    this.#popups.clear();
    this.#leaveFooter();
    this.#anchor = null;
    this.#picked.clear();
    this.#unmark();
    window.document.documentElement.removeAttribute("lazyvimium-explorer");
    this.#hideSidebar();
    if (this.#focusSink?.contains(window.document.activeElement)) {
      window.gBrowser.selectedBrowser.focus();
    }
    this.#focusSink?.remove();
    this.#focusSink = null;
    this.#onChange();
  }

  /**
   * Run a task that needs the sidebar on screen, opening the explorer for
   * it when it is closed and closing it again afterwards.
   *
   * @param {(explorer: LazyvimiumExplorer) => Promise<*>|*} task
   * @returns {Promise<*>}
   */
  async withSidebar(task) {
    const transient = !this.#open;
    if (transient) {
      this.open();
      await this.#settle();
    }
    try {
      return await task(this);
    } finally {
      if (transient) {
        this.close();
      }
    }
  }

  /**
   * Who a key belongs to while the explorer is open.
   *
   * @param {KeyboardEvent} event
   * @returns {"explorer"|"handled"|"other"} "explorer" for the key engine,
   *   "handled" when jump labels took it, "other" when a field, picker or
   *   popup should get it.
   */
  routeKey(event) {
    if (this.#hints && !this.#hints.done) {
      this.#hints.handleKey(event);
      return "handled";
    }
    const document = this.#window.document;
    if (
      this.#isRenaming ||
      this.#popups.size ||
      document.getElementById("lazyvimium-picker") ||
      LazyvimiumDom.isEditable(LazyvimiumDom.deepActiveElement(document))
    ) {
      return "other";
    }
    return "explorer";
  }

  /**
   * @returns {LazyvimiumExplorerRow|null} The row under the cursor, none
   *   while it is on the sidebar's foot.
   */
  get row() {
    if (this.#footer) {
      return null;
    }
    const rows = this.rows();
    return rows[this.#index(rows)] ?? null;
  }

  /** @returns {boolean} Whether the cursor is on the sidebar's foot. */
  get onFooter() {
    return !!this.#footer;
  }

  /**
   * The buttons at the foot of the sidebar, left to right: the library,
   * the spaces and the + menu, below the last row.
   *
   * @returns {Element[]}
   */
  footerButtons() {
    const footer = this.#window.document.getElementById(
      "zen-sidebar-foot-buttons"
    );
    return [...(footer?.querySelectorAll("toolbarbutton") ?? [])]
      .filter(button => {
        const rect = button.getBoundingClientRect();
        return (
          button.checkVisibility({ visibilityProperty: true }) &&
          rect.width > 0 &&
          rect.height > 0
        );
      })
      .sort(
        (a, b) =>
          a.getBoundingClientRect().left - b.getBoundingClientRect().left
      );
  }

  /** @returns {Element|null} The foot's button under the cursor. */
  get footerButton() {
    return this.#footer;
  }

  /**
   * @param {number} delta Buttons to move right, or left when negative.
   */
  moveOnFooter(delta) {
    const buttons = this.footerButtons();
    const index = buttons.indexOf(this.#footer);
    this.#setFooter(buttons, (index == -1 ? this.#footerIndex : index) + delta);
  }

  /**
   * Press the foot's button under the cursor, the way clicking it does.
   * The + button opens its menu, the library button the library.
   *
   * @returns {Promise<void>|undefined}
   */
  pressFooter() {
    const button = this.#footer;
    if (!button) {
      return undefined;
    }
    if (button.id == "zen-create-new-button") {
      return this.openCreateMenu();
    }
    if (button.hasAttribute("command") || button.hasAttribute("oncommand")) {
      button.doCommand();
    } else {
      button.click();
    }
    return undefined;
  }

  /** @returns {LazyvimiumExplorerRow[]} */
  rows() {
    return explorerRows(this.#window);
  }

  /**
   * The tabs an operation applies to: the selection, or the cursor's row.
   *
   * @returns {Element[]}
   */
  targets() {
    if (this.#footer) {
      return [];
    }
    const rows = this.rows();
    const picked = this.#selectedRows(rows);
    const chosen = picked.length ? picked : [rows[this.#index(rows)]];
    return [...new Set(chosen.filter(Boolean).flatMap(row => row.tabs))];
  }

  /**
   * Moving down past the last row reaches the buttons at the sidebar's
   * foot, and moving up from them goes back to the rows.
   *
   * @param {number} delta Rows to move down, or up when negative.
   */
  move(delta) {
    const rows = this.rows();
    if (this.#footer) {
      if (delta < 0) {
        this.#setCursor(rows, rows.length + delta);
      }
      return;
    }
    const index = this.#index(rows) + delta;
    if (delta > 0 && index >= rows.length && this.#enterFooter()) {
      return;
    }
    this.#setCursor(rows, index);
  }

  /**
   * @param {number} index A row index; negative counts from the end.
   */
  moveTo(index) {
    const rows = this.rows();
    this.#setCursor(rows, index < 0 ? rows.length + index : index);
  }

  /**
   * Move half the sidebar's height, as <C-d> and <C-u> do.
   *
   * @param {1|-1} direction
   */
  moveHalfPage(direction) {
    const row = this.row;
    const height = row ? highlightOf(row)[0].getBoundingClientRect().height : 0;
    const visible = height ? this.#sidebar.clientHeight / height : 16;
    this.move(direction * Math.max(1, Math.floor(visible / 2)));
  }

  /**
   * Put the cursor on a row's element.
   *
   * @param {Element} element
   */
  moveToElement(element) {
    const rows = this.rows();
    const index = rows.findIndex(row => row.element == element);
    if (index != -1) {
      this.#setCursor(rows, index);
    }
  }

  /**
   * Bring the cursor and selection back in line with the sidebar after tabs
   * moved, opened or closed.
   */
  refresh() {
    if (!this.#open) {
      return;
    }
    if (this.#footer) {
      this.moveOnFooter(0);
      return;
    }
    const rows = this.rows();
    this.#setCursor(rows, this.#index(rows));
  }

  toggleVisual() {
    if (this.#footer) {
      return;
    }
    this.#anchor = this.#anchor ? null : this.#cursor;
    this.refresh();
    this.#onChange();
  }

  togglePicked() {
    if (!this.#cursor || this.#footer) {
      return;
    }
    if (!this.#picked.delete(this.#cursor)) {
      this.#picked.add(this.#cursor);
    }
    this.move(1);
  }

  /**
   * Drop the selection and leave visual mode.
   *
   * @returns {boolean} Whether there was anything to drop.
   */
  clearSelection() {
    const had = this.#anchor !== null || this.#picked.size > 0;
    this.#anchor = null;
    this.#picked.clear();
    this.refresh();
    if (had) {
      this.#onChange();
    }
    return had;
  }

  /**
   * Label every row on screen, flash.nvim style, and wait for one to be
   * typed.
   *
   * @returns {Promise<LazyvimiumExplorerRow|null>}
   */
  async pickRow() {
    this.#hints?.finish(null);
    const rows = this.rows().filter(row => isOnScreen(hintHostOf(row)));
    const hints = new LazyvimiumHints(rows.map(hintHostOf));
    this.#hints = hints;
    const index = await hints.picked;
    if (this.#hints == hints) {
      this.#hints = null;
    }
    return index === null ? null : rows[index];
  }

  /**
   * Open the native menu of a row: the tab context menu, or a folder's.
   *
   * @param {LazyvimiumExplorerRow} row
   * @returns {Promise<void>} Resolves once the menu is closed.
   */
  openMenu(row) {
    const window = this.#window;
    const document = window.document;
    let popup, anchor, trigger;
    if (row.kind == "folder") {
      popup = document.getElementById("zenFolderActions");
      anchor = row.element.labelContainerElement;
      trigger = row.element.labelElement;
    } else {
      popup = document.getElementById("tabContextMenu");
      anchor = trigger = row.tabs[0];
    }
    // The menus find their tab or folder through the node that triggered
    // them, which only an event carries.
    const triggerEvent = new window.CustomEvent("LazyvimiumMenu");
    trigger.dispatchEvent(triggerEvent);
    const { promise, resolve } = Promise.withResolvers();
    const onHidden = event => {
      if (event.target == popup) {
        popup.removeEventListener("popuphidden", onHidden);
        // The picked item's command runs after the menu hides.
        window.setTimeout(resolve, 0);
      }
    };
    popup.addEventListener("popuphidden", onHidden);
    popup.openPopup(anchor, {
      position: "after_start",
      isContextMenu: true,
      triggerEvent,
    });
    return promise;
  }

  /**
   * Open the menu of the + button at the foot of the sidebar: new space,
   * folder, split or tab.
   *
   * @returns {Promise<void>} Resolves once the menu is closed.
   */
  openCreateMenu() {
    const window = this.#window;
    const document = window.document;
    const button = document.getElementById("zen-create-new-button");
    const popup = document.getElementById("zenCreateNewPopup");
    if (!button?.checkVisibility() || !popup) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers();
    const onHidden = event => {
      if (event.target == popup) {
        popup.removeEventListener("popuphidden", onHidden);
        window.setTimeout(resolve, 0);
      }
    };
    popup.addEventListener("popuphidden", onHidden);
    popup.openPopup(button, "before_start", 0, 0, true);
    return promise;
  }

  /**
   * Rename a tab or folder in place, the way double-clicking it does.
   *
   * @param {LazyvimiumExplorerRow} row
   * @returns {Promise<void>} Resolves once the name is set or dropped.
   */
  rename(row) {
    const window = this.#window;
    if (row.kind == "folder") {
      row.element.rename();
    } else if (row.kind == "tab") {
      window.gZenTabRenamer.start({ target: row.element, explicit: true });
    }
    return this.whenRenamed();
  }

  /**
   * @returns {Promise<void>} Resolves when no tab or folder is being
   *   renamed.
   */
  whenRenamed() {
    const window = this.#window;
    if (!this.#isRenaming) {
      return Promise.resolve();
    }
    const { promise, resolve } = Promise.withResolvers();
    const observer = new window.MutationObserver(() => {
      if (!this.#isRenaming) {
        observer.disconnect();
        resolve();
      }
    });
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ["zen-renaming-tab"],
    });
    return promise;
  }

  /**
   * Wait for a panel a command is about to open, like the space icon
   * picker, and then for it to close again.
   *
   * @returns {Promise<void>}
   */
  async whenPopupsClosed() {
    const window = this.#window;
    for (let tries = 0; tries < 20 && !this.#popups.size; tries++) {
      await new Promise(resolve => window.setTimeout(resolve, 25));
    }
    while (this.#open && this.#popups.size) {
      await new Promise(resolve =>
        window.addEventListener("popuphidden", resolve, { once: true })
      );
    }
  }

  get #isRenaming() {
    return (
      this.#window.document.documentElement.getAttribute("zen-renaming-tab") ==
      "true"
    );
  }

  // A space picked on the sidebar's foot switches tabs; the cursor stays on
  // the foot.
  #followSelectedTab() {
    if (this.#footer) {
      this.moveOnFooter(0);
      return;
    }
    const rows = this.rows();
    const selected = this.#window.gBrowser.selectedTab;
    const index = rows.findIndex(row => row.tabs.includes(selected));
    this.#setCursor(rows, index == -1 ? this.#index(rows) : index);
  }

  #index(rows) {
    const index = rows.findIndex(row => row.element == this.#cursor);
    return index == -1 ? Math.min(this.#cursorIndex, rows.length - 1) : index;
  }

  #setCursor(rows, index) {
    this.#leaveFooter();
    if (!rows.length) {
      this.#cursor = null;
      this.#unmark();
      return;
    }
    this.#cursorIndex = Math.max(0, Math.min(index, rows.length - 1));
    const row = rows[this.#cursorIndex];
    this.#cursor = row.element;
    this.#mark(rows);
    highlightOf(row)[0]?.scrollIntoView({ block: "nearest" });
  }

  // Not in visual mode: a selection is of rows.
  #enterFooter() {
    const buttons = this.footerButtons();
    if (!buttons.length || this.#anchor) {
      return false;
    }
    this.#unmark();
    this.#setFooter(buttons, this.#footerIndex);
    return true;
  }

  #setFooter(buttons, index) {
    this.#footer?.removeAttribute("lazyvimium-cursor");
    if (!buttons.length) {
      this.#footer = null;
      this.refresh();
      return;
    }
    this.#footerIndex = Math.max(0, Math.min(index, buttons.length - 1));
    this.#footer = buttons[this.#footerIndex];
    this.#footer.setAttribute("lazyvimium-cursor", "true");
  }

  #leaveFooter() {
    this.#footer?.removeAttribute("lazyvimium-cursor");
    this.#footer = null;
  }

  #selectedRows(rows) {
    const selected = new Set(rows.filter(row => this.#picked.has(row.element)));
    const from = rows.findIndex(row => row.element == this.#anchor);
    if (from != -1) {
      const to = this.#index(rows);
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
        selected.add(rows[i]);
      }
    }
    return [...selected];
  }

  #mark(rows) {
    this.#unmark();
    const selected = this.#selectedRows(rows);
    for (const row of rows) {
      const isCursor = row.element == this.#cursor;
      const isSelected = selected.includes(row);
      if (!isCursor && !isSelected) {
        continue;
      }
      for (const element of highlightOf(row)) {
        element.toggleAttribute("lazyvimium-cursor", isCursor);
        element.toggleAttribute("lazyvimium-selected", isSelected);
        this.#marked.push(element);
      }
    }
  }

  #unmark() {
    for (const element of this.#marked) {
      element.removeAttribute("lazyvimium-cursor");
      element.removeAttribute("lazyvimium-selected");
    }
    this.#marked = [];
  }

  // Keys typed while the explorer is open go to a focusable spot in the
  // sidebar, out of the page and away from the browser's own tab strip
  // keys.
  #focus() {
    const document = this.#window.document;
    if (!this.#focusSink) {
      this.#focusSink = document.createElementNS(HTML_NS, "div");
      this.#focusSink.id = "lazyvimium-explorer-focus";
      this.#focusSink.tabIndex = -1;
      this.#focusSink.setAttribute("role", "tree");
      this.#focusSink.setAttribute("aria-label", "Explorer");
      this.#sidebar.append(this.#focusSink);
    }
    this.#focusSink.focus();
  }

  #showSidebar() {
    const compact = this.#window.gZenCompactModeManager;
    if (compact?.preference && !compact.isSidebarPotentiallyOpen()) {
      // The attribute hovering the screen edge sets, with its slide in.
      compact.sidebar.setAttribute("zen-user-show", "true");
    }
  }

  // Slide the compact sidebar out, the way leaving it with the mouse does.
  // Zen keeps it shown on the empty tab (zen-has-empty-tab); closing the
  // explorer wins over that until the next tab change sets it again.
  #hideSidebar() {
    const compact = this.#window.gZenCompactModeManager;
    if (!compact?.preference || !compact.canHideSidebar) {
      return;
    }
    const sidebar = compact.sidebar;
    sidebar.removeAttribute("zen-user-show");
    sidebar.removeAttribute("zen-has-empty-tab");
    if (sidebar.hasAttribute("zen-has-hover")) {
      compact._setElementExpandAttribute(sidebar, false);
    }
  }

  // Wait for the sidebar to finish sliding in, so labels and menus land
  // where its rows end up.
  async #settle() {
    const window = this.#window;
    let last = null;
    for (let frame = 0; frame < 30; frame++) {
      await new Promise(resolve => window.requestAnimationFrame(resolve));
      const { x, y } = this.#sidebar.getBoundingClientRect();
      if (last?.x == x && last?.y == y) {
        return;
      }
      last = { x, y };
    }
  }
}
