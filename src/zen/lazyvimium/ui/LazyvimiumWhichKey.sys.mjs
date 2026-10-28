// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// A port of folke/which-key.nvim's popup as LazyVim configures it (the
// "helix" preset): after a prefix, list what each next key does.

const HTML_NS = "http://www.w3.org/1999/xhtml";

const KEY_LABELS = {
  "<Space>": "SPC",
  "<Tab>": "TAB",
  "<CR>": "RET",
  "<Esc>": "ESC",
  "<BS>": "BS",
  "<lt>": "<",
};

/**
 * @param {string} token
 * @returns {string}
 */
export function formatKey(token) {
  return KEY_LABELS[token] ?? token;
}

// which-key's default sort ("group", "alphanum", "mod", then "natural" and
// "case"): mappings before groups, word keys before symbols, bracketed keys
// before bare symbols, numbers compared by value, lowercase first.
const SORT_FIELDS = [
  item => (item.group ? 1 : 0),
  item => (/^\w+$/.test(item.key) ? 0 : 1),
  item => (/^<.*>$/.test(item.key) ? 0 : 1),
  item =>
    item.key.replace(/\d+/g, digits => digits.padStart(9, "0")).toLowerCase(),
  item => (item.key.toLowerCase() == item.key ? 0 : 1),
];

/**
 * @param {{key: string, group: boolean}[]} items
 * @returns {object[]} The same array, sorted.
 */
export function sortItems(items) {
  return items.sort((a, b) => {
    for (const field of SORT_FIELDS) {
      const x = field(a);
      const y = field(b);
      if (x != y) {
        return x < y ? -1 : 1;
      }
    }
    return a.key < b.key ? -1 : Number(a.key > b.key);
  });
}

function countMappings(node) {
  let count = node.value ? 1 : 0;
  for (const child of node.children.values()) {
    count += countMappings(child);
  }
  return count;
}

/**
 * What each key after a prefix does.
 *
 * @param {import("resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs").LazyvimiumKeymap} keymap
 * @param {string} mode
 * @param {string[]} tokens The prefix; empty for every key of the mode.
 * @returns {{key: string, label: string, desc: string, group: boolean}[]|null}
 *   null when nothing is mapped under the prefix.
 */
export function whichKeyItems(keymap, mode, tokens) {
  const node = keymap.trie(mode).node(tokens);
  if (!node?.children.size) {
    return null;
  }
  const items = [];
  for (const [token, child] of node.children) {
    const group = child.children.size > 0;
    let desc;
    if (group) {
      const count = countMappings(child);
      desc =
        keymap.groupName(mode, [...tokens, token]) ??
        child.value?.desc ??
        `${count} keymap${count == 1 ? "" : "s"}`;
    } else {
      desc = child.value?.desc ?? String(child.value?.rhs ?? "");
    }
    items.push({ key: token, label: formatKey(token), desc, group });
  }
  return sortItems(items);
}

/**
 * The popup title: the keys typed so far and the group they open.
 *
 * @param {import("resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs").LazyvimiumKeymap} keymap
 * @param {string} mode
 * @param {string[]} tokens
 * @returns {string}
 */
export function breadcrumb(keymap, mode, tokens) {
  const trail = tokens.map(formatKey).join(" » ");
  const group = keymap.groupName(mode, tokens);
  return group ? `${trail} +${group}` : trail;
}

/**
 * The popup in one browser window.
 */
export class LazyvimiumWhichKey {
  #window;
  #root;
  #title;
  #list;
  #timer = null;
  #pinned = false;

  /**
   * @param {Window} window A browser window.
   */
  constructor(window) {
    this.#window = window;
    const document = window.document;
    const create = (tag, className) => {
      const element = document.createElementNS(HTML_NS, tag);
      element.className = className;
      return element;
    };
    this.#root = create("div", "");
    this.#root.id = "lazyvimium-which-key";
    this.#root.setAttribute("role", "tooltip");
    this.#root.hidden = true;
    this.#title = create("div", "lazyvimium-which-key-title");
    this.#list = create("div", "lazyvimium-which-key-list");
    const help = create("div", "lazyvimium-which-key-help");
    help.textContent = "ESC close · BS back";
    this.#root.append(this.#title, this.#list, help);
    (document.getElementById("browser") ?? document.documentElement).append(
      this.#root
    );
  }

  get visible() {
    return !this.#root.hidden;
  }

  /**
   * Whether the popup shows every key (`<leader>?`) until the next key.
   *
   * @returns {boolean}
   */
  get pinned() {
    return this.#pinned;
  }

  /**
   * Follow the selected page's pending keys: show after `delay`, update
   * right away while shown, hide when nothing is pending.
   *
   * @param {{mode: string, tokens: string[]}} state
   * @param {object} keymap
   * @param {number} delay In milliseconds.
   */
  update(state, keymap, delay) {
    if (!state.tokens?.length) {
      if (!this.#pinned) {
        this.hide();
      }
      return;
    }
    this.#pinned = false;
    const render = () => {
      this.#timer = null;
      const items = whichKeyItems(keymap, state.mode, state.tokens);
      if (items) {
        this.#render(breadcrumb(keymap, state.mode, state.tokens), items);
      } else {
        this.hide();
      }
    };
    this.#cancelTimer();
    if (this.visible || delay <= 0) {
      render();
    } else {
      this.#timer = this.#window.setTimeout(render, delay);
    }
  }

  /**
   * Show every key of a mode until the next key is pressed, for `<leader>?`.
   *
   * @param {object} keymap
   * @param {string} mode
   */
  showAll(keymap, mode) {
    this.#cancelTimer();
    const items = whichKeyItems(keymap, mode, []);
    if (items) {
      this.#pinned = true;
      this.#render("Keymaps", items);
    }
  }

  hide() {
    this.#cancelTimer();
    this.#pinned = false;
    this.#root.hidden = true;
  }

  destroy() {
    this.hide();
    this.#root.remove();
  }

  #render(title, items) {
    const document = this.#window.document;
    this.#title.textContent = title;
    const rows = items.map(({ label, desc, group }) => {
      const row = document.createElementNS(HTML_NS, "div");
      row.className = "lazyvimium-which-key-item";
      const key = document.createElementNS(HTML_NS, "kbd");
      key.className = "lazyvimium-which-key-key";
      key.textContent = label;
      const separator = document.createElementNS(HTML_NS, "span");
      separator.className = "lazyvimium-which-key-separator";
      separator.textContent = "➜";
      const description = document.createElementNS(HTML_NS, "span");
      description.className = "lazyvimium-which-key-desc";
      description.textContent = group ? `+${desc}` : desc;
      if (group) {
        row.setAttribute("group", "");
      }
      row.append(key, separator, description);
      return row;
    });
    this.#list.replaceChildren(...rows);
    this.#root.hidden = false;
  }

  #cancelTimer() {
    if (this.#timer !== null) {
      this.#window.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
