// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LazyvimiumDom } from "resource:///modules/lazyvimium/core/LazyvimiumDom.sys.mjs";
import { LazyvimiumKeys } from "resource:///modules/lazyvimium/core/LazyvimiumKeys.sys.mjs";
import { LazyvimiumKeyEngine } from "resource:///modules/lazyvimium/core/LazyvimiumKeyEngine.sys.mjs";
import {
  LAZYVIMIUM_SHARED_KEY,
  buildKeymap,
} from "resource:///modules/lazyvimium/core/LazyvimiumShared.sys.mjs";

// One keymap per content process, rebuilt when the parent publishes a new
// version.
let gCached = null;

const JUMP_MODULE =
  "resource:///modules/lazyvimium/plugins/LazyvimiumJumpContent.sys.mjs";

// A page that keeps refocusing its field gets it after this many refusals,
// rather than a focus fight.
const MAX_REFUSED_FOCUS = 3;

function currentConfig() {
  const config = Services.cpmm.sharedData.get(LAZYVIMIUM_SHARED_KEY);
  if (!config) {
    return null;
  }
  if (gCached?.config.version !== config.version) {
    gCached = { config, keymap: buildKeymap(config) };
  }
  return gCached;
}

export class LazyvimiumKeysChild extends JSWindowActorChild {
  #engine = null;
  #version = null;
  // Insert mode entered with `i` stays until <Esc>, wherever focus goes.
  #explicitInsert = false;
  #refusedFocus = 0;
  #lastInput = null;
  // The jump session that takes the keys, until it is done.
  #capture = null;
  // Whether a page field has focus. The parent needs it to take reserved
  // browser shortcuts, like Ctrl+W, only while the user is typing.
  #inField = false;
  // APZ scrolls <Space>, PageDown and the arrows before preventDefault() can
  // stop them, unless the page itself has a key listener that could cancel
  // them. Ours is on the window root, where APZ does not look.
  #deferApzScrolling = () => {};

  actorCreated() {
    this.contentWindow?.addEventListener(
      "keydown",
      this.#deferApzScrolling,
      true,
      true
    );
  }

  didDestroy() {
    try {
      this.contentWindow?.removeEventListener(
        "keydown",
        this.#deferApzScrolling,
        true
      );
    } catch {
      // The window is already gone.
    }
  }

