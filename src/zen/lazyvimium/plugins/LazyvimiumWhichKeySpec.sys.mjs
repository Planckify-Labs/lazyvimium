// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

export const LazyvimiumWhichKeySpec = {
  name: "which-key",
  opts: {
    // Milliseconds after a prefix before the popup shows, which-key's delay.
    delay: 200,
  },
  actions: {
    "whichkey.show": {
      desc: "Keymaps (which-key)",
      agent: false,
      run: ({ lazyvimium, window, browser }) =>
        lazyvimium.showAllKeys(window, browser),
    },
  },
};
