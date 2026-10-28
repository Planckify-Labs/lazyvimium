// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Zen's library panel (History, Downloads, Spaces, Media, Boosts, Routing).

const LIBRARY_MODULE = "moz-src:///zen/library/ZenLibrary.mjs";

/**
 * The window's <zen-library> class. Zen loads it lazily into each window, so
 * load it there if nothing has yet.
 *
 * @param {Window} window
 */
function libraryClass(window) {
  let library = window.customElements.get("zen-library");
  if (!library) {
    window.ChromeUtils.importESModule(LIBRARY_MODULE, { global: "current" });
    library = window.customElements.get("zen-library");
  }
  return library;
}

function toggle(section) {
  return ({ window }) => libraryClass(window)?.toggle(section);
}

export const LazyvimiumLibrarySpec = {
  name: "library",
  actions: {
    "library.toggle": {
      desc: "Toggle Library",
      agent: "act",
      run: toggle(),
    },
    "library.history": {
      desc: "History",
      agent: "act",
      run: toggle("history"),
    },
    "library.downloads": {
      desc: "Downloads",
      agent: "act",
      run: toggle("downloads"),
    },
    "library.spaces": {
      desc: "Spaces",
      agent: "act",
      run: toggle("spaces"),
    },
    "library.media": {
      desc: "Media",
      agent: "act",
      run: toggle("media"),
    },
    "library.boosts": {
      desc: "Boosts",
      agent: "act",
      run: toggle("boosts"),
    },
    "library.routing": {
      desc: "Space Routing",
      agent: "act",
      run: toggle("space-routing"),
    },
  },
};