  handleEvent(event) {
    if (!event.isTrusted) {
      return;
    }
    switch (event.type) {
      case "keydown":
        this.#onKeyDown(event);
        break;
      case "focusin":
      case "focusout":
        // focusout fires before the next element takes focus.
        Promise.resolve().then(() => this.#syncMode());
        break;
      case "copy":
      case "cut":
        this.#onCopy();
        break;
      case "pageshow":
        if (!this.browsingContext.parent) {
          const engine = this.#ensureEngine();
          if (engine) {
            this.#reportState(engine);
          }
        }
        break;
    }
  }

  receiveMessage(message) {
    switch (message.name) {
      case "Lazyvimium:RunContent":
        return this.runAction(message.data.id, message.data.args ?? {});
      // From the jump of the page this frame is in.
      case "Lazyvimium:CollectControls":
        return ChromeUtils.importESModule(JUMP_MODULE).collectControls(
          this,
          this.contentWindow
        );
      case "Lazyvimium:PressControl":
        return ChromeUtils.importESModule(JUMP_MODULE).pressControl(
          this,
          this.contentWindow,
          message.data
        );
    }
    return undefined;
  }

  /**
   * Send the keys that follow to a session, like a jump's, until it is done.
   *
   * @param {{handleKey: (event: KeyboardEvent) => void, done: boolean}} session
   */
  startCapture(session) {
    // A session with nothing to pick is over before it starts.
    this.#capture = session.done ? null : session;
  }

  /**
   * The field the user last typed in on this page, for `gi`.
   *
   * @returns {Element|null}
   */
  get lastInput() {
    const input = this.#lastInput?.deref();
    return input?.isConnected ? input : null;
  }

  get engine() {
    return this.#ensureEngine();
  }

  /**
   * @param {string} mode
   * @param {object} [options]
   * @param {boolean} [options.explicit] Keep the mode until <Esc>.
   */
  setMode(mode, { explicit = false } = {}) {
    this.#explicitInsert = mode == "i" && explicit;
    this.#ensureEngine()?.setMode(mode);
  }

  /**
   * Run a content action in this page.
   *
   * @param {string} id
   * @param {object} args
   */
  runAction(id, args) {
    const cached = currentConfig();
    const action = cached?.config.actions[id];
    if (action?.where != "content") {
      throw new Error(`Lazyvimium: "${id}" is not a content action`);
    }
    const implementation = ChromeUtils.importESModule(action.module).actions?.[
      id
    ];
    if (typeof implementation != "function") {
      throw new Error(
        `Lazyvimium: ${action.module} does not implement "${id}"`
      );
    }
    return implementation(
      {
        actor: this,
        window: this.contentWindow,
        document: this.document,
        opts: cached.config.options[action.owner] ?? {},
      },
      args
    );
  }

  #ensureEngine() {
    const cached = currentConfig();
    if (!cached) {
      return null;
    }
    if (this.#engine && this.#version === cached.config.version) {
      return this.#engine;
    }
    const mode = this.#engine?.mode ?? "n";
    this.#engine?.reset();
    this.#engine = new LazyvimiumKeyEngine({
      keymap: cached.keymap,
      timeoutlen: cached.config.timeoutlen,
      // which-key waits on a prefix for as long as it takes.
      waitForPrefix: !!cached.config.options["which-key"],
      onMatch: match => this.#onMatch(match),
      onStateChange: engine => this.#reportState(engine),
    });
    this.#engine.setMode(mode);
    this.#version = cached.config.version;
    return this.#engine;
  }

  #syncMode() {
    if (!this.document) {
      return;
    }
    const engine = this.#ensureEngine();
    if (!engine) {
      return;
    }
    const active = LazyvimiumDom.deepActiveElement(this.document);
    const editing = LazyvimiumDom.isEditable(active);
    if (editing && engine.mode == "v") {
      // Clicking into a field ends visual mode.
      this.#inField = true;
      this.#lastInput = new WeakRef(active);
      engine.setMode("i");
      return;
    }
    if (editing && engine.mode == "n" && this.#isStolenFocus()) {
      // Pages like Wikipedia focus their search field on load, which would
      // put the page in insert mode before the user did anything.
      this.#refusedFocus++;
      active.blur();
      return;
    }
    if (editing) {
      this.#lastInput = new WeakRef(active);
    }
    const fieldChanged = editing != this.#inField;
    this.#inField = editing;
    if (editing && engine.mode == "n") {
      engine.setMode("i");
    } else if (!editing && engine.mode == "i" && !this.#explicitInsert) {
      engine.setMode("n");
    } else if (fieldChanged) {
      this.#reportState(engine);
    }
  }

  #isStolenFocus() {
    const preventAutofocus =
      currentConfig()?.config.options.core?.preventAutofocus ?? true;
    return (
      preventAutofocus &&
      this.#refusedFocus < MAX_REFUSED_FOCUS &&
      !this.contentWindow?.navigator.userActivation.hasBeenActive
    );
  }

  #onKeyDown(event) {
    const engine = this.#ensureEngine();
    if (!engine || LazyvimiumDom.agentTyping) {
      return;
    }
    if (this.#capture) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.#capture.handleKey(event);
      if (this.#capture.done) {
        this.#capture = null;
      }
      return;
    }
    this.#syncMode();
    if (engine.feed(LazyvimiumKeys.fromEvent(event))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  #onMatch({ mapping, count }) {
    const action = currentConfig()?.config.actions[mapping.rhs];
    if (!action) {
      console.error(
        `Lazyvimium: "${mapping.lhs}" maps to unknown "${mapping.rhs}"`
      );
      return;
    }
    const args = count !== null && action.params?.count ? { count } : {};
    if (action.where == "content") {
      if (action.params?.lhs) {
        // One action serves many keys, like every text object's.
        args.lhs = mapping.lhs;
      }
      Promise.resolve()
        .then(() => this.runAction(mapping.rhs, args))
        .catch(e => console.error(`Lazyvimium: "${mapping.rhs}" failed`, e));
    } else {
      this.sendAsyncMessage("Lazyvimium:Run", { id: mapping.rhs, args });
    }
  }

  // What the user copied or cut in the page, for the yank ring. Passwords
  // never go there.
  #onCopy() {
    const window = this.contentWindow;
    const field = LazyvimiumDom.deepActiveElement(this.document);
    let text;
    if (field?.localName == "input" || field?.localName == "textarea") {
      if (field.type == "password") {
        return;
      }
      text = field.value.substring(field.selectionStart, field.selectionEnd);
    } else {
      text = window.getSelection().toString();
    }
    if (text?.trim()) {
      this.sendAsyncMessage("Lazyvimium:Yank", {
        text,
        url: this.document.documentURI,
        title: this.document.title,
      });
    }
  }

  #reportState(engine) {
    if (engine.mode != "v") {
      ChromeUtils.importESModule(
        "resource:///modules/lazyvimium/plugins/LazyvimiumVisualContent.sys.mjs"
      ).hideCaret(this.contentWindow);
    }
    this.sendAsyncMessage("Lazyvimium:State", {
      mode: engine.mode,
      ...engine.pending,
      field: this.#inField,
    });
  }
}
