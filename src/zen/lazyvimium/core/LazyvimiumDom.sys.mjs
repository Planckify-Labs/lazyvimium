// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const NON_TEXT_INPUTS = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export const LazyvimiumDom = {
  /**
   * Set while an agent presses keys in this content process. Its keys are
   * meant for the page, not for the vim engine: in dev testing the engine
   * took an agent's k (scroll up) and Escape before YouTube saw them.
   */
  agentTyping: false,

  /**
   * Whether typing into this element edits it, which puts the page in
   * insert mode.
   *
   * @param {Element|null} element
   * @returns {boolean}
   */
  isEditable(element) {
    if (!element) {
      return false;
    }
    if (
      element.isContentEditable ||
      element.ownerDocument?.designMode == "on"
    ) {
      return true;
    }
    switch (element.localName) {
      case "textarea":
        return !element.readOnly && !element.disabled;
      case "select":
        return !element.disabled;
      case "input":
        return (
          !NON_TEXT_INPUTS.has(element.type) &&
          !element.readOnly &&
          !element.disabled
        );
    }
    return false;
  },

  /**
   * The focused element, looking inside open and closed shadow roots.
   *
   * @param {Document} document
   * @returns {Element|null}
   */
  deepActiveElement(document) {
    let element = document.activeElement;
    while (element?.openOrClosedShadowRoot?.activeElement) {
      element = element.openOrClosedShadowRoot.activeElement;
    }
    return element;
  },
};
