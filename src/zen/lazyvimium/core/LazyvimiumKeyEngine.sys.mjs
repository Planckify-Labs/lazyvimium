// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

// vim's default 'timeoutlen'.
const DEFAULT_TIMEOUTLEN = 1000;

/**
 * @typedef {object} LazyvimiumModeOptions
 * @property {boolean} [counts] Whether digits typed before a mapping are a
 *   count ("5j").
 * @property {boolean} [passUnmapped] Whether a key that starts no mapping is
 *   left to the page. When false the engine swallows it.
 */

/**
 * @typedef {object} LazyvimiumMatch
 * @property {import("resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs").LazyvimiumMapping} mapping
 *   The mapping that matched.
 * @property {number|null} count The typed count, or null when none was given.
 * @property {string} mode The mode the mapping was matched in.
 */

/**
 * Turns a stream of key tokens into mapping matches: modes, counts,
 * multi-key sequences and 'timeoutlen'. It holds no DOM or window state, so
 * the same engine runs in a content process (keys typed in a page) and in
 * the parent (keys typed in the browser UI).
 *
 * feed() answers synchronously whether the key was used, which is what a
 * keydown listener needs to decide on preventDefault().
 */
export class LazyvimiumKeyEngine {
  #keymap;
  #onMatch;
  #onStateChange;
  #timeoutlen;
  #timers;
  /** @type {Map<string, Required<LazyvimiumModeOptions>>} */
  #modes = new Map();
  #mode = "n";
  /** @type {string[]} */
  #pending = [];
  #count = "";
  #timer = null;
  #waitForPrefix;

