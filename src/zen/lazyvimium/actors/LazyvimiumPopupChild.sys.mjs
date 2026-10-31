// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumPopupHints } from "resource:///modules/lazyvimium/core/LazyvimiumPopupHints.sys.mjs";

// An extension's popup, in the browser's panel: once it has loaded the
// parent says whether it is one the user sees, and its controls get labels.
export class LazyvimiumPopupChild extends JSWindowActorChild {
  #hints = null;

  handleEvent(event) {
    if (event.type == "DOMContentLoaded" && !this.browsingContext.parent) {
      this.sendAsyncMessage("LazyvimiumPopup:Loaded");
    }
  }

  receiveMessage({ name, data }) {
    if (name == "LazyvimiumPopup:Hints" && !this.#hints && this.contentWindow) {
      this.#hints = new LazyvimiumPopupHints(this.contentWindow, data.colors);
    }
  }

  didDestroy() {
    this.#hints?.destroy();
    this.#hints = null;
  }
}
