// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Zen's <command> elements as actions. The curated ones get vim names; the
// rest are wrapped as zen.<name> from the ids found in the first window
// (opts.commands), so new Zen commands show up without changes here.

const CURATED = {
  "zen.compactMode.toggle": ["cmd_zenCompactModeToggle", "Toggle Compact Mode"],
  "zen.sidebar.toggle": ["cmd_zenToggleSidebar", "Toggle Sidebar"],
  "zen.library.toggle": ["cmd_zenToggleLibrary", "Toggle Library"],
  "spaces.next": ["cmd_zenWorkspaceForward", "Next Space"],
  "spaces.prev": ["cmd_zenWorkspaceBackward", "Prev Space"],
  "spaces.new": ["cmd_zenOpenWorkspaceCreation", "New Space"],
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
    const actions = {};
    const curatedCommands = new Set();
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
