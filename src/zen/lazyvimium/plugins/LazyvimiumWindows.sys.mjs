// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Vim tab pages are Zen spaces and vim windows are split view panes.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  LazyvimiumPicker:
    "resource:///modules/lazyvimium/ui/LazyvimiumPicker.sys.mjs",
});

const SPLITS = {
  vsep: { title: "Split Window Right", side: "right" },
  hsep: { title: "Split Window Below", side: "bottom" },
};

function hostOf(tab) {
  try {
    return (
      tab.linkedBrowser.currentURI.host || tab.linkedBrowser.currentURI.spec
    );
  } catch {
    return tab.linkedBrowser.currentURI?.spec ?? "";
  }
}

/**
 * Split the current tab like :vsplit or :split. The new pane shows a tab
 * picked from the space, or, with "Open URL" or when there is nothing to
 * pick, the urlbar to load any site into it.
 *
 * @param {Window} window
 * @param {"vsep"|"hsep"} gridType
 */
async function split(window, gridType) {
  const { gBrowser, gZenViewSplitter: splitter } = window;
  const current = gBrowser.selectedTab;
  if (current.hasAttribute("zen-empty-tab")) {
    return;
  }
  const panes = splitTabs(window);
  const candidates = gBrowser.visibleTabs.filter(
    tab =>
      tab != current &&
      !tab.closing &&
      !tab.hasAttribute("zen-empty-tab") &&
      !panes.includes(tab)
  );
  // Zen opens an empty pane with the urlbar only outside a split.
  const canOpenUrl = !current.splitView;
  const { title, side } = SPLITS[gridType];

  if (!candidates.length) {
    if (canOpenUrl) {
      splitter.createEmptySplit(side);
    }
    return;
  }

  const items = candidates.map(tab => ({
    label: tab.label,
    detail: hostOf(tab),
    icon: tab.getAttribute("image") || undefined,
  }));
  if (canOpenUrl) {
    items.unshift({ label: "Open URL…", detail: "any website", key: "/" });
  }
  const index = await lazy.LazyvimiumPicker.open(window, { title, items });
  if (index === null) {
    return;
  }
  if (canOpenUrl && index == 0) {
    splitter.createEmptySplit(side);
    return;
  }
  splitWith(window, candidates[canOpenUrl ? index - 1 : index], gridType);
}

/**
 * Show a tab in a new pane next to the current tab, dividing only the
 * current pane when it is already part of a split.
 *
 * @param {Window} window
 * @param {Element} picked
 * @param {"vsep"|"hsep"} gridType
 */
export function splitWith(window, picked, gridType) {
  const { gBrowser, gZenViewSplitter: splitter } = window;
  const current = gBrowser.selectedTab;
  if (picked == current || current.hasAttribute("zen-empty-tab")) {
    return;
  }
  if (!current.splitView) {
    splitter.splitTabs([current, picked], gridType, 1);
    return;
  }
  // Zen adds a tab to an existing split at the root of its layout; move it
  // next to the current pane so only that pane is divided, as in vim.
  const group = splitter.splitTabs([current, picked], gridType, 0, {
    activate: false,
  });
  if (!group) {
    return;
  }
  // A pinned tab may have been split as a duplicate, which Zen adds last.
  const added = group.tabs.at(-1);
  const node = leafOf(group.layoutTree, added);
  const target = leafOf(group.layoutTree, current);
  if (node && target) {
    splitter.removeNode(node);
    splitter.splitIntoNode(target, node, SPLITS[gridType].side, 0.5);
  }
  splitter.activateSplitView(group, true);
  gBrowser.selectedTab = added;
}

function leafOf(node, tab) {
  if (node.tab == tab) {
    return node;
  }
  for (const child of node.children ?? []) {
    const leaf = leafOf(child, tab);
    if (leaf) {
      return leaf;
    }
  }
  return null;
}

function splitTabs(window) {
  const splitter = window.gZenViewSplitter;
  if (!splitter || splitter.currentView < 0) {
    return [];
  }
  return splitter._data[splitter.currentView]?.tabs ?? [];
}

function center(tab) {
  const rect = tab.linkedBrowser.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * Select the split pane nearest to the current one in a direction, the way
 * <C-w>h/j/k/l picks a window.
 *
 * @param {Window} window
 * @param {number} dx -1 left, 1 right, 0 vertical.
 * @param {number} dy -1 up, 1 down, 0 horizontal.
 */
function focusPane(window, dx, dy) {
  const { gBrowser } = window;
  const tabs = splitTabs(window);
  if (!tabs.includes(gBrowser.selectedTab)) {
    return;
  }
  const from = center(gBrowser.selectedTab);
  let best = null;
  let bestScore = Infinity;
  for (const tab of tabs) {
    if (tab == gBrowser.selectedTab) {
      continue;
    }
    const to = center(tab);
    const along = (to.x - from.x) * dx + (to.y - from.y) * dy;
    if (along <= 0) {
      continue;
    }
    const across =
      Math.abs((to.x - from.x) * dy) + Math.abs((to.y - from.y) * dx);
    const score = along + 2 * across;
    if (score < bestScore) {
      best = tab;
      bestScore = score;
    }
  }
  if (best) {
    gBrowser.selectedTab = best;
  }
}

function changeSpace(window, pick) {
  const spaces = window.gZenWorkspaces.getWorkspaces();
  const space = pick(spaces);
  if (space && space.uuid != window.gZenWorkspaces.activeWorkspace) {
    return window.gZenWorkspaces.changeWorkspace(space);
  }
  return undefined;
}

export const LazyvimiumWindowsSpec = {
  name: "windows",
  actions: {
    "spaces.first": {
      desc: "First Space",
      agent: "act",
      run: ({ window }) => changeSpace(window, spaces => spaces[0]),
    },
    "spaces.last": {
      desc: "Last Space",
      agent: "act",
      run: ({ window }) => changeSpace(window, spaces => spaces.at(-1)),
    },
    "spaces.close": {
      desc: "Close Space",
      agent: "confirm",
      run: ({ window }) => window.gZenWorkspaces.contextDeleteWorkspace(),
    },
    "splits.focusLeft": {
      desc: "Go to Left Window",
      agent: "act",
      run: ({ window }) => focusPane(window, -1, 0),
    },
    "splits.focusDown": {
      desc: "Go to Lower Window",
      agent: "act",
      run: ({ window }) => focusPane(window, 0, 1),
    },
    "splits.focusUp": {
      desc: "Go to Upper Window",
      agent: "act",
      run: ({ window }) => focusPane(window, 0, -1),
    },
    "splits.focusRight": {
      desc: "Go to Right Window",
      agent: "act",
      run: ({ window }) => focusPane(window, 1, 0),
    },
    "splits.vertical": {
      desc: "Split Window Right",
      agent: false,
      run: ({ window }) => split(window, "vsep"),
    },
    "splits.horizontal": {
      desc: "Split Window Below",
      agent: false,
      run: ({ window }) => split(window, "hsep"),
    },
    "splits.close": {
      desc: "Delete Window",
      agent: "act",
      run({ window }) {
        const tab = window.gBrowser.selectedTab;
        if (tab.splitView) {
          window.gZenViewSplitter.removeTabFromGroup(tab, undefined, {
            forUnsplit: true,
          });
        }
      },
    },
    "splits.only": {
      desc: "Close Other Windows",
      agent: "act",
      run: ({ window }) => window.gZenViewSplitter.unsplitCurrentView(),
    },
  },
};
