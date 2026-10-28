// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const HTML_NS = "http://www.w3.org/1999/xhtml";

// Hint labels, flash.nvim style. j and k move the selection instead.
const LABELS = "asdfghlqweruiopzxcvbnmty";

/**
 * @typedef {object} LazyvimiumPickerItem
 * @property {string} label What the item is called.
 * @property {string} [detail] Shown dimmed after the label.
 * @property {string} [icon] An image URL.
 * @property {string} [key] The key that picks it; one is assigned otherwise.
 */

/**
 * A floating list to pick from with the keyboard, LazyVim's picker in the
 * browser window. It takes focus while open, so keys never reach the page.
 */
export class LazyvimiumPicker {
  /** @type {WeakMap<Document, LazyvimiumPicker>} */
  static #open = new WeakMap();

  /**
   * @param {Window} window A browser window.
   * @param {object} options
   * @param {string} options.title
   * @param {LazyvimiumPickerItem[]} options.items
   * @returns {Promise<number|null>} The index of the picked item, or null
   *   when the picker was dismissed.
   */
  static open(window, { title, items }) {
    LazyvimiumPicker.#open.get(window.document)?.close(null);
    const picker = new LazyvimiumPicker(window, title, items);
    LazyvimiumPicker.#open.set(window.document, picker);
    return picker.#result.promise;
  }

  /**
   * @param {Document} document
   * @returns {boolean}
   */
  static isOpen(document) {
    return LazyvimiumPicker.#open.has(document);
  }

  #window;
  #root;
  #rows = [];
  #keys = [];
  #selected = 0;
  #result = Promise.withResolvers();
  #previousFocus;

  constructor(window, title, items) {
    this.#window = window;
    const document = window.document;
    const create = (tag, className) => {
      const element = document.createElementNS(HTML_NS, tag);
      if (className) {
        element.className = className;
      }
      return element;
    };

    this.#root = create("div");
    this.#root.id = "lazyvimium-picker";
    this.#root.setAttribute("role", "dialog");
    this.#root.setAttribute("aria-label", title);
    this.#root.tabIndex = -1;

    const heading = create("div", "lazyvimium-picker-title");
    heading.textContent = title;
    const list = create("div", "lazyvimium-picker-list");
    list.setAttribute("role", "listbox");

    const reserved = new Set(items.map(item => item.key).filter(Boolean));
    const free = [...LABELS].filter(label => !reserved.has(label));
    items.forEach((item, index) => {
      const key = item.key ?? free.shift() ?? "";
      this.#keys.push(key);
      const row = create("div", "lazyvimium-picker-item");
      row.setAttribute("role", "option");
      const kbd = create("kbd", "lazyvimium-picker-key");
      kbd.textContent = key;
      row.append(kbd);
      if (item.icon) {
        const icon = create("img", "lazyvimium-picker-icon");
        icon.src = item.icon;
        icon.alt = "";
        row.append(icon);
      }
      const label = create("span", "lazyvimium-picker-label");
      label.textContent = item.label;
      row.append(label);
      if (item.detail) {
        const detail = create("span", "lazyvimium-picker-detail");
        detail.textContent = item.detail;
        row.append(detail);
      }
      row.addEventListener("click", () => this.close(index));
      list.append(row);
      this.#rows.push(row);
    });

    const help = create("div", "lazyvimium-picker-help");
    help.textContent = "j/k move · Enter pick · label picks · Esc cancel";

    this.#root.append(heading, list, help);
    this.#root.addEventListener("keydown", this, true);
    window.addEventListener("mousedown", this, true);
    (document.getElementById("browser") ?? document.documentElement).append(
      this.#root
    );
    this.#select(0);
    this.#previousFocus = Services.focus.focusedElement;
    this.#root.focus();
  }

  handleEvent(event) {
    if (event.type == "mousedown") {
      if (!this.#root.contains(event.target)) {
        this.close(null);
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const { key, ctrlKey } = event;
    if (key == "Escape" || (ctrlKey && (key == "c" || key == "["))) {
      this.close(null);
    } else if (key == "Enter") {
      this.close(this.#selected);
    } else if (key == "j" || key == "ArrowDown" || (ctrlKey && key == "n")) {
      this.#select(this.#selected + 1);
    } else if (key == "k" || key == "ArrowUp" || (ctrlKey && key == "p")) {
      this.#select(this.#selected - 1);
    } else if (!ctrlKey && !event.altKey && !event.metaKey) {
      const index = this.#keys.indexOf(key);
      if (index != -1) {
        this.close(index);
      }
    }
  }

  /**
   * @param {number|null} index
   */
  close(index) {
    if (LazyvimiumPicker.#open.get(this.#window.document) !== this) {
      return;
    }
    LazyvimiumPicker.#open.delete(this.#window.document);
    this.#window.removeEventListener("mousedown", this, true);
    this.#root.remove();
    this.#previousFocus?.focus?.();
    this.#result.resolve(index);
  }

  #select(index) {
    if (!this.#rows.length) {
      return;
    }
    this.#rows[this.#selected]?.removeAttribute("selected");
    this.#rows[this.#selected]?.setAttribute("aria-selected", "false");
    this.#selected = (index + this.#rows.length) % this.#rows.length;
    const row = this.#rows[this.#selected];
    row.setAttribute("selected", "");
    row.setAttribute("aria-selected", "true");
    row.scrollIntoView({ block: "nearest" });
  }
}
