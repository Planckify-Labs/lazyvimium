// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";

/**
 * @typedef {object} LazyvimiumMapping
 * @property {string} mode The mode the mapping applies in.
 * @property {string} lhs The sequence as written, e.g. "<leader>bd".
 * @property {string[]} tokens The parsed sequence, with <leader> expanded.
 * @property {string|Function} rhs An action id, or a function called with
 *   the action context.
 * @property {string} [desc] Shown by which-key and the keymap picker.
 * @property {string} [owner] The plugin that added the mapping.
 */

/**
 * A prefix tree over key tokens. Each node may hold a value (a complete
 * mapping) and children (longer mappings sharing the prefix).
 */
export class LazyvimiumKeyTrie {
  #root = { value: null, children: new Map() };

  /**
   * @param {string[]} tokens
   * @param {*} value
   */
  insert(tokens, value) {
    let node = this.#root;
    for (const token of tokens) {
      let child = node.children.get(token);
      if (!child) {
        child = { value: null, children: new Map() };
        node.children.set(token, child);
      }
      node = child;
    }
    node.value = value;
  }

  /**
   * The node reached by following tokens from the root.
   *
   * @param {string[]} tokens
   * @returns {{value: *, children: Map<string, object>}|null}
   */
  node(tokens) {
    let node = this.#root;
    for (const token of tokens) {
      node = node.children.get(token);
      if (!node) {
        return null;
      }
    }
    return node;
  }
}

/**
 * Mappings per mode, the equivalent of vim.keymap.set/del. Mode names are
 * free-form strings; the core uses vim's letters ("n", "i", "v") and plugins
 * may add their own (a hint mode, a command line).
 */
export class LazyvimiumKeymap {
  #leader;
  /** @type {Map<string, Map<string, LazyvimiumMapping>>} */
  #mappings = new Map();
  /** @type {Map<string, Map<string, {lhs: string, tokens: string[], name: string, owner?: string}>>} */
  #groups = new Map();
  /** @type {Map<string, LazyvimiumKeyTrie>} */
  #tries = new Map();

  /**
   * @param {object} [options]
   * @param {string} [options.leader]
   */
  constructor({ leader = LazyvimiumKeys.DEFAULT_LEADER } = {}) {
    this.#leader = leader;
  }

  get leader() {
    return this.#leader;
  }

