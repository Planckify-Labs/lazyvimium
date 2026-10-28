// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Vim buffers are browser tabs: <S-h>/<S-l>, <leader>b*.

function visibleTabs(gBrowser) {
  return gBrowser.visibleTabs.filter(tab => !tab.closing);
}

function selectRelative(gBrowser, offset) {
  const tabs = visibleTabs(gBrowser);
  const index = tabs.indexOf(gBrowser.selectedTab);
  if (tabs.length < 2 || index == -1) {
    return;
  }
  const next = (((index + offset) % tabs.length) + tabs.length) % tabs.length;
  gBrowser.selectedTab = tabs[next];
}

function repeat(count, fn) {
  for (let i = 0; i < count; i++) {
    fn();
  }
}

const counted = { count: "number?" };

export const LazyvimiumTabsSpec = {
  name: "tabs",
  actions: {
    "tabs.next": {
      desc: "Next Tab",
      params: counted,
      agent: "act",
      run: ({ gBrowser }, { count = 1 }) => selectRelative(gBrowser, count),
    },
    "tabs.prev": {
      desc: "Prev Tab",
      params: counted,
      agent: "act",
      run: ({ gBrowser }, { count = 1 }) => selectRelative(gBrowser, -count),
    },
    "tabs.alternate": {
      desc: "Switch to Other Tab",
      agent: "act",
      run({ gBrowser }) {
        const other = visibleTabs(gBrowser)
          .filter(tab => tab != gBrowser.selectedTab)
          .sort((a, b) => b.lastAccessed - a.lastAccessed)[0];
        if (other) {
          gBrowser.selectedTab = other;
        }
      },
    },
    "tabs.new": {
      desc: "New Tab",
      agent: "act",
      run: ({ window }) => window.BrowserCommands.openTab(),
    },
    "tabs.close": {
      desc: "Delete Tab",
      agent: "confirm",
      run: ({ gBrowser }) =>
        gBrowser.removeTab(gBrowser.selectedTab, { animate: true }),
    },
    "tabs.closeOthers": {
      desc: "Delete Other Tabs",
      agent: "confirm",
      run: ({ gBrowser }) => gBrowser.removeAllTabsBut(gBrowser.selectedTab),
    },
    "tabs.closeRight": {
      desc: "Delete Tabs to the Right",
      agent: "confirm",
      run: ({ gBrowser }) =>
        gBrowser.removeTabsToTheEndFrom(gBrowser.selectedTab),
    },
    "tabs.closeLeft": {
      desc: "Delete Tabs to the Left",
      agent: "confirm",
      run: ({ gBrowser }) =>
        gBrowser.removeTabsToTheStartFrom(gBrowser.selectedTab),
    },
    "tabs.undoClose": {
      desc: "Reopen Closed Tab",
      agent: "act",
      run: ({ window }) => window.SessionWindowUI.undoCloseTab(window),
    },
    "tabs.moveNext": {
      desc: "Move Tab Next",
      params: counted,
      agent: "act",
      run: ({ gBrowser }, { count = 1 }) =>
        repeat(count, () => gBrowser.moveTabForward()),
    },
    "tabs.movePrev": {
      desc: "Move Tab Prev",
      params: counted,
      agent: "act",
      run: ({ gBrowser }, { count = 1 }) =>
        repeat(count, () => gBrowser.moveTabBackward()),
    },
  },
};
