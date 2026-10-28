// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Vim's insert mode editing keys inside page fields. Fields otherwise keep
// the browser's own editing.

const CONTENT =
  "resource:///modules/lazyvimium/plugins/LazyvimiumEditContent.sys.mjs";

function edit(desc) {
  return { desc, where: "content", module: CONTENT, agent: false };
}

export const LazyvimiumEditSpec = {
  name: "edit",
  actions: {
    "edit.deleteWordBackward": edit("Delete Word Before Cursor"),
    "edit.deleteToLineStart": edit("Delete to Start of Line"),
    "edit.deleteCharBackward": edit("Delete Char Before Cursor"),
    "edit.deleteCharForward": edit("Delete Char Under Cursor"),
    "edit.deleteToLineEnd": edit("Delete to End of Line"),
  },
};
