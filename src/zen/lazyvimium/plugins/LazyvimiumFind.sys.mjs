// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// LazyVim's pickers (<leader><space>, <leader>,, <leader>fr) open the urlbar
// in the matching search mode until lazyvimium has a picker of its own.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  UrlbarShared: "chrome://browser/content/urlbar/UrlbarShared.mjs",
});

function urlbarSearch(window, token) {
  window.gURLBar.search(
    token ? `${lazy.UrlbarShared.RESTRICT_TOKENS[token]} ` : "",
    {
      searchModeEntry: "shortcut",
    }
  );
}

export const LazyvimiumFindSpec = {
  name: "find",
  actions: {
    "find.anything": {
      desc: "Find Tabs, History and Bookmarks",
      agent: "act",
      run: ({ window }) => urlbarSearch(window, null),
    },
    "find.tabs": {
      desc: "Tabs",
      agent: "act",
      run: ({ window }) => urlbarSearch(window, "OPENPAGE"),
    },
    "find.recent": {
      desc: "Recent",
      agent: "act",
      run: ({ window }) => urlbarSearch(window, "HISTORY"),
    },
    "find.bookmarks": {
      desc: "Bookmarks",
      agent: "act",
      run: ({ window }) => urlbarSearch(window, "BOOKMARK"),
    },
    "search.web": {
      desc: "Search the Web",
      agent: "act",
      run: ({ window }) => urlbarSearch(window, "SEARCH"),
    },
    "search.page": {
      desc: "Search in Page",
      agent: "act",
      run: ({ window }) => window.gLazyFindCommand("onFindCommand"),
    },
    "search.next": {
      desc: "Next Search Result",
      agent: "act",
      run: ({ window }) => window.gLazyFindCommand("onFindAgainCommand", false),
    },
    "search.prev": {
      desc: "Prev Search Result",
      agent: "act",
      run: ({ window }) => window.gLazyFindCommand("onFindAgainCommand", true),
    },
  },
};
