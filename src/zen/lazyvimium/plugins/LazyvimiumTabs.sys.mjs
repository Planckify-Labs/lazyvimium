// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Vim buffers are browser tabs: <S-h>/<S-l>, <leader>b*.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  LazyvimiumPicker:
    "resource:///modules/lazyvimium/ui/LazyvimiumPicker.sys.mjs",
});

function visibleTabs(gBrowser) {
  return gBrowser.visibleTabs.filter(tab => !tab.closing);
}

/**
 * The visible tabs in order, with the panes of a split view as one entry,
 * the way the sidebar lists them.
 *
 * @param {Window} window
 * @returns {Tab[][]}
 */
function entries(window) {
  const splits = window.gZenViewSplitter?._data ?? [];
  const byEntry = new Map();
  for (const tab of visibleTabs(window.gBrowser)) {
    const entry = splits.find(split => split.tabs.includes(tab)) ?? tab;
    byEntry.set(entry, [...(byEntry.get(entry) ?? []), tab]);
  }
  return [...byEntry.values()];
}

// Moving onto a split view selects the pane that was used last.
export function lastUsed(tabs) {
  return tabs.reduce((last, tab) =>
    tab.lastAccessed > last.lastAccessed ? tab : last
  );
}

const isEssential = tab => tab.hasAttribute("zen-essential");

/**
 * What the tab context menu does, for a list of tabs: the page's <leader>b
 * keys pass the current tab, the explorer the tabs under its cursor.
 */
export const tabOps = {
  close(window, tabs) {
    window.gBrowser.removeTabs(tabs);
  },
  duplicate(window, tabs) {
    for (const tab of tabs) {
      window.gBrowser.duplicateTab(tab, true);
    }
  },
  reload(window, tabs) {
    window.gBrowser.reloadTabs(tabs);
  },
  unload(window, tabs) {
    return window.gBrowser.explicitUnloadTabs(tabs);
  },
  toggleMute(window, tabs) {
    for (const tab of tabs) {
      tab.toggleMuteAudio();
    }
  },
  // Essentials leave the top grid, pinned tabs the pinned section, and
  // other tabs join it.
  togglePin(window, tabs) {
    for (const tab of tabs) {
      if (isEssential(tab)) {
        window.gZenPinnedTabManager.removeEssentials(tab);
      } else if (tab.pinned) {
        window.gBrowser.unpinTab(tab);
      } else {
        window.gBrowser.pinTab(tab);
      }
    }
  },
  toggleEssential(window, tabs) {
    const manager = window.gZenPinnedTabManager;
    if (tabs.every(isEssential)) {
      for (const tab of tabs) {
        manager.removeEssentials(tab);
      }
    } else {
      manager.addToEssentials(tabs.filter(tab => !isEssential(tab)));
    }
  },
  yank(window, tabs, { markdown = false } = {}) {
    const lines = tabs.map(tab => {
      const url = tab.linkedBrowser.currentURI.spec;
      return markdown ? `[${tab.label}](${url})` : url;
    });
    Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper)
      .copyString(lines.join("\n"));
  },
  /**
   * Pick a folder of the space, or a new one, and move the tabs into it.
   *
   * @param {Window} window
   * @param {Element[]} tabs
   * @param {object} [options]
   * @param {boolean} [options.rename] Name a new folder right away, which
   *   needs the sidebar on screen.
   * @returns {Promise<Element|null>} The folder, unless nothing was picked.
   */
  async moveToFolder(window, tabs, { rename = false } = {}) {
    const folders = window.gZenFolders.activeSpaceFolders.filter(
      folder => !folder.isLiveFolder && !tabs.every(tab => tab.group == folder)
    );
    const index = await lazy.LazyvimiumPicker.open(window, {
      title: "Move to Folder",
      items: [
        { label: "New Folder", key: "n" },
        ...folders.map(folder => ({
          label: folder.label,
          icon: folder.iconURL || undefined,
        })),
      ],
    });
    if (index === null || !tabs.some(tab => tab.isConnected)) {
      return null;
    }
    if (index == 0) {
      return window.gZenFolders.createFolder(tabs, { renameFolder: rename });
    }
    const folder = folders[index - 1];
    folder.addTabs(tabs);
    return folder;
  },
  moveOutOfFolder(window, tabs) {
    for (const tab of tabs) {
      if (tab.group?.isZenFolder) {
        window.gBrowser.ungroupTab(tab);
      }
    }
  },
};

function onCurrentTab(op) {
  return ({ gBrowser, window }) => op(window, [gBrowser.selectedTab]);
}

function selectRelative(window, offset) {
  const { gBrowser } = window;
  const list = entries(window);
  const index = list.findIndex(tabs => tabs.includes(gBrowser.selectedTab));
  if (list.length < 2 || index == -1) {
    return;
  }
  const next = (((index + offset) % list.length) + list.length) % list.length;
  gBrowser.selectedTab = lastUsed(list[next]);
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
      run: ({ window }, { count = 1 }) => selectRelative(window, count),
    },
    "tabs.prev": {
      desc: "Prev Tab",
      params: counted,
      agent: "act",
      run: ({ window }, { count = 1 }) => selectRelative(window, -count),
    },
    "tabs.alternate": {
      desc: "Switch to Other Tab",
      agent: "act",
      run({ window }) {
        const { gBrowser } = window;
        const others = entries(window).filter(
          tabs => !tabs.includes(gBrowser.selectedTab)
        );
        if (others.length) {
          gBrowser.selectedTab = lastUsed(others.map(lastUsed));
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
    "tabs.toggleEssential": {
      desc: "Toggle Essential",
      agent: "act",
      run: onCurrentTab(tabOps.toggleEssential),
    },
    "tabs.duplicate": {
      desc: "Duplicate Tab",
      agent: "act",
      run: onCurrentTab(tabOps.duplicate),
    },
    "tabs.unload": {
      desc: "Unload Tab",
      agent: "act",
      run: onCurrentTab(tabOps.unload),
    },
    "tabs.toggleMute": {
      desc: "Toggle Mute",
      agent: "act",
      run: onCurrentTab(tabOps.toggleMute),
    },
    "tabs.moveToFolder": {
      desc: "Move to Folder",
      agent: false,
      run: onCurrentTab(tabOps.moveToFolder),
    },
  },
};
