// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Inside a page the agent shows in the panel (LazyvimiumAgentUi), the
// frame of the panel's shell document: the page gets window.lazyvimium,
// whose calls need a click of the user's and go to the parent, which
// checks them again; its links open in tabs; and the panel learns its
// height. While the agent still writes it, the parent sends what of its
// html has arrived.

const MAX_PROMPT = 4000;

export class LazyvimiumUiChild extends JSWindowActorChild {
  #observer = null;
  #height = 0;

  // The page's frame, right under the shell, and opaque; not the shell,
  // nor a frame the page made.
  get #isPage() {
    const context = this.browsingContext;
    return (
      !!context.parent &&
      !context.parent.parent &&
      !!this.document?.nodePrincipal.isNullPrincipal
    );
  }

  handleEvent(event) {
    if (!this.#isPage) {
      return;
    }
    switch (event.type) {
      case "DOMDocElementInserted":
        this.#install();
        break;
      case "click":
        this.#onClick(event);
        break;
    }
  }

  receiveMessage({ name, data }) {
    if (name == "LazyvimiumUi:Preview" && this.#isPage) {
      const body = this.document?.body;
      if (body) {
        // Nothing runs: the preview's CSP has no scripts, the parent took
        // script blocks out (partialHtml), and the frame is the opaque
        // sandbox the page itself would run in.
        // eslint-disable-next-line no-unsanitized/property
        body.innerHTML = String(data.html ?? "");
        this.#reportHeight();
      }
    }
  }

  #install() {
    const window = this.contentWindow;
    const api = Cu.createObjectIn(window, { defineAs: "lazyvimium" });
    const methods = {
      sendPrompt: args => {
        const text = String(args?.text ?? "").trim();
        if (!text || text.length > MAX_PROMPT) {
          return `sendPrompt takes {text}, 1 to ${MAX_PROMPT} characters.`;
        }
        return ["Prompt", { text }];
      },
      openLink: args => {
        let url;
        try {
          url = new URL(String(args?.url ?? ""));
        } catch {
          return "openLink takes {url}, an https address.";
        }
        if (url.protocol != "https:" && url.protocol != "http:") {
          return "openLink opens only http(s) addresses.";
        }
        return ["OpenLink", { url: url.href }];
      },
      focusTab: args => {
        const tab = String(args?.tab ?? "");
        if (!/^t\d+$/.test(tab)) {
          return "focusTab takes {tab}, a tab id like t3.";
        }
        return ["FocusTab", { tab }];
      },
    };
    for (const [name, check] of Object.entries(methods)) {
      Cu.exportFunction(args => this.#call(name, check(args)), api, {
        defineAs: name,
      });
    }
    Cu.waiveXrays(window).Object.freeze(api);

    this.#observer?.disconnect();
    this.#observer = new window.ResizeObserver(() => this.#reportHeight());
    this.#observer.observe(this.document.documentElement);
  }

  // A call from the page, after its check: a content promise that settles
  // with the parent's answer.
  #call(name, checked) {
    const window = this.contentWindow;
    return new window.Promise((resolve, reject) => {
      const fail = message =>
        reject(new window.Error(`lazyvimium.${name}: ${message}`));
      if (typeof checked == "string") {
        fail(checked);
        return;
      }
      // One click, one call, never one from a timer or on load.
      if (!this.document.consumeTransientUserGestureActivation()) {
        fail("only works from something the user clicked.");
        return;
      }
      const [message, data] = checked;
      this.sendQuery(`LazyvimiumUi:${message}`, data).then(
        answer => (answer === true ? resolve() : fail(String(answer))),
        () => fail("the panel is gone.")
      );
    });
  }

  // Links open in tabs of their own; a link within the page still moves in
  // it.
  #onClick(event) {
    if (event.button > 1 || event.defaultPrevented) {
      return;
    }
    const link = event.composedTarget?.closest?.("a[href]");
    if (!link) {
      return;
    }
    const href = link.getAttribute("href") ?? "";
    if (href.startsWith("#")) {
      return;
    }
    event.preventDefault();
    let url;
    try {
      url = new URL(link.href);
    } catch {
      return;
    }
    if (url.protocol == "https:" || url.protocol == "http:") {
      this.sendAsyncMessage("LazyvimiumUi:OpenLink", { url: url.href });
    }
  }

  #reportHeight() {
    const root = this.document?.documentElement;
    if (!root) {
      return;
    }
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height != this.#height) {
      this.#height = height;
      this.sendAsyncMessage("LazyvimiumUi:Height", { height });
    }
  }

  didDestroy() {
    this.#observer?.disconnect();
    this.#observer = null;
  }
}
