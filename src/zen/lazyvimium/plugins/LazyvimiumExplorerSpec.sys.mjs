// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The sidebar as LazyVim's explorer (snacks.nvim): <leader>e moves a cursor
// into it, and the explorer mode's keys act on the rows under it.

import {
  lastUsed,
  tabOps,
} from "resource:///modules/lazyvimium/plugins/LazyvimiumTabs.sys.mjs";
import { splitWith } from "resource:///modules/lazyvimium/plugins/LazyvimiumWindows.sys.mjs";

const counted = { count: "number?" };

function explorerOf({ lazyvimium, window }) {
  return lazyvimium.explorerFor(window);
}

// An action that only does something while the explorer is open.
function inExplorer(desc, run, definition = {}) {
  return {
    desc,
    agent: false,
    ...definition,
    run(context, args) {
      const explorer = explorerOf(context);
      return explorer?.isOpen ? run(explorer, context, args) : undefined;
    },
  };
}

// A tab operation on the selection, or on the cursor's row.
function onTargets(desc, op) {
  return inExplorer(desc, async (explorer, { window }) => {
    const tabs = explorer.targets();
    explorer.clearSelection();
    if (tabs.length) {
      await op(window, tabs);
    }
    explorer.refresh();
  });
}

function folderAt(row) {
  return row?.kind == "folder" ? row.element : (row?.folder ?? null);
}

function setCollapsed(explorer, folder, collapsed) {
  if (!folder || folder.collapsed == collapsed) {
    return;
  }
  folder.collapsed = collapsed;
  explorer.moveToElement(folder);
}

// <A-j> and <A-k>: move the row past its neighbour in the same section or
// folder.
function moveRow(explorer, window, direction, count) {
  const { gBrowser } = window;
  const element = explorer.row?.element;
  if (!element) {
    return;
  }
  for (let i = 0; i < count; i++) {
    const siblings = [...element.parentElement.children].filter(
      node =>
        node == element ||
        (gBrowser.isTab(node) &&
          node.visible &&
          !node.hasAttribute("zen-empty-tab")) ||
        gBrowser.isTabGroup(node) ||
        gBrowser.isSplitViewWrapper(node)
    );
    const target = siblings[siblings.indexOf(element) + direction];
    if (!target) {
      break;
    }
    if (direction > 0) {
      gBrowser.moveTabAfter(element, target);
    } else {
      gBrowser.moveTabBefore(element, target);
    }
  }
  explorer.moveToElement(element);
}

function splitRow(gridType) {
  return (explorer, { window }) => {
    const row = explorer.row;
    if (!row || row.kind == "folder") {
      return;
    }
    const tab = lastUsed(row.tabs);
    if (tab == window.gBrowser.selectedTab) {
      return;
    }
    explorer.close();
    splitWith(window, tab, gridType);
  };
}

// The sidebar row of the current tab, for the page's keys.
function currentRow(explorer, window) {
  const selected = window.gBrowser.selectedTab;
  return explorer.rows().find(row => row.tabs.includes(selected)) ?? null;
}

// A page action that needs the sidebar on screen while it runs.
function inSidebar(desc, task) {
  return {
    desc,
    agent: false,
    run: context =>
      explorerOf(context)?.withSidebar(explorer => task(explorer, context)),
  };
}

function runCommand(window, id) {
  window.document.getElementById(id).doCommand();
}

