// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Zen's <command> elements as actions. The curated ones get vim names; the
// rest are wrapped as zen.<name> from the ids found in the first window
// (opts.commands), so new Zen commands show up without changes here.

const PREF_SIDEBAR_EXPANDED = "zen.view.sidebar-expanded";

// The layout prefs the compact mode menu, the sidebar toggle and Zen's
// settings write. Clearing them returns the browser to its defaults.
const LAYOUT_PREFS = [
  "zen.view.sidebar-expanded",
  "zen.view.use-single-toolbar",
  "zen.view.compact.hide-tabbar",
  "zen.view.compact.hide-toolbar",
  "zen.view.compact.enable-at-startup",
  "zen.tabs.vertical.right-side",
];

// Compact mode is toggled the way the sidebar's button does it: a pointer
// resting over the sidebar must not pull it back while it slides away.
const CURATED = {
  "zen.compactMode.toggle": [
    "cmd_toggleCompactModeIgnoreHover",
    "Toggle Compact Mode",
  ],
  "zen.library.toggle": ["cmd_zenToggleLibrary", "Toggle Library"],
  "spaces.next": ["cmd_zenWorkspaceForward", "Next Space"],
  "spaces.prev": ["cmd_zenWorkspaceBackward", "Prev Space"],
  "spaces.new": ["cmd_zenOpenWorkspaceCreation", "New Space"],
  "spaces.unload": ["cmd_zenUnloadWorkspace", "Unload Space"],
  "splits.grid": ["cmd_zenSplitViewGrid", "Split Windows in a Grid"],
  "tabs.togglePin": ["cmd_zenTogglePinTab", "Toggle Pin"],
  "tabs.closeUnpinned": ["cmd_zenCloseUnpinnedTabs", "Delete Non-Pinned Tabs"],
  "yank.url": ["cmd_zenCopyCurrentURL", "Copy URL"],
  "yank.urlMarkdown": ["cmd_zenCopyCurrentURLMarkdown", "Copy URL as Markdown"],
};

// Commands that read a context menu or an event target and do nothing
// useful from a key.
const NEEDS_CONTEXT =
  /Ctx|ContextMenu|ChangeWorkspaceTab|WorkspaceSwitch|LinkInNewTab/;

function runCommand(window, id) {
  const command = window.document.getElementById(id);
  if (!command) {
    throw new Error(`Lazyvimium: there is no command "${id}"`);
  }
  command.doCommand();
}

function generatedId(commandId) {
  const name = commandId.replace(/^cmd_zen/, "");
  return `zen.${name[0].toLowerCase()}${name.slice(1)}`;
}

function generatedDesc(commandId) {
  return `Zen: ${commandId.replace(/^cmd_zen/, "").replace(/(?<=[a-z])(?=[A-Z])/g, " ")}`;
}

export const LazyvimiumZenCommandsSpec = {
  name: "zen-commands",
  opts: { commands: [] },
  actions(plugin, opts) {
    // Zen's own sidebar toggle also turns its single toolbar off for good,
    // which puts the URL bar back in the top bar after the sidebar opens
    // again. A collapsed sidebar already falls back to the top bar by itself,
    // so this only flips the sidebar.
    const actions = {
      "zen.sidebar.toggle": {
        desc: "Toggle Sidebar",
        agent: "act",
        run: () =>
          Services.prefs.setBoolPref(
            PREF_SIDEBAR_EXPANDED,
            !Services.prefs.getBoolPref(PREF_SIDEBAR_EXPANDED)
          ),
      },
      "zen.layout.reset": {
        desc: "Reset Layout to Defaults",
        run: ({ window }) => {
          for (const pref of LAYOUT_PREFS) {
            Services.prefs.clearUserPref(pref);
          }
          // The compact mode flag only applies at startup; set it now.
          const compact = window.gZenCompactModeManager;
          if (compact) {
            compact.preference = Services.prefs.getBoolPref(
              "zen.view.compact.enable-at-startup",
              false
            );
          }
        },
      },
    };
    // Covered above: by the sidebar toggle, and by the curated compact
    // mode toggle, which runs its hover-safe variant.
    const curatedCommands = new Set([
      "cmd_zenToggleSidebar",
      "cmd_zenCompactModeToggle",
    ]);
    for (const [id, [commandId, desc]] of Object.entries(CURATED)) {
      curatedCommands.add(commandId);
      actions[id] = {
        desc,
        agent: "act",
        run: ({ window }) => runCommand(window, commandId),
      };
    }
    for (const commandId of opts.commands) {
      if (
        !commandId.startsWith("cmd_zen") ||
        curatedCommands.has(commandId) ||
        NEEDS_CONTEXT.test(commandId)
      ) {
        continue;
      }
      actions[generatedId(commandId)] = {
        desc: generatedDesc(commandId),
        run: ({ window }) => runCommand(window, commandId),
      };
    }
    return actions;
  },
};
