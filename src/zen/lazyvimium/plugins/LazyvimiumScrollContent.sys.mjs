// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

// The element a page scrolls in when its document does not, e.g. the main
// pane of a web app. Found once per document.
const gLargestScrollable = new WeakMap();

function canScroll(element, vertical) {
  const room = vertical
    ? element.scrollHeight - element.clientHeight
    : element.scrollWidth - element.clientWidth;
  if (room <= 1) {
    return false;
  }
  if (element == element.ownerDocument.scrollingElement) {
    return true;
  }
  const style = element.documentGlobal.getComputedStyle(element);
  return SCROLLABLE_OVERFLOW.has(vertical ? style.overflowY : style.overflowX);
}

function largestScrollable(document, vertical) {
  const cached = gLargestScrollable.get(document)?.deref();
  if (cached?.isConnected && canScroll(cached, vertical)) {
    return cached;
  }
  let best = null;
  let bestArea = 0;
  for (const element of document.body?.querySelectorAll("*") ?? []) {
    const area = element.clientWidth * element.clientHeight;
    if (area > bestArea && canScroll(element, vertical)) {
      best = element;
      bestArea = area;
    }
  }
  if (best) {
    gLargestScrollable.set(document, new WeakRef(best));
  }
  return best;
}

export function scrollTarget(document, vertical) {
  let element = LazyvimiumDom.deepActiveElement(document);
  while (element && element != document.body) {
    if (canScroll(element, vertical)) {
      return element;
    }
    element = element.parentElement ?? element.getRootNode()?.host ?? null;
  }
  const root = document.scrollingElement;
  if (root && canScroll(root, vertical)) {
    return root;
  }
  return largestScrollable(document, vertical) ?? root;
}

function viewportSize(document, target, vertical) {
  if (target == document.scrollingElement) {
    return vertical
      ? document.defaultView.innerHeight
      : document.defaultView.innerWidth;
  }
  return vertical ? target.clientHeight : target.clientWidth;
}

function scrollBy({ document, opts }, vertical, amount) {
  const target = scrollTarget(document, vertical);
  target?.scrollBy({
    [vertical ? "top" : "left"]: amount(target),
    behavior: opts.smooth ? "smooth" : "instant",
  });
}

function scrollTo({ document, opts }, toEnd) {
  const target = scrollTarget(document, true);
  target?.scrollTo({
    top: toEnd ? target.scrollHeight : 0,
    behavior: opts.smooth ? "smooth" : "instant",
  });
}

const step = (context, sign, count = 1) => sign * context.opts.step * count;
const page = (context, target, sign, fraction, count = 1) =>
  sign * viewportSize(context.document, target, true) * fraction * count;

export const actions = {
  "scroll.down": (context, { count }) =>
    scrollBy(context, true, () => step(context, 1, count)),
  "scroll.up": (context, { count }) =>
    scrollBy(context, true, () => step(context, -1, count)),
  "scroll.right": (context, { count }) =>
    scrollBy(context, false, () => step(context, 1, count)),
  "scroll.left": (context, { count }) =>
    scrollBy(context, false, () => step(context, -1, count)),
  "scroll.halfPageDown": (context, { count }) =>
    scrollBy(context, true, target => page(context, target, 1, 0.5, count)),
  "scroll.halfPageUp": (context, { count }) =>
    scrollBy(context, true, target => page(context, target, -1, 0.5, count)),
  "scroll.pageDown": (context, { count }) =>
    scrollBy(context, true, target => page(context, target, 1, 0.9, count)),
  "scroll.pageUp": (context, { count }) =>
    scrollBy(context, true, target => page(context, target, -1, 0.9, count)),
  "scroll.top": context => scrollTo(context, false),
  "scroll.bottom": context => scrollTo(context, true),
};