export const LazyvimiumExplorerSpec = {
  name: "explorer",
  actions: {
    "explorer.toggle": {
      desc: "Explorer",
      agent: false,
      run(context) {
        const explorer = explorerOf(context);
        if (explorer?.isOpen) {
          explorer.close();
        } else {
          explorer?.open();
        }
      },
    },
    "explorer.quit": inExplorer("Close Explorer", explorer => explorer.close()),
    "explorer.escape": inExplorer("Clear Selection or Close", explorer => {
      if (!explorer.clearSelection()) {
        explorer.close();
      }
    }),

    "explorer.down": inExplorer(
      "Down",
      (explorer, context, { count = 1 }) => explorer.move(count),
      { params: counted }
    ),
    "explorer.up": inExplorer(
      "Up",
      (explorer, context, { count = 1 }) => explorer.move(-count),
      { params: counted }
    ),
    "explorer.first": inExplorer(
      "First Row",
      (explorer, context, { count = 1 }) => explorer.moveTo(count - 1),
      { params: counted }
    ),
    "explorer.last": inExplorer(
      "Last Row",
      (explorer, context, { count }) => explorer.moveTo(count ? count - 1 : -1),
      { params: counted }
    ),
    "explorer.halfPageDown": inExplorer("Half Page Down", explorer =>
      explorer.moveHalfPage(1)
    ),
    "explorer.halfPageUp": inExplorer("Half Page Up", explorer =>
      explorer.moveHalfPage(-1)
    ),

    "explorer.open": inExplorer("Open", (explorer, { window }) => {
      const row = explorer.row;
      if (row?.kind == "folder") {
        setCollapsed(explorer, row.element, !row.element.collapsed);
      } else if (row) {
        window.gBrowser.selectedTab = lastUsed(row.tabs);
        explorer.close();
      }
    }),
    "explorer.preview": inExplorer(
      "Open, Keep Explorer",
      (explorer, { window }) => {
        const row = explorer.row;
        if (row?.kind == "folder") {
          setCollapsed(explorer, row.element, !row.element.collapsed);
        } else if (row) {
          window.gBrowser.selectedTab = lastUsed(row.tabs);
        }
      }
    ),
    "explorer.collapse": inExplorer("Close Folder", explorer => {
      const row = explorer.row;
      if (row?.kind == "folder" && !row.element.collapsed) {
        setCollapsed(explorer, row.element, true);
      } else {
        setCollapsed(explorer, row?.folder, true);
      }
    }),
    "explorer.foldToggle": inExplorer("Toggle Folder", explorer => {
      const folder = folderAt(explorer.row);
      setCollapsed(explorer, folder, !folder?.collapsed);
    }),
    "explorer.foldOpen": inExplorer("Open Folder", explorer =>
      setCollapsed(explorer, folderAt(explorer.row), false)
    ),
    "explorer.foldClose": inExplorer("Close Folder", explorer =>
      setCollapsed(explorer, folderAt(explorer.row), true)
    ),
    "explorer.foldOpenAll": inExplorer(
      "Open All Folders",
      async (explorer, { window }) => {
        await window.gZenFolders.expandAllFolders();
        explorer.refresh();
      }
    ),
    "explorer.foldCloseAll": inExplorer(
      "Close All Folders",
      async (explorer, { window }) => {
        await window.gZenFolders.collapseAllFolders();
        explorer.refresh();
      }
    ),

    "explorer.jump": inExplorer("Jump", async explorer => {
      const row = await explorer.pickRow();
      if (row) {
        explorer.moveToElement(row.element);
      }
    }),
    "explorer.find": inExplorer(
      "Find Tab",
      (explorer, { lazyvimium, window }) => {
        explorer.close();
        return lazyvimium.run("find.tabs", {}, { window });
      }
    ),

    "explorer.add": inExplorer("New Tab", (explorer, { window }) => {
      explorer.close();
      window.BrowserCommands.openTab();
    }),
    "explorer.addFolder": inExplorer("New Folder", (explorer, { window }) => {
      const folder = window.gZenFolders.createFolder([], {
        renameFolder: true,
      });
      explorer.moveToElement(folder);
    }),
    "explorer.delete": inExplorer("Delete", async (explorer, { window }) => {
      const row = explorer.row;
      const tabs = explorer.targets();
      if (!explorer.clearSelection() && row?.kind == "folder") {
        await row.element.delete();
      } else if (tabs.length) {
        tabOps.close(window, tabs);
      }
      explorer.refresh();
    }),
    "explorer.rename": inExplorer("Rename", explorer => {
      const row = explorer.row;
      return row ? explorer.rename(row) : undefined;
    }),
    "explorer.duplicate": onTargets("Duplicate", tabOps.duplicate),
    "explorer.yank": onTargets("Yank URL", tabOps.yank),
    "explorer.yankMarkdown": onTargets("Yank Markdown Link", (window, tabs) =>
      tabOps.yank(window, tabs, { markdown: true })
    ),
    "explorer.togglePin": onTargets("Toggle Pin", tabOps.togglePin),
    "explorer.toggleEssential": onTargets(
      "Toggle Essential",
      tabOps.toggleEssential
    ),
    "explorer.reload": onTargets("Reload", tabOps.reload),
    "explorer.unload": onTargets("Unload", tabOps.unload),
    "explorer.toggleMute": onTargets("Toggle Mute", tabOps.toggleMute),
    "explorer.moveToFolder": onTargets("Move to Folder", (window, tabs) =>
      tabOps.moveToFolder(window, tabs, { rename: true })
    ),
    "explorer.moveOutOfFolder": onTargets(
      "Move out of Folder",
      tabOps.moveOutOfFolder
    ),
    "explorer.moveDown": inExplorer(
      "Move Down",
      (explorer, { window }, { count = 1 }) =>
        moveRow(explorer, window, 1, count),
      { params: counted }
    ),
    "explorer.moveUp": inExplorer(
      "Move Up",
      (explorer, { window }, { count = 1 }) =>
        moveRow(explorer, window, -1, count),
      { params: counted }
    ),
    "explorer.splitVertical": inExplorer(
      "Open in Vertical Split",
      splitRow("vsep")
    ),
    "explorer.splitHorizontal": inExplorer(
      "Open in Horizontal Split",
      splitRow("hsep")
    ),
    "explorer.menu": inExplorer("Menu", explorer => {
      const row = explorer.row;
      return row ? explorer.openMenu(row) : undefined;
    }),
    "explorer.toggleSelect": inExplorer("Select", explorer =>
      explorer.togglePicked()
    ),
    "explorer.visual": inExplorer("Visual Select", explorer =>
      explorer.toggleVisual()
    ),

    "tabs.pick": inSidebar("Pick Tab", async (explorer, { window }) => {
      const row = await explorer.pickRow();
      if (row && row.kind != "folder") {
        window.gBrowser.selectedTab = lastUsed(row.tabs);
      }
    }),
    "tabs.menu": inSidebar("Tab Menu", async (explorer, { window }) => {
      const row = currentRow(explorer, window);
      if (row) {
        await explorer.openMenu(row);
        await explorer.whenRenamed();
      }
    }),
    "tabs.rename": inSidebar("Rename Tab", (explorer, { window }) => {
      const row = currentRow(explorer, window);
      return row ? explorer.rename(row) : undefined;
    }),
    "spaces.rename": inSidebar("Rename Space", (explorer, { window }) => {
      runCommand(window, "cmd_zenChangeWorkspaceName");
      return explorer.whenRenamed();
    }),
    "spaces.icon": inSidebar("Change Space Icon", (explorer, { window }) => {
      runCommand(window, "cmd_zenChangeWorkspaceIcon");
      return explorer.whenPopupsClosed();
    }),
    "spaces.theme": inSidebar("Space Theme", (explorer, { window }) => {
      runCommand(window, "cmd_zenOpenZenThemePicker");
      return explorer.whenPopupsClosed();
    }),
  },
};
