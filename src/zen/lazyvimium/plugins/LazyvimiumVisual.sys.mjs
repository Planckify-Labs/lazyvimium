// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Visual mode on a page's text, after vim's: `v` starts a selection, vim's
// motions and text objects (`vi{`, `vap`, `va/`) grow it, and `y` yanks it
// into the clipboard and the yank ring. Starting it labels every word and
// paragraph on screen, to choose where the cursor lands.

const CONTENT =
  "resource:///modules/lazyvimium/plugins/LazyvimiumVisualContent.sys.mjs";

function visual(desc, params = {}) {
  return { desc, where: "content", module: CONTENT, params, agent: false };
}

const counted = { count: "number?" };

export const LazyvimiumVisualSpec = {
  name: "visual",
  actions: {
    "visual.enter": visual("Visual Mode"),
    "visual.exit": visual("Leave Visual Mode"),
    "visual.swapEnds": visual("Other End of Selection"),
    "visual.left": visual("Cursor Left", counted),
    "visual.right": visual("Cursor Right", counted),
    "visual.down": visual("Cursor Down", counted),
    "visual.up": visual("Cursor Up", counted),
    "visual.wordForward": visual("Word Forward", counted),
    "visual.wordBackward": visual("Word Backward", counted),
    "visual.lineStart": visual("Line Start"),
    "visual.lineEnd": visual("Line End"),
    "visual.paragraphForward": visual("Paragraph Forward", counted),
    "visual.paragraphBackward": visual("Paragraph Backward", counted),
    "visual.top": visual("Top"),
    "visual.bottom": visual("Bottom"),
    // The keys that ran it, "a(" or "iw", say which object.
    "visual.object": visual("Select Text Object", {
      ...counted,
      lhs: "string?",
    }),
    "visual.yank": visual("Yank Selection"),
  },
};
