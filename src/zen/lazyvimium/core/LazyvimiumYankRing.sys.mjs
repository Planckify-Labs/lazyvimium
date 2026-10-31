// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The yank ring: the last things yanked, newest first, with the same text
// kept once.

/** Longer texts are not kept, so the ring stays small. */
export const MAX_YANK_LENGTH = 100_000;

const DEFAULT_LENGTH = 100;

/**
 * @typedef {object} LazyvimiumYank
 * @property {string} text What was yanked.
 * @property {string} [url] The page it came from.
 * @property {string} [title] Its title.
 * @property {number} time Milliseconds since the epoch.
 */

export class LazyvimiumYankRing {
  #entries;
  #length;
  #onChange;

  /**
   * @param {object} [options]
   * @param {number} [options.length] How many yanks to keep.
   * @param {LazyvimiumYank[]} [options.entries] Yanks to start with.
   * @param {(ring: LazyvimiumYankRing) => void} [options.onChange]
   */
  constructor({ length = DEFAULT_LENGTH, entries = [], onChange } = {}) {
    this.#length = length;
    this.#onChange = onChange;
    this.#entries = entries
      .filter(entry => LazyvimiumYankRing.#valid(entry?.text))
      .slice(0, length)
      .map(entry => ({ ...entry }));
  }

  static #valid(text) {
    return (
      typeof text == "string" && !!text.trim() && text.length <= MAX_YANK_LENGTH
    );
  }

  /** @returns {LazyvimiumYank[]} Newest first. */
  get entries() {
    return this.#entries.map(entry => ({ ...entry }));
  }

  get length() {
    return this.#entries.length;
  }

  /**
   * @param {number} index 0 is the newest.
   * @returns {LazyvimiumYank|null}
   */
  at(index) {
    const entry = this.#entries[index];
    return entry ? { ...entry } : null;
  }

  /**
   * Yank a text. One that is already in the ring moves to the front.
   *
   * @param {string} text
   * @param {{url?: string, title?: string, time?: number}} [from]
   * @returns {boolean} Whether the ring changed.
   */
  add(text, { url, title, time = Date.now() } = {}) {
    if (!LazyvimiumYankRing.#valid(text)) {
      return false;
    }
    if (this.#entries[0]?.text == text) {
      return false;
    }
    this.#entries = [
      { text, url, title, time },
      ...this.#entries.filter(entry => entry.text != text),
    ].slice(0, this.#length);
    this.#onChange?.(this);
    return true;
  }

  clear() {
    if (this.#entries.length) {
      this.#entries = [];
      this.#onChange?.(this);
    }
  }
}
