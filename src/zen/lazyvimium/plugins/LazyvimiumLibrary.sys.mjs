// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Zen's library panel (History, Downloads, Spaces, Media, Boosts, Routing),
// and its library mode: a picker over the open section's list, the media
// grid or the spaces.

const LIBRARY_MODULE = "moz-src:///zen/library/ZenLibrary.mjs";

const counted = { count: "number?" };

// The sections, with the name of the action that toggles each and goes to
// it from inside the library.
const SECTIONS = {
  history: ["History", "History"],
  downloads: ["Downloads", "Downloads"],
  spaces: ["Spaces", "Spaces"],
  media: ["Media", "Media"],
  boosts: ["Boosts", "Boosts"],
  "space-routing": ["Routing", "Space Routing"],
};

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

function viewOf({ lazyvimium, window }) {
  return lazyvimium.libraryFor(window);
}

function toggle(section) {
  return context => {
    libraryClass(context.window)?.toggle(section);
    // Keys typed in the page after a click there go back to the library
    // that the keys just opened again.
    viewOf(context)?.resume();
  };
}

// An action that only does something while the library mode is on.
function inLibrary(desc, run, definition = {}) {
  return {
    desc,
    agent: false,
    ...definition,
    run(context, args) {
      const view = viewOf(context);
      return view?.isOpen ? run(view, context, args) : undefined;
    },
  };
}

// An action for the spaces section only.
function inSpaces(desc, run, definition = {}) {
  return inLibrary(
    desc,
    (view, context, args) =>
      view.sectionId == "spaces" ? run(view, context, args) : undefined,
    definition
  );
}

const actions = {
  "library.toggle": {
    desc: "Toggle Library",
    agent: "act",
    run: toggle(),
  },
  "library.quit": inLibrary("Close", view => view.quit()),
  "library.down": inLibrary(
    "Down",
    (view, context, { count = 1 }) => view.move(count),
    { params: counted }
  ),
  "library.up": inLibrary(
    "Up",
    (view, context, { count = 1 }) => view.move(-count),
    { params: counted }
  ),
  "library.left": inLibrary(
    "Left",
    (view, context, { count = 1 }) => view.moveAcross(-count),
    { params: counted }
  ),
  "library.right": inLibrary(
    "Right",
    (view, context, { count = 1 }) => view.moveAcross(count),
    { params: counted }
  ),
  "library.first": inLibrary("First Item", view => view.moveTo(0)),
  "library.last": inLibrary("Last Item", view => view.moveTo(-1)),
  "library.halfPageDown": inLibrary("Half Page Down", view =>
    view.moveHalfPage(1)
  ),
  "library.halfPageUp": inLibrary("Half Page Up", view =>
    view.moveHalfPage(-1)
  ),
  "library.open": inLibrary("Open", view => view.activate()),
  "library.menu": inLibrary("Menu", view => view.openMenu()),
  "library.delete": inLibrary("Delete", view => view.delete()),
  "library.yank": inLibrary("Yank", view => view.yank()),
  "library.jump": inLibrary("Jump", view => view.jump()),
  "library.search": inLibrary("Search", view => view.search()),
  "library.filter": inLibrary("Filter", view => view.openFilters()),
  "library.add": inLibrary("Add Space or Route", view => view.add()),
  "library.nextSection": inLibrary(
    "Next Section",
    (view, context, { count = 1 }) => view.switchSection(count),
    { params: counted }
  ),
  "library.prevSection": inLibrary(
    "Previous Section",
    (view, context, { count = 1 }) => view.switchSection(-count),
    { params: counted }
  ),
  "library.renameSpace": inSpaces("Rename Space", view =>
    view.editSpace("rename")
  ),
  "library.spaceTheme": inSpaces("Space Theme", view =>
    view.editSpace("theme")
  ),
  "library.spaceIcon": inSpaces("Space Icon", view => view.editSpace("icon")),
  "library.moveSpaceLeft": inSpaces(
    "Move Space Left",
    (view, context, { count = 1 }) => view.moveSpace(-count),
    { params: counted }
  ),
  "library.moveSpaceRight": inSpaces(
    "Move Space Right",
    (view, context, { count = 1 }) => view.moveSpace(count),
    { params: counted }
  ),
};

for (const [id, [name, desc]] of Object.entries(SECTIONS)) {
  const key = name.toLowerCase();
  actions[`library.${key}`] = { desc, agent: "act", run: toggle(id) };
  actions[`library.goto${name}`] = inLibrary(desc, view =>
    view.showSection(id)
  );
}

export const LazyvimiumLibrarySpec = {
  name: "library",
  actions,
};
