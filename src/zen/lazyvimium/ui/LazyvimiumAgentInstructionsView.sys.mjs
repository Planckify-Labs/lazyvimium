// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The agent panel's instructions page: a page over the panel where the user
// writes the guidelines their agent follows on every request, each with a
// switch, a title, its text and at most one file, a picture, video or
// document (LazyvimiumAgentInstructions). Changes are kept as they are typed.

import {
  LazyvimiumAgentInstructions as store,
  MAX_INSTRUCTION_CHARS,
  MAX_INSTRUCTION_FILE_BYTES,
} from "resource:///modules/lazyvimium/agent/LazyvimiumAgentInstructions.sys.mjs";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export class LazyvimiumAgentInstructionsView {
  #window;
  #root;
  #list;
  #empty;
  #onClose;
  #onPicking;
  #unsubscribe;
  #shown = false;
  #animation = null;
  // The card of each instruction, by id.
  #cards = new Map();

  /**
   * @param {Window} window
   * @param {object} options
   * @param {Element} options.parent The panel the page covers.
   * @param {() => void} options.onClose Called once the page is closed.
   * @param {(busy: boolean) => void} options.onPicking Called as a file
   *   dialog opens and closes.
   */
  constructor(window, { parent, onClose, onPicking }) {
    this.#window = window;
    this.#onClose = onClose;
    this.#onPicking = onPicking;

    this.#root = this.#create("div", "lazyvimium-agent-instructions", parent);
    this.#root.hidden = true;
    this.#root.setAttribute("role", "region");
    this.#root.setAttribute("aria-label", "Agent instructions");
    // What is typed here is the panel's, never the page's.
    this.#root.addEventListener("keydown", event => {
      if (event.key == "Escape") {
        event.preventDefault();
        this.close();
      }
      event.stopPropagation();
    });
    // A file dropped beside the cards goes nowhere, and the browser does not
    // open it; the panel's composer never sees it.
    this.#root.addEventListener("dragover", event => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    this.#root.addEventListener("drop", event => {
      event.preventDefault();
      event.stopPropagation();
    });

    const header = this.#create("div", "lazyvimium-agent-instructions-header");
    const back = this.#iconButton("back", "Back");
    back.addEventListener("click", () => this.close());
    const title = this.#create(
      "h2",
      "lazyvimium-agent-instructions-title",
      null,
      "Agent instructions"
    );
    const close = this.#iconButton("close", "Close (Esc)");
    close.addEventListener("click", () => this.close());
    header.append(back, title, close);

    this.#list = this.#create("div", "lazyvimium-agent-instructions-list");
    this.#empty = this.#create(
      "p",
      "lazyvimium-agent-instructions-empty",
      null,
      "Guidelines your agent follows on every request, such as how to answer or what to avoid. Switch one off to keep it without using it."
    );

    const add = this.#create(
      "button",
      "lazyvimium-agent-instructions-add",
      null,
      "Add instruction"
    );
    add.prepend(this.#create("span", "plus"));
    add.addEventListener("click", () => this.#add());

    const done = this.#create(
      "button",
      "lazyvimium-agent-instructions-done",
      null,
      "Done"
    );
    done.addEventListener("click", () => this.close());

    const body = this.#create("div", "lazyvimium-agent-instructions-body");
    body.append(this.#empty, this.#list, add);
    this.#root.append(header, body, done);

    this.#unsubscribe = store.subscribe(() => this.#sync());
    window.addEventListener("unload", () => this.#unsubscribe(), {
      once: true,
    });
  }

  get isOpen() {
    return this.#shown;
  }

  // The page slides in from the right as it fades in, and back out the same
  // way.
  #animate(showing) {
    this.#animation?.cancel();
    this.#animation = null;
    if (this.#window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return Promise.resolve();
    }
    const animation = this.#root.animate(
      [
        { opacity: 0, transform: "translateX(28px)" },
        { opacity: 1, transform: "translateX(0)" },
      ],
      {
        duration: showing ? 300 : 170,
        easing: showing
          ? "cubic-bezier(0.22, 1, 0.36, 1)"
          : "cubic-bezier(0.4, 0, 1, 1)",
        direction: showing ? "normal" : "reverse",
      }
    );
    this.#animation = animation;
    return animation.finished.then(
      () => {
        if (this.#animation == animation) {
          this.#animation = null;
        }
      },
      () => {}
    );
  }

  /**
   * @param {Node} node
   * @returns {boolean} Whether the node is part of the page.
   */
  contains(node) {
    return this.#root.contains(node);
  }

  async open() {
    if (this.isOpen) {
      return;
    }
    this.#shown = true;
    this.#root.inert = false;
    this.#root.hidden = false;
    this.#animate(true);
    await store.load();
    this.#sync();
    const first = this.#list.querySelector("input");
    (
      first ?? this.#root.querySelector(".lazyvimium-agent-instructions-add")
    ).focus({ preventScroll: true });
  }

  close() {
    if (!this.isOpen) {
      return;
    }
    this.#shown = false;
    // Out of reach while it leaves.
    this.#root.inert = true;
    store.save().catch(e => console.error("Lazyvimium: save failed", e));
    this.#onClose();
    this.#animate(false).then(() => {
      // Unless it was opened again meanwhile.
      if (!this.#shown) {
        this.#root.hidden = true;
      }
    });
  }

  #create(tag, className, parent, text) {
    const element = this.#window.document.createElementNS(HTML_NS, tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined && text !== null) {
      element.textContent = text;
    }
    parent?.append(element);
    return element;
  }

  #iconButton(name, title) {
    const button = this.#create(
      "button",
      `lazyvimium-agent-icon-button ${name}`
    );
    button.title = title;
    button.setAttribute("aria-label", title);
    return button;
  }

  #add() {
    const item = store.add();
    this.#cards.get(item.id)?.title.focus({ preventScroll: true });
    this.#cards.get(item.id)?.card.scrollIntoView({ block: "nearest" });
  }

  // Draw what the store holds: cards that are gone leave, new ones come in at
  // the end, and the rest keep what the user is typing.
  #sync() {
    const items = store.items;
    const ids = new Set(items.map(item => item.id));
    for (const [id, parts] of this.#cards) {
      if (!ids.has(id)) {
        parts.card.remove();
        this.#cards.delete(id);
      }
    }
    for (const item of items) {
      let parts = this.#cards.get(item.id);
      if (!parts) {
        parts = this.#buildCard(item);
        this.#cards.set(item.id, parts);
        this.#list.append(parts.card);
      }
      parts.toggle.setAttribute("aria-checked", String(item.enabled));
      parts.card.toggleAttribute("off", !item.enabled);
      this.#renderFile(parts, item);
      const doc = this.#window.document;
      if (doc.activeElement != parts.title && parts.title.value != item.title) {
        parts.title.value = item.title;
      }
      if (doc.activeElement != parts.text && parts.text.value != item.text) {
        parts.text.value = item.text;
      }
    }
    this.#empty.hidden = !!items.length;
    for (const { text } of this.#cards.values()) {
      this.#fit(text);
    }
  }

  // A guideline's box is as tall as its text, up to what the CSS allows.
  #fit(textarea) {
    textarea.style.height = "auto";
    if (textarea.scrollHeight) {
      textarea.style.height = `${textarea.scrollHeight}px`;
    }
  }

  #buildCard(item) {
    const card = this.#create("div", "lazyvimium-agent-instruction");
    const row = this.#create("div", "lazyvimium-agent-instruction-row", card);

    const toggle = this.#create("button", "lazyvimium-agent-switch", row);
    toggle.setAttribute("role", "switch");
    toggle.title = "Follow this instruction";
    toggle.setAttribute("aria-label", "Follow this instruction");
    toggle.addEventListener("click", () => {
      const current = store.items.find(i => i.id == item.id);
      store.update(item.id, { enabled: !current?.enabled });
    });

    const title = this.#create(
      "input",
      "lazyvimium-agent-instruction-title",
      row
    );
    title.type = "text";
    title.placeholder = "Instruction title";
    title.maxLength = 80;
    title.setAttribute("aria-label", "Instruction title");
    title.addEventListener("input", () =>
      store.update(item.id, { title: title.value })
    );
    title.addEventListener("keydown", event => {
      if (event.key == "Enter") {
        event.preventDefault();
        text.focus();
      }
    });

    const remove = this.#iconButton("trash", "Delete this instruction");
    remove.addEventListener("click", () => store.remove(item.id));
    row.append(remove);

    // The one file it comes with, beside its text.
    const body = this.#create("div", "lazyvimium-agent-instruction-body", card);
    const slot = this.#create("div", "lazyvimium-agent-instruction-file", body);
    const text = this.#create(
      "textarea",
      "lazyvimium-agent-instruction-text",
      body
    );
    text.rows = 3;
    text.maxLength = MAX_INSTRUCTION_CHARS;
    text.placeholder = "Create a guideline for your agent";
    text.setAttribute("aria-label", "Instruction text");
    // The store's change fits its height.
    text.addEventListener("input", () =>
      store.update(item.id, { text: text.value })
    );
    const error = this.#create(
      "div",
      "lazyvimium-agent-instruction-error",
      card
    );
    error.hidden = true;
    error.setAttribute("role", "alert");

    const parts = { card, toggle, title, text, slot, error, fileKey: null };
    // Files dropped on the card are its file; the panel's own drop never
    // sees them.
    card.addEventListener("dragover", event => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        event.stopPropagation();
        card.setAttribute("dragging", "");
      }
    });
    card.addEventListener("dragleave", event => {
      if (!card.contains(event.relatedTarget)) {
        card.removeAttribute("dragging");
      }
    });
    card.addEventListener("drop", event => {
      card.removeAttribute("dragging");
      const files = event.dataTransfer?.files;
      if (!files?.length) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const [file] = files;
      this.#setFile(
        item.id,
        parts,
        file.mozFullPath
          ? { name: file.name, path: file.mozFullPath }
          : { name: file.name, bytes: file },
        files.length > 1
      );
    });
    return parts;
  }

  // What the card's file slot shows: a button to attach one, or the file as
  // a rounded preview with a cross.
  #renderFile(parts, item) {
    const key = item.file?.path ?? "";
    if (parts.fileKey === key) {
      return;
    }
    parts.fileKey = key;
    const { file } = item;
    if (!file) {
      const add = this.#create(
        "button",
        "lazyvimium-agent-instruction-file-add"
      );
      add.title =
        "Attach a file, a picture, video or document (one per instruction)";
      add.setAttribute("aria-label", add.title);
      add.addEventListener("click", () => this.#pickFile(item.id, parts));
      parts.slot.replaceChildren(add);
      return;
    }
    const kind = mediaKind(file);
    const tile = this.#create("span", "lazyvimium-agent-attachment-tile");
    tile.setAttribute("kind", kind ?? "doc");
    tile.title = `${file.name} · ${formatSize(file.size)}`;
    if (kind) {
      const media = this.#create(kind == "image" ? "img" : "video");
      media.setAttribute("alt", file.name);
      const uri = PathUtils.toFileURI(file.path);
      if (kind == "video") {
        media.muted = true;
        media.preload = "metadata";
        media.src = `${uri}#t=0.1`;
      } else {
        media.src = uri;
      }
      tile.append(media);
    } else {
      // A document: its kind and name in place of a picture.
      const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
      tile.append(
        this.#create(
          "span",
          "lazyvimium-agent-doc-ext",
          null,
          ext.slice(0, 4).toUpperCase() || "FILE"
        ),
        this.#create("span", "lazyvimium-agent-doc-name", null, file.name)
      );
    }
    const remove = this.#create("button", "lazyvimium-agent-attachment-x");
    remove.title = `Remove ${file.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("click", () => {
      this.#showError(parts, "");
      store.removeFile(item.id);
    });
    tile.append(remove);
    parts.slot.replaceChildren(tile);
  }

  async #pickFile(id, parts) {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      this.#window.browsingContext,
      "Attach a file to the instruction",
      Ci.nsIFilePicker.modeOpen
    );
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    // The dialog is not part of the panel: moving to it must not hide it.
    this.#onPicking(true);
    let result;
    try {
      result = await new Promise(resolve => picker.open(resolve));
    } finally {
      this.#onPicking(false);
    }
    if (result == Ci.nsIFilePicker.returnOK && picker.file) {
      await this.#setFile(id, parts, {
        name: PathUtils.filename(picker.file.path),
        path: picker.file.path,
      });
    }
  }

  async #setFile(id, parts, source, extra = false) {
    try {
      if (this.#window.File.isInstance(source.bytes)) {
        // A dropped file with no path on disk: its bytes.
        if (source.bytes.size > MAX_INSTRUCTION_FILE_BYTES) {
          throw new Error("is over 25 MB");
        }
        source.bytes = new Uint8Array(await source.bytes.arrayBuffer());
      }
      await store.setFile(id, source);
      this.#showError(
        parts,
        extra
          ? "Only one file goes with an instruction: the first was kept."
          : ""
      );
    } catch (e) {
      this.#showError(parts, `${source.name} ${e.message ?? e}`);
    }
  }

  #showError(parts, message) {
    parts.error.textContent = message;
    parts.error.hidden = !message;
  }
}

// Which files get a preview: "image", "video" or null, by the type the
// browser knows or else the name's ending.
export function mediaKind({ name, type }) {
  if (
    type?.startsWith("image/") ||
    /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name)
  ) {
    return "image";
  }
  if (type?.startsWith("video/") || /\.(mp4|m4v|webm|mov|ogv)$/i.test(name)) {
    return "video";
  }
  return null;
}

export function formatSize(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