  /**
   * Change the leader, re-parsing every mapping and group that uses it.
   *
   * @param {string} leader
   */
  setLeader(leader) {
    LazyvimiumKeys.parse(leader, { leader });
    this.#leader = leader;
    for (const store of [this.#mappings, this.#groups]) {
      for (const [mode, entries] of store) {
        const reparsed = new Map();
        for (const entry of entries.values()) {
          entry.tokens = this.#parse(entry.lhs);
          reparsed.set(LazyvimiumKeys.sequenceKey(entry.tokens), entry);
        }
        store.set(mode, reparsed);
      }
    }
    this.#tries.clear();
  }

  /**
   * Map a key sequence. A later mapping of the same sequence in the same mode
   * replaces the earlier one.
   *
   * @param {string|string[]} modes
   * @param {string} lhs
   * @param {string|Function} rhs
   * @param {object} [options]
   * @param {string} [options.desc]
   * @param {string} [options.owner]
   * @returns {LazyvimiumMapping[]}
   */
  set(modes, lhs, rhs, { desc, owner } = {}) {
    if (typeof rhs != "string" && typeof rhs != "function") {
      throw new Error(
        `Lazyvimium: the mapping for "${lhs}" needs an action id or a function`
      );
    }
    const tokens = this.#parse(lhs);
    return this.#modes(modes).map(mode => {
      const mapping = { mode, lhs, tokens, rhs, desc, owner };
      this.#store(this.#mappings, mode).set(
        LazyvimiumKeys.sequenceKey(tokens),
        mapping
      );
      this.#tries.delete(mode);
      return mapping;
    });
  }

  /**
   * Remove a mapping.
   *
   * @param {string|string[]} modes
   * @param {string} lhs
   */
  del(modes, lhs) {
    const key = LazyvimiumKeys.sequenceKey(this.#parse(lhs));
    for (const mode of this.#modes(modes)) {
      if (this.#mappings.get(mode)?.delete(key)) {
        this.#tries.delete(mode);
      }
    }
  }

  /**
   * @param {string} mode
   * @param {string} lhs
   * @returns {LazyvimiumMapping|null}
   */
  get(mode, lhs) {
    const key = LazyvimiumKeys.sequenceKey(this.#parse(lhs));
    return this.#mappings.get(mode)?.get(key) ?? null;
  }

  /**
   * @param {string} mode
   * @returns {LazyvimiumMapping[]}
   */
  list(mode) {
    return [...(this.#mappings.get(mode)?.values() ?? [])];
  }

  /**
   * @returns {string[]} Every mode that has mappings.
   */
  modes() {
    return [...this.#mappings.keys()].filter(
      mode => this.#mappings.get(mode).size
    );
  }

  /**
   * Whether any mode maps a sequence to this action id.
   *
   * @param {string} id
   * @returns {boolean}
   */
  maps(id) {
    for (const entries of this.#mappings.values()) {
      for (const mapping of entries.values()) {
        if (mapping.rhs === id) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Name a prefix for which-key, like LazyVim's `{ "<leader>b", group =
   * "buffer" }`.
   *
   * @param {string|string[]} modes
   * @param {string} lhs
   * @param {string} name
   * @param {object} [options]
   * @param {string} [options.owner]
   */
  group(modes, lhs, name, { owner } = {}) {
    const tokens = this.#parse(lhs);
    for (const mode of this.#modes(modes)) {
      this.#store(this.#groups, mode).set(LazyvimiumKeys.sequenceKey(tokens), {
        lhs,
        tokens,
        name,
        owner,
      });
    }
  }

  /**
   * @param {string} mode
   * @returns {{lhs: string, tokens: string[], name: string, owner?: string}[]}
   */
  groups(mode) {
    return [...(this.#groups.get(mode)?.values() ?? [])];
  }

  /**
   * @param {string} mode
   * @param {string[]} tokens
   * @returns {string|null} The group name for a pending prefix.
   */
  groupName(mode, tokens) {
    return (
      this.#groups.get(mode)?.get(LazyvimiumKeys.sequenceKey(tokens))?.name ??
      null
    );
  }

  /**
   * Remove every mapping and group a plugin added.
   *
   * @param {string} owner
   */
  removeOwner(owner) {
    for (const [mode, entries] of this.#mappings) {
      for (const [key, mapping] of entries) {
        if (mapping.owner == owner) {
          entries.delete(key);
          this.#tries.delete(mode);
        }
      }
    }
    for (const entries of this.#groups.values()) {
      for (const [key, group] of entries) {
        if (group.owner == owner) {
          entries.delete(key);
        }
      }
    }
  }

  /**
   * The lookup tree for a mode, rebuilt only after that mode changes.
   *
   * @param {string} mode
   * @returns {LazyvimiumKeyTrie}
   */
  trie(mode) {
    let trie = this.#tries.get(mode);
    if (!trie) {
      trie = new LazyvimiumKeyTrie();
      for (const mapping of this.list(mode)) {
        trie.insert(mapping.tokens, mapping);
      }
      this.#tries.set(mode, trie);
    }
    return trie;
  }

  #parse(lhs) {
    return LazyvimiumKeys.parse(lhs, { leader: this.#leader });
  }

  #modes(modes) {
    const list = Array.isArray(modes) ? modes : [modes];
    if (!list.length || list.some(mode => typeof mode != "string" || !mode)) {
      throw new Error("Lazyvimium: a mapping needs at least one mode");
    }
    return list;
  }

  #store(store, mode) {
    let entries = store.get(mode);
    if (!entries) {
      entries = new Map();
      store.set(mode, entries);
    }
    return entries;
  }
}
