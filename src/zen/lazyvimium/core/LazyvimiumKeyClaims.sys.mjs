// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Keys that something in a window takes before vim's keys do, like the labels
// over an extension's popup.
const gClaims = new WeakMap();

export const LazyvimiumKeyClaims = {
  /**
   * @param {Window} window
   * @param {(event: KeyboardEvent) => boolean} claims Whether the window's
   *   labels take a key.
   */
  set(window, claims) {
    gClaims.set(window, claims);
  },

  /**
   * @param {Window} window
   */
  delete(window) {
    gClaims.delete(window);
  },

  /**
   * @param {Window|null} window
   * @param {KeyboardEvent} event
   * @returns {boolean} Whether something in the window takes the key.
   */
  claims(window, event) {
    return !!window && !!gClaims.get(window)?.(event);
  },
};
