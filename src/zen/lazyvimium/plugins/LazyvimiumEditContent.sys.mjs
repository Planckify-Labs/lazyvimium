// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";

// The editor's own commands keep undo history and fire input events, so
// pages see these edits like typing.
function editorCommand(command) {
  return ({ actor, document }) => {
    if (
      LazyvimiumDom.isEditable(LazyvimiumDom.deepActiveElement(document)) &&
      actor.docShell.isCommandEnabled(command)
    ) {
      actor.docShell.doCommand(command);
    }
  };
}

export const actions = {
  "edit.deleteWordBackward": editorCommand("cmd_deleteWordBackward"),
  "edit.deleteToLineStart": editorCommand("cmd_deleteToBeginningOfLine"),
  "edit.deleteCharBackward": editorCommand("cmd_deleteCharBackward"),
  "edit.deleteCharForward": editorCommand("cmd_deleteCharForward"),
  "edit.deleteToLineEnd": editorCommand("cmd_deleteToEndOfLine"),
};
