// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const HTML_NS = "http://www.w3.org/1999/xhtml";

// The jump label colors of the window, as the sidebar's labels have them. A
// popup's page cannot see the window's variables, so they are resolved here.
function hintColors(window) {
  const document = window.document;
  const probe = document.createElementNS(HTML_NS, "div");
  probe.setAttribute(
    "style",
    "background: var(--lazyvimium-hint); color: var(--lazyvimium-hint-text);"
  );
  document.documentElement.append(probe);
  const { backgroundColor, color } = window.getComputedStyle(probe);
  probe.remove();
  return { background: backgroundColor, color };
}

export class LazyvimiumPopupParent extends JSWindowActorParent {
  receiveMessage({ name }) {
    if (name != "LazyvimiumPopup:Loaded") {
      return;
    }
    const browser = this.browsingContext.top.embedderElement;
    // Only the popups of a toolbar button, not the hidden pages of extensions.
    if (browser?.getAttribute("webextension-view-type") == "popup") {
      this.sendAsyncMessage("LazyvimiumPopup:Hints", {
        colors: hintColors(browser.documentGlobal),
      });
    }
  }
}