  /**
   * @param {object} options
   * @param {import("resource:///modules/lazyvimium/core/LazyvimiumKeymap.sys.mjs").LazyvimiumKeymap} options.keymap
   * @param {(match: LazyvimiumMatch) => void} options.onMatch
   * @param {(engine: LazyvimiumKeyEngine) => void} [options.onStateChange]
   *   Called when the mode, the pending keys or the count change.
   * @param {number} [options.timeoutlen]
   * @param {boolean} [options.waitForPrefix] Wait for the next key without
   *   a timeout after a prefix that is not a mapping itself, the way
   *   which-key does. 'timeoutlen' then only settles ambiguous sequences.
   * @param {{setTimeout: Function, clearTimeout: Function}} [options.timers]
   */
  constructor({
    keymap,
    onMatch,
    onStateChange,
    timeoutlen = DEFAULT_TIMEOUTLEN,
    waitForPrefix = false,
    timers,
  }) {
    this.#keymap = keymap;
    this.#onMatch = onMatch;
    this.#onStateChange = onStateChange;
    this.#timeoutlen = timeoutlen;
    this.#waitForPrefix = waitForPrefix;
    this.#timers = timers ?? {
      setTimeout: (...args) => lazy.setTimeout(...args),
      clearTimeout: id => lazy.clearTimeout(id),
    };
    this.defineMode("n", { counts: true, passUnmapped: true });
    this.defineMode("i", { counts: false, passUnmapped: true });
    this.defineMode("v", { counts: true, passUnmapped: false });
  }

  /**
   * Add a mode or change how an existing one treats counts and unmapped keys.
   *
   * @param {string} name
   * @param {LazyvimiumModeOptions} [options]
   */
  defineMode(name, { counts = false, passUnmapped = true } = {}) {
    this.#modes.set(name, { counts, passUnmapped });
  }

  get mode() {
    return this.#mode;
  }

  /**
   * Switch modes. Anything half typed is dropped.
   *
   * @param {string} name
   */
  setMode(name) {
    if (!this.#modes.has(name)) {
      throw new Error(`Lazyvimium: unknown mode "${name}"`);
    }
    if (name == this.#mode) {
      return;
    }
    this.#mode = name;
    this.#clear();
    this.#notify();
  }

  get timeoutlen() {
    return this.#timeoutlen;
  }

  set timeoutlen(value) {
    this.#timeoutlen = value;
  }

  /**
   * What has been typed towards a mapping so far, for which-key and the mode
   * indicator.
   *
   * @returns {{tokens: string[], count: number|null, group: string|null}}
   */
  get pending() {
    return {
      tokens: [...this.#pending],
      count: this.#count ? Number(this.#count) : null,
      group: this.#pending.length
        ? this.#keymap.groupName(this.#mode, this.#pending)
        : null,
    };
  }

  /**
   * Feed one key.
   *
   * @param {string|null} token A canonical token from LazyvimiumKeys.
   * @returns {boolean} Whether the engine used the key. A key that was not
   *   used belongs to the page.
   */
  feed(token) {
    if (!token) {
      return false;
    }
    const mode = this.#modes.get(this.#mode);

    if (token == "<Esc>" && (this.#pending.length || this.#count)) {
      // <Esc> abandons a half typed sequence or count, as in vim.
      this.#clear();
      this.#notify();
      return true;
    }

    if (token == "<BS>" && this.#pending.length) {
      // Back up one key, like <BS> in which-key.
      this.#pending = this.#pending.slice(0, -1);
      if (this.#pending.length) {
        this.#waitForNextKey(this.#keymap.trie(this.#mode).node(this.#pending));
      } else {
        this.#cancelTimer();
      }
      this.#notify();
      return true;
    }

    if (
      !this.#pending.length &&
      mode.counts &&
      LazyvimiumKeys.isCountDigit(token, this.#count != "")
    ) {
      this.#count += token;
      this.#notify();
      return true;
    }

    const trie = this.#keymap.trie(this.#mode);
    const sequence = [...this.#pending, token];
    const node = trie.node(sequence);

    if (!node) {
      if (this.#pending.length) {
        // The key does not continue the sequence. A complete shorter mapping
        // runs first, then the key starts over on its own.
        const fallback = trie.node(this.#pending)?.value;
        const count = this.#takeCount();
        this.#clear();
        if (fallback) {
          this.#match(fallback, count);
        } else {
          this.#notify();
        }
        return this.feed(token);
      }
      const hadCount = this.#count != "";
      this.#clear();
      if (hadCount) {
        this.#notify();
      }
      return !mode.passUnmapped;
    }

    if (!node.children.size) {
      const count = this.#takeCount();
      this.#clear();
      this.#match(node.value, count);
      return true;
    }

    this.#pending = sequence;
    this.#waitForNextKey(node);
    this.#notify();
    return true;
  }

  /**
   * A prefix of longer mappings, and maybe a mapping itself: wait for the
   * next key, or for 'timeoutlen' to pass.
   *
   * @param {object} node The trie node of the pending keys.
   */
  #waitForNextKey(node) {
    if (this.#waitForPrefix && !node?.value) {
      this.#cancelTimer();
    } else {
      this.#armTimer();
    }
  }

  /**
   * Drop anything half typed, e.g. when focus moves or the page navigates.
   */
  reset() {
    if (this.#pending.length || this.#count) {
      this.#clear();
      this.#notify();
    }
  }

  #armTimer() {
    this.#cancelTimer();
    this.#timer = this.#timers.setTimeout(
      () => this.#onTimeout(),
      this.#timeoutlen
    );
  }

  #cancelTimer() {
    if (this.#timer !== null) {
      this.#timers.clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #onTimeout() {
    this.#timer = null;
    const mapping = this.#keymap.trie(this.#mode).node(this.#pending)?.value;
    const count = this.#takeCount();
    this.#clear();
    if (mapping) {
      this.#match(mapping, count);
    } else {
      this.#notify();
    }
  }

  #takeCount() {
    const count = this.#count ? Number(this.#count) : null;
    this.#count = "";
    return count;
  }

  #clear() {
    this.#cancelTimer();
    this.#pending = [];
    this.#count = "";
  }

  #match(mapping, count) {
    this.#notify();
    try {
      this.#onMatch({ mapping, count, mode: this.#mode });
    } catch (e) {
      console.error(`Lazyvimium: mapping "${mapping.lhs}" failed`, e);
    }
  }

  #notify() {
    try {
      this.#onStateChange?.(this);
    } catch (e) {
      console.error("Lazyvimium: key state listener failed", e);
    }
  }
}
