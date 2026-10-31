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

  /**
   * Every element under a root in document order, with those of each shadow
   * root (closed ones too, which privileged code can see) right after its
   * host. Settings pages and web components keep their controls there.
   *
   * @param {Document|ShadowRoot|Element} root
   * @yields {Element}
   */
  *deepElements(root) {
    for (const element of root.querySelectorAll("*")) {
      yield element;
      const shadow = element.openOrClosedShadowRoot;
      if (shadow) {
        yield* LazyvimiumDom.deepElements(shadow);
      }
    }
  },

  /**
   * Every text node under a root in document order, with those of a shadow
   * root before the host's own children.
   *
   * @param {Node} root
   * @yields {Text}
   */
  *deepTextNodes(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (node.nodeType == node.TEXT_NODE) {
        yield node;
        continue;
      }
      const children = [
        ...(node.openOrClosedShadowRoot?.childNodes ?? []),
        ...node.childNodes,
      ];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push(children[i]);
      }
    }
  },

  /**
   * The parent of a node across shadow roots: a shadow root's child has its
   * host.
   *
   * @param {Node} node
   * @returns {Element|null}
   */
  composedParent(node) {
    return node.parentElement ?? node.getRootNode()?.host ?? null;
  },

  /**
   * Whether an element is another one, or inside it, across shadow roots.
   *
   * @param {Element} ancestor
   * @param {Element} element
   * @returns {boolean}
   */
  composedContains(ancestor, element) {
    for (let each = element; each; each = LazyvimiumDom.composedParent(each)) {
      if (each === ancestor) {
        return true;
      }
    }
    return false;
  },

  /**
   * The element on top at a point, looking inside shadow roots.
   *
   * @param {Document} document
   * @param {number} x
   * @param {number} y
   * @returns {Element|null}
   */
  deepElementFromPoint(document, x, y) {
    let element = document.elementFromPoint(x, y);
    for (
      let shadow = element?.openOrClosedShadowRoot;
      shadow;
      shadow = element?.openOrClosedShadowRoot
    ) {
      const inner = shadow.elementFromPoint(x, y);
      if (!inner || inner === element) {
        break;
      }
      element = inner;
    }
    return element;
  },
};
