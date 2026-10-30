// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// The agent panel: a glass panel at the side of the tab to ask the user's
// agent something about it, with the conversation above the request. It
// slides in from its side, left or right, and lays out one of three ways,
// picked in its header:
//
// - float: a card over the page, until it is closed;
// - slide: against the side of the page, hiding as Zen's compact sidebar
//   does once the mouse leaves it; a handle at that side brings it back;
// - split: beside the tab, which narrows to make room, as a split view
//   pane. When the tab, or its narrowest split view pane, would get too
//   narrow, it lays out as float (or slide, after
//   lazyvimium.agent.split-fallback) until there is room again.
//
// Dragging its edge on the page's side widens it, never narrower than it
// first opens; beside the tab, only as far as the tab keeps room.
//
// Closed, a pill keeps showing that the agent is working on the tab or has
// finished.

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ATTACH_MAX_BYTES:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs",
  ATTACH_MAX_FILES:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs",
  LazyvimiumAgents:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs",
  agentColor: "resource:///modules/lazyvimium/agent/LazyvimiumAgents.sys.mjs",
  LazyvimiumAgentInstructions:
    "resource:///modules/lazyvimium/agent/LazyvimiumAgentInstructions.sys.mjs",
  LazyvimiumAgentInstructionsView:
    "resource:///modules/lazyvimium/ui/LazyvimiumAgentInstructionsView.sys.mjs",
  formatSize:
    "resource:///modules/lazyvimium/ui/LazyvimiumAgentInstructionsView.sys.mjs",
  mediaKind:
    "resource:///modules/lazyvimium/ui/LazyvimiumAgentInstructionsView.sys.mjs",
  LazyvimiumAgentUiView:
    "resource:///modules/lazyvimium/ui/LazyvimiumAgentUiView.sys.mjs",
  LazyvimiumPicker:
    "resource:///modules/lazyvimium/ui/LazyvimiumPicker.sys.mjs",
  LazyvimiumTheme: "resource:///modules/lazyvimium/ui/LazyvimiumTheme.sys.mjs",
  renderMarkdown:
    "resource:///modules/lazyvimium/ui/LazyvimiumMarkdown.sys.mjs",
});

const HTML_NS = "http://www.w3.org/1999/xhtml";
const STEP_ICONS = { running: "◌", done: "✓", failed: "✕" };

const PREF_BRANCH = "lazyvimium.agent.";
const PREF_LAYOUT = "lazyvimium.agent.layout";
const PREF_SIDE = "lazyvimium.agent.side";
const PREF_WIDTH = "lazyvimium.agent.width";
const PREF_FALLBACK = "lazyvimium.agent.split-fallback";

const LAYOUTS = {
  float: "Floating over the page",
  slide: "Slide in from the side, hide when the mouse leaves",
  split: "Side by side with the tab",
};

// A page narrower than this beside the docked panel is too cramped to use.
const MIN_PANE_WIDTH = 420;
// The panel's width when it first opens, and the narrowest it gets.
const MIN_WIDTH = 420;
// A floating panel's inset on each side (lazyvimium.css).
const FLOAT_INSET = 10;
// How long the slid-in panel stays once the mouse leaves it, and how long the
// mouse rests on the handle before it slides in, after Zen's compact sidebar
// (zen.view.compact.sidebar-keep-hover.duration, hover-hack-delay).
const KEEP_HOVER_MS = 400;
const HANDLE_HOVER_MS = 100;
// Zen's compact sidebar spring (compact-mode/sidebar.inc.css), sampled
// coarser.
const SPRING =
  "linear(0, 0.0388 4%, 0.1313 8%, 0.2498 12%, 0.3757 16%, 0.497 20%, 0.6068 24%, 0.7018 28%, 0.781 32%, 0.8448 36%, 0.8948 40%, 0.9327 44%, 0.9603 48%, 0.9804 52%, 0.994 56%, 1.0025 60%, 1.0075 64%, 1.0101 68%, 1.0109 72%, 1.0104 76%, 1.0084 84%, 1.0045 95%, 1)";

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function readPrefs() {
  const layout = Services.prefs.getStringPref(PREF_LAYOUT, "float");
  const fallback = Services.prefs.getStringPref(PREF_FALLBACK, "float");
  return {
    layout: layout in LAYOUTS ? layout : "float",
    side:
      Services.prefs.getStringPref(PREF_SIDE, "right") == "left"
        ? "left"
        : "right",
    width: Math.max(
      MIN_WIDTH,
      Services.prefs.getIntPref(PREF_WIDTH, MIN_WIDTH)
    ),
    fallback: fallback == "slide" ? "slide" : "float",
  };
}

export class LazyvimiumAgentDock {
  #window;
  #host;
  #root;
  #log;
  #input;
  #agentChip;
  #modelChip;
  #tabChip;
  #attachRow;
  #sendButton;
  #instructionsButton;
  #instructions;
  // What the user attached to the request they are writing: {name, size,
  // path} for a file on disk, {name, size, bytes} for a pasted one.
  #attachments = [];
  // Why the last file was not attached, shown instead of the hint until the
  // next key.
  #notice = "";
  #status;
  #hint;
  #pill;
  #handle;
  #grip;
  #uiView;
  #layoutButtons = new Map();
  #sideButton;
  #conversation = null;
  #unsubscribe = null;
  #timer = null;
  #onChange;
  #open = false;
  #closing = false;
  #animation = null;
  #prefs = readPrefs();
  // The layout in use: the one picked, or its fallback while a split has no
  // room.
  #layout = this.#prefs.layout;
  #hovered = false;
  #hideTimer = null;
  #handleTimer = null;
  #picking = false;
  #renderQueued = false;
  #layoutQueued = false;
  #resizing = false;
  // Each message's row, and what it showed when it was built.
  #rows = new WeakMap();

  /**
   * @param {Window} window A browser window.
   * @param {object} options
   * @param {() => void} options.onChange Called when the dock opens or
   *   closes.
   */
  constructor(window, { onChange }) {
    this.#window = window;
    this.#onChange = onChange;
    const document = window.document;
    const create = (tag, className, parent) => {
      const element = document.createElementNS(HTML_NS, tag);
      if (className) {
        element.className = className;
      }
      parent?.append(element);
      return element;
    };
    const roundButton = (className, parent, title) => {
      const button = create(
        "button",
        `lazyvimium-agent-round-button ${className}`,
        parent
      );
      button.title = title;
      button.setAttribute("aria-label", title);
      // A click leaves the keys where the user was typing.
      button.addEventListener("mousedown", event => event.preventDefault());
      return button;
    };
    const iconButton = (className, parent, title) => {
      const button = create(
        "button",
        `lazyvimium-agent-icon-button ${className}`,
        parent
      );
      button.title = title;
      button.setAttribute("aria-label", title);
      return button;
    };

    this.#root = create("div");
    this.#root.id = "lazyvimium-agent-dock";
    this.#root.hidden = true;
    this.#root.setAttribute("role", "dialog");
    this.#root.setAttribute("aria-label", "Ask your agent");

    const header = create("div", "lazyvimium-agent-header", this.#root);
    this.#agentChip = create("button", "lazyvimium-agent-chip", header);
    this.#agentChip.title = "Pick an agent (Tab)";
    this.#agentChip.addEventListener("click", () => this.pickAgent());
    this.#modelChip = create("button", "lazyvimium-agent-model", header);
    this.#modelChip.title = "Pick a model (<leader>am)";
    this.#modelChip.addEventListener("click", () => this.pickModel());
    this.#status = create("span", "lazyvimium-agent-status", header);
    create("span", "lazyvimium-agent-spacer", header);
    const layouts = create("div", "lazyvimium-agent-layouts", header);
    layouts.setAttribute("role", "group");
    layouts.setAttribute("aria-label", "Layout");
    for (const [layout, title] of Object.entries(LAYOUTS)) {
      const button = iconButton(`layout-${layout}`, layouts, title);
      button.addEventListener("click", () =>
        Services.prefs.setStringPref(PREF_LAYOUT, layout)
      );
      this.#layoutButtons.set(layout, button);
    }
    this.#sideButton = iconButton("side", header, "");
    this.#sideButton.addEventListener("click", () =>
      Services.prefs.setStringPref(
        PREF_SIDE,
        this.#prefs.side == "right" ? "left" : "right"
      )
    );
    iconButton("close", header, "Close (Esc)").addEventListener("click", () =>
      this.close()
    );

    this.#log = create("div", "lazyvimium-agent-log", this.#root);
    this.#log.setAttribute("role", "log");
    this.#log.setAttribute("aria-live", "polite");
    this.#uiView = new lazy.LazyvimiumAgentUiView(window, {
      onPrompt: text => this.#askFromPage(text),
    });

    const composer = create("div", "lazyvimium-agent-composer", this.#root);
    this.#tabChip = create("div", "lazyvimium-agent-tab", composer);
    this.#attachRow = create("div", "lazyvimium-agent-attachments", composer);
    this.#attachRow.hidden = true;
    this.#input = create("textarea", "lazyvimium-agent-input", composer);
    this.#input.rows = 1;
    this.#input.setAttribute("aria-label", "Ask your agent");
    this.#input.addEventListener("keydown", event => this.#onKey(event));
    this.#input.addEventListener("input", () => {
      this.#fitInput();
      this.#syncComposer();
    });
    this.#input.addEventListener("paste", event => {
      if (event.clipboardData?.files.length) {
        event.preventDefault();
        this.#attachDomFiles(event.clipboardData.files);
      }
    });
    const bar = create("div", "lazyvimium-agent-composer-bar", composer);
    const attach = roundButton("attach", bar, "Attach files");
    attach.addEventListener("click", () => this.#pickFiles());
    create("span", "lazyvimium-agent-spacer", bar);
    this.#instructionsButton = roundButton(
      "instructions",
      bar,
      "Agent instructions"
    );
    this.#instructionsButton.addEventListener("click", () =>
      this.#instructions.open()
    );
    this.#sendButton = roundButton("send", bar, "Send (Enter)");
    this.#sendButton.addEventListener("click", () => {
      if (this.#conversation?.running) {
        this.#conversation.stop();
      } else {
        this.#send();
      }
    });
    this.#hint = create("div", "lazyvimium-agent-hint", composer);
    // Files dropped anywhere on the panel.
    this.#root.addEventListener("dragover", event => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        this.#root.setAttribute("dragging", "");
      }
    });
    this.#root.addEventListener("dragleave", event => {
      if (!this.#root.contains(event.relatedTarget)) {
        this.#root.removeAttribute("dragging");
      }
    });
    this.#root.addEventListener("drop", event => {
      this.#root.removeAttribute("dragging");
      if (event.dataTransfer?.files.length) {
        event.preventDefault();
        this.#attachDomFiles(event.dataTransfer.files);
      }
    });

    this.#instructions = new lazy.LazyvimiumAgentInstructionsView(window, {
      parent: this.#root,
      onPicking: busy => {
        this.#picking = busy;
      },
      onClose: () => {
        if (this.#open) {
          this.#input.focus();
        }
      },
    });
    const offInstructions = lazy.LazyvimiumAgentInstructions.subscribe(() =>
      this.#syncInstructions()
    );
    lazy.LazyvimiumAgentInstructions.load();
    window.addEventListener("unload", offInstructions, { once: true });

    this.#grip = create("div", "lazyvimium-agent-grip", this.#root);
    this.#grip.setAttribute("role", "separator");
    this.#grip.setAttribute("aria-orientation", "vertical");
    this.#grip.addEventListener("pointerdown", event =>
      this.#startResize(event)
    );
    this.#grip.addEventListener("dblclick", () =>
      Services.prefs.clearUserPref(PREF_WIDTH)
    );

    this.#root.addEventListener("mouseenter", () => {
      this.#hovered = true;
      this.#cancelHide();
    });
    this.#root.addEventListener("mouseleave", () => {
      this.#hovered = false;
      this.#scheduleHide();
    });

    this.#pill = create("button");
    this.#pill.id = "lazyvimium-agent-pill";
    this.#pill.hidden = true;
    this.#pill.addEventListener("click", () =>
      this.open(this.#window.gBrowser.selectedBrowser)
    );

    // The slid-out panel's edge: resting the mouse on it slides it back in.
    this.#handle = create("div");
    this.#handle.id = "lazyvimium-agent-handle";
    this.#handle.hidden = true;
    this.#handle.addEventListener("mouseenter", () => {
      this.#handleTimer = this.#window.setTimeout(() => {
        this.#handleTimer = null;
        this.open(this.#window.gBrowser.selectedBrowser, { focus: false });
      }, HANDLE_HOVER_MS);
    });
    this.#handle.addEventListener("mouseleave", () => {
      this.#window.clearTimeout(this.#handleTimer);
      this.#handleTimer = null;
    });
    this.#handle.addEventListener("click", () =>
      this.open(this.#window.gBrowser.selectedBrowser)
    );

    // Beside the tab box, where Zen's split view panes and sidebar sit.
    this.#host =
      document.getElementById("zen-tabbox-wrapper") ??
      document.getElementById("browser") ??
      document.documentElement;
    this.#host.append(this.#root, this.#pill, this.#handle);

    const relayout = () => this.#queueLayout();
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      this.#onTabSelect();
      relayout();
    });
    window.addEventListener("resize", relayout);
    window.addEventListener("ZenViewSplitter:SplitViewActivated", relayout);
    window.addEventListener("ZenViewSplitter:SplitViewDeactivated", relayout);
    const onPrefs = () => {
      this.#prefs = readPrefs();
      this.#applyLayout();
      // The model chip.
      this.#queueRender();
    };
    Services.prefs.addObserver(PREF_BRANCH, onPrefs);
    const offTheme = lazy.LazyvimiumTheme.onChange(() => {
      this.#queueRender();
      this.#syncPill();
    });
    window.addEventListener(
      "unload",
      () => {
        Services.prefs.removeObserver(PREF_BRANCH, onPrefs);
        offTheme();
        window.clearInterval(this.#timer);
      },
      { once: true }
    );
    this.#applyLayout();
  }

  get isOpen() {
    return this.#open;
  }

  /**
   * The layout in use, which is the one picked unless a split has no room.
   *
   * @returns {"float"|"slide"|"split"}
   */
  get layout() {
    return this.#layout;
  }

  /**
   * Open the dock on a tab, with its conversation.
   *
   * @param {Element} browser
   * @param {object} [options]
   * @param {boolean} [options.focus] Give it the keys.
   */
  async open(browser, { focus = true } = {}) {
    this.#open = true;
    this.#cancelHide();
    this.#show();
    this.#syncPill();
    this.#onChange();
    const conversation = await lazy.LazyvimiumAgents.open(browser);
    if (!this.#open || this.#window.gBrowser.selectedBrowser != browser) {
      return;
    }
    this.#bind(conversation);
    if (conversation) {
      conversation.unseen = false;
    }
    this.#render();
    if (focus) {
      this.#input.focus();
    }
  }

  close() {
    if (!this.#open) {
      return;
    }
    const focused = this.#root.contains(this.#window.document.activeElement);
    this.#open = false;
    this.#instructions.close();
    this.#cancelHide();
    this.#hide();
    this.#syncPill();
    this.#onChange();
    // Only hand the keys back when the dock had them, not when another
    // buffer opening closed it.
    if (focused) {
      this.#window.gBrowser.selectedBrowser.focus();
    }
  }

  /**
   * Another buffer of the browser UI takes the keys. A panel beside the tab
   * stays, as a split view pane would; one over the page goes.
   */
  release() {
    if (this.#layout != "split") {
      this.close();
    }
  }

  /**
   * @param {Node} node
   * @returns {boolean} Whether the node is part of the dock.
   */
  contains(node) {
    return (
      !!node &&
      (this.#root.contains(node) ||
        this.#pill.contains(node) ||
        this.#handle.contains(node))
    );
  }

  /**
   * @param {Element} browser
   */
  toggle(browser) {
    if (this.#open) {
      this.close();
    } else {
      this.open(browser);
    }
  }

  stop() {
    this.#conversation?.stop();
  }

  /**
   * Start over on the tab: stop the turn and forget the conversation.
   *
   * @param {Element} browser
   */
  reset(browser) {
    lazy.LazyvimiumAgents.reset(browser);
    this.#bind(null);
    this.open(browser);
  }

  /**
   * Open the tab's conversation log, or the folder of all of them, in a new
   * tab next to it.
   *
   * @param {Element} browser
   */
  async openLog(browser) {
    const log = lazy.LazyvimiumAgents.conversationFor(browser)?.log;
    await log?.flush();
    const dir = lazy.LazyvimiumAgents.logDir;
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = log?.path ?? dir;
    this.#window.openTrustedLinkIn(PathUtils.toFileURI(path), "tab", {
      relatedToCurrent: true,
    });
  }

  /**
   * Choose the agent for this tab, and for new ones.
   */
  async pickAgent() {
    const agents = await lazy.LazyvimiumAgents.agents({ refresh: true });
    const current = this.#conversation?.agent.id;
    // The picker is not part of the panel: moving to it must not hide it.
    this.#picking = true;
    let index;
    try {
      index = await lazy.LazyvimiumPicker.open(this.#window, {
        title: "Agents",
        items: agents.map(agent => ({
          label: `${agent.name}${agent.id == current ? "  ·  current" : ""}`,
          detail: agent.path
            ? `${agent.version ?? ""} ${agent.path}`.trim()
            : `not installed: ${agent.install}`,
        })),
      });
    } finally {
      this.#picking = false;
    }
    const agent = agents[index];
    if (!agent?.path) {
      this.#input.focus();
      return;
    }
    lazy.LazyvimiumAgents.setDefaultAgent(agent.id);
    this.#conversation?.setAgent(agent);
    if (this.#open) {
      this.#render();
      this.#input.focus();
    } else {
      this.open(this.#window.gBrowser.selectedBrowser);
    }
  }

  /**
   * Choose the model the tab's agent runs with, from the ones its CLI lists;
   * it applies from the next request, in this conversation too.
   */
  async pickModel() {
    const agent =
      this.#conversation?.agent ?? (await lazy.LazyvimiumAgents.defaultAgent());
    if (!agent) {
      return;
    }
    const current = lazy.LazyvimiumAgents.modelFor(agent.id);
    this.#modelChip.textContent = "listing models…";
    const models = await lazy.LazyvimiumAgents.models(agent);
    this.#renderModel();
    const items = [
      { id: "", name: "Default", detail: `what ${agent.name}'s settings pick` },
      ...models,
    ];
    // A model picked before that the list no longer has stays pickable.
    if (current && !models.some(model => model.id == current)) {
      items.push({ id: current, name: current, detail: "" });
    }
    this.#picking = true;
    let index;
    try {
      index = await lazy.LazyvimiumPicker.open(this.#window, {
        title: `${agent.name} models`,
        items: items.map(model => ({
          label: `${model.name}${model.id == current ? "  ·  current" : ""}`,
          detail: [model.id, model.detail].filter(Boolean).join(" · "),
        })),
      });
    } finally {
      this.#picking = false;
    }
    const model = items[index];
    if (model) {
      lazy.LazyvimiumAgents.setModel(agent.id, model.id);
    }
    if (this.#open) {
      this.#input.focus();
    }
  }

  #renderModel() {
    const agent = this.#conversation?.agent;
    this.#modelChip.hidden = !agent;
    if (agent) {
      this.#modelChip.textContent =
        lazy.LazyvimiumAgents.modelFor(agent.id) || "default model";
    }
  }

  // Layout.

  // The widest the panel can be beside the tab while the tab, and each of
  // its split view panes, keeps at least MIN_PANE_WIDTH.
  #splitMaxWidth() {
    const window = this.#window;
    const panels = window.gBrowser.tabpanels;
    const total = panels?.getBoundingClientRect().width;
    if (!total) {
      return Infinity;
    }
    const gap =
      parseFloat(
        window
          .getComputedStyle(window.document.documentElement)
          .getPropertyValue("--zen-element-separation")
      ) || 8;
    const docked =
      this.#layout == "split" && !this.#root.hidden
        ? this.#root.getBoundingClientRect().width + gap
        : 0;
    let share = 1;
    const splitter = window.gZenViewSplitter;
    if (splitter?.splitViewActive) {
      for (const tab of splitter._data[splitter.currentView]?.tabs ?? []) {
        const pane = tab.linkedBrowser?.closest(".browserSidebarContainer");
        const width = pane?.getBoundingClientRect().width;
        if (width) {
          share = Math.min(share, width / total);
        }
      }
    }
    // Each pane keeps its share of what the panel leaves of the tab box.
    return Math.floor(total + docked - gap - MIN_PANE_WIDTH / share);
  }

  // The widest the panel can get in the layout in use.
  #maxWidth() {
    return this.#layout == "split"
      ? this.#splitMaxWidth()
      : this.#host.clientWidth - 2 * FLOAT_INSET;
  }

  #queueLayout() {
    if (this.#layoutQueued || this.#prefs.layout != "split") {
      return;
    }
    this.#layoutQueued = true;
    this.#window.requestAnimationFrame(() => {
      this.#layoutQueued = false;
      this.#applyLayout();
    });
  }

  #applyLayout() {
    const { layout: picked, side, fallback } = this.#prefs;
    const splitMax = picked == "split" ? this.#splitMaxWidth() : Infinity;
    const layout = splitMax < MIN_WIDTH ? fallback : picked;
    const changed = layout != this.#layout;
    this.#layout = layout;
    for (const element of [this.#root, this.#pill, this.#handle]) {
      element.setAttribute("layout", layout);
      element.setAttribute("side", side);
    }
    // Beside the tab the panel gives up its width, down to MIN_WIDTH, before
    // the tab gets too narrow.
    const width =
      layout == "split"
        ? Math.min(this.#prefs.width, splitMax)
        : this.#prefs.width;
    if (!this.#resizing) {
      this.#root.style.setProperty("--lazyvimium-agent-width", `${width}px`);
    }
    const fixed = layout == "split" && splitMax <= MIN_WIDTH;
    this.#grip.toggleAttribute("disabled", fixed);
    this.#grip.setAttribute("aria-disabled", String(fixed));
    this.#grip.title = fixed
      ? "No room to widen it beside this tab: float it to make it wider"
      : "Drag to resize · double-click for the narrowest";
    const fellBack = picked == "split" && layout != "split";
    this.#root.toggleAttribute("fallback", fellBack);
    for (const [name, button] of this.#layoutButtons) {
      button.setAttribute("aria-pressed", String(name == picked));
    }
    const split = this.#layoutButtons.get("split");
    split.title = fellBack
      ? `${LAYOUTS.split}: no room beside this tab, so it floats for now`
      : LAYOUTS.split;
    const other = side == "right" ? "left" : "right";
    this.#sideButton.setAttribute("side", side);
    this.#sideButton.title = `Move to the ${other}`;
    this.#sideButton.setAttribute("aria-label", this.#sideButton.title);
    if (changed && this.#open && !this.#closing) {
      this.#animate(true);
    }
    if (layout != "slide") {
      this.#cancelHide();
    }
    this.#syncPill();
  }

  // Dragging the edge on the page's side widens or narrows the panel; the
  // width is kept for every layout once the mouse lets go.
  #startResize(event) {
    if (event.button != 0 || this.#grip.hasAttribute("disabled")) {
      return;
    }
    event.preventDefault();
    const grip = this.#grip;
    const startX = event.clientX;
    const start = Math.round(this.#root.getBoundingClientRect().width);
    const max = Math.max(MIN_WIDTH, this.#maxWidth());
    const sign = this.#prefs.side == "right" ? -1 : 1;
    let width = start;
    const move = moved => {
      width = Math.round(
        Math.min(
          max,
          Math.max(MIN_WIDTH, start + sign * (moved.clientX - startX))
        )
      );
      this.#root.style.setProperty("--lazyvimium-agent-width", `${width}px`);
    };
    // Letting go releases the capture, as does anything that steals it.
    const end = () => {
      grip.removeEventListener("pointermove", move);
      this.#resizing = false;
      this.#root.removeAttribute("resizing");
      if (width != start) {
        Services.prefs.setIntPref(PREF_WIDTH, width);
      }
      if (!this.#hovered) {
        this.#scheduleHide();
      }
    };
    this.#resizing = true;
    this.#root.setAttribute("resizing", "");
    grip.setPointerCapture(event.pointerId);
    grip.addEventListener("pointermove", move);
    grip.addEventListener("lostpointercapture", end, { once: true });
  }

  #show() {
    if (!this.#root.hidden && !this.#closing) {
      return;
    }
    const wasHidden = this.#root.hidden;
    this.#closing = false;
    this.#root.hidden = false;
    this.#applyLayout();
    if (wasHidden || this.#animation) {
      this.#animate(true);
    }
  }

  #hide() {
    this.#closing = true;
    this.#animate(false).then(() => {
      if (this.#closing) {
        this.#closing = false;
        this.#root.hidden = true;
        this.#applyLayout();
      }
    });
  }

  // Slide in from the panel's side, or out to it. Beside the tab the panel
  // starts past the tab box's edge, its outer margin taking back its width,
  // so the page makes room as it comes in and its text never reflows.
  #animate(showing) {
    this.#animation?.cancel();
    this.#animation = null;
    const window = this.#window;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return Promise.resolve();
    }
    const left = this.#prefs.side == "left";
    const sign = left ? -1 : 1;
    const outer = left ? "marginLeft" : "marginRight";
    const gap =
      parseFloat(
        window.getComputedStyle(this.#root)[left ? "marginRight" : "marginLeft"]
      ) || 0;
    const keyframes =
      this.#layout == "split"
        ? [
            {
              [outer]: `${-this.#root.getBoundingClientRect().width - gap}px`,
              opacity: 0,
            },
            { [outer]: "0px", opacity: 1 },
          ]
        : [
            {
              transform: `translateX(calc(${sign} * (100% + 24px)))`,
              opacity: 0,
            },
            { transform: "translateX(0)", opacity: 1 },
          ];
    const animation = this.#root.animate(keyframes, {
      duration: showing ? 360 : 180,
      easing: showing ? SPRING : "cubic-bezier(0.4, 0, 1, 1)",
      direction: showing ? "normal" : "reverse",
    });
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

  // The slid-in panel hides a moment after the mouse leaves it, unless it
  // waits on the user.
  #scheduleHide() {
    this.#cancelHide();
    if (
      this.#layout != "slide" ||
      !this.#open ||
      this.#picking ||
      this.#resizing ||
      this.#conversation?.pendingConfirm
    ) {
      return;
    }
    this.#hideTimer = this.#window.setTimeout(() => {
      this.#hideTimer = null;
      if (!this.#hovered && !this.#picking) {
        this.close();
      }
    }, KEEP_HOVER_MS);
  }

  #cancelHide() {
    if (this.#hideTimer) {
      this.#window.clearTimeout(this.#hideTimer);
      this.#hideTimer = null;
    }
  }

  // Conversation.

  #bind(conversation) {
    if (conversation == this.#conversation) {
      return;
    }
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#conversation = conversation;
    if (conversation) {
      this.#unsubscribe = conversation.subscribe(() => this.#onConversation());
    }
  }

  #onConversation() {
    const conversation = this.#conversation;
    if (this.#open && conversation) {
      conversation.unseen = false;
    }
    if (conversation?.pendingConfirm && !this.#open) {
      // The agent waits on the user: show the question.
      this.open(conversation.browser);
      return;
    }
    // Text streams in a delta at a time: draw once a frame.
    this.#queueRender();
    this.#syncPill();
  }

  #onTabSelect() {
    const browser = this.#window.gBrowser.selectedBrowser;
    if (this.#open) {
      // Beside the tab the panel follows it without taking the keys, and so
      // it does while the agent works: the tab may be one it brought to the
      // front to type in.
      const running = lazy.LazyvimiumAgents.conversationFor(browser)?.running;
      this.open(browser, { focus: this.#layout != "split" && !running });
    } else {
      this.#bind(lazy.LazyvimiumAgents.conversationFor(browser));
      this.#syncPill();
    }
  }

  #onKey(event) {
    const conversation = this.#conversation;
    const empty = !this.#input.value;
    const pending = conversation?.pendingConfirm;
    const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
    const ctrl =
      event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    let handled = true;
    if (this.#notice) {
      this.#notice = "";
      this.#queueRender();
    }
    if (event.key == "Escape") {
      if (this.#layout == "split") {
        // Back to the page, as leaving a vim window; the panel stays.
        this.#window.gBrowser.selectedBrowser.focus();
      } else {
        this.close();
      }
    } else if (
      pending &&
      empty &&
      plain &&
      (event.key == "y" || event.key == "n")
    ) {
      pending.answer(event.key == "y");
    } else if (event.key == "Enter" && !event.shiftKey) {
      this.#send();
    } else if (event.key == "c" && event.ctrlKey && conversation?.running) {
      conversation.stop();
    } else if (ctrl && ["w", "u", "h"].includes(event.key)) {
      // Insert mode's keys, not the browser's: Ctrl+W would close the tab.
      this.#deleteBack(event.key);
    } else if (event.key == "Tab" && plain) {
      this.#cycleAgent(event.shiftKey ? -1 : 1);
    } else {
      handled = false;
    }
    if (handled) {
      event.preventDefault();
    }
    // The page's keys never see what is typed here.
    event.stopPropagation();
  }

  // Ctrl+W deletes the word before the cursor, Ctrl+U the line up to it and
  // Ctrl+H a character, as in vim's insert mode.
  #deleteBack(key) {
    const input = this.#input;
    const end = input.selectionEnd;
    let start = input.selectionStart;
    if (start == end) {
      const before = input.value.slice(0, end);
      if (key == "w") {
        start = end - before.match(/(?:\w+|[^\w\s]+)?\s*$/)[0].length;
      } else if (key == "u") {
        start = before.lastIndexOf("\n") + 1;
      } else {
        start = Math.max(0, end - 1);
      }
      if (start == end && key != "h" && start > 0) {
        // At the start of a line, join it to the one before.
        start--;
      }
    }
    if (start == end) {
      return;
    }
    input.setSelectionRange(start, end);
    // Through the editor, so Ctrl+Z brings it back.
    if (!this.#window.document.execCommand("delete")) {
      input.setRangeText("", start, end, "end");
    }
    this.#fitInput();
  }

  async #cycleAgent(direction) {
    const conversation = this.#conversation;
    if (!conversation || conversation.running) {
      return;
    }
    const installed = (await lazy.LazyvimiumAgents.agents()).filter(
      agent => agent.path
    );
    const index = installed.findIndex(
      agent => agent.id == conversation.agent.id
    );
    const next =
      installed[(index + direction + installed.length) % installed.length];
    if (next) {
      lazy.LazyvimiumAgents.setDefaultAgent(next.id);
      conversation.setAgent(next);
    }
  }

  // Attaching files.

  async #pickFiles() {
    const picker = Cc["@mozilla.org/filepicker;1"].createInstance(
      Ci.nsIFilePicker
    );
    picker.init(
      this.#window.browsingContext,
      "Attach files",
      Ci.nsIFilePicker.modeOpenMultiple
    );
    picker.appendFilters(Ci.nsIFilePicker.filterAll);
    // The dialog is not part of the panel: moving to it must not hide it.
    this.#picking = true;
    let result;
    try {
      result = await new Promise(resolve => picker.open(resolve));
    } finally {
      this.#picking = false;
    }
    if (result == Ci.nsIFilePicker.returnOK) {
      const paths = [];
      for (const files = picker.files; files.hasMoreElements(); ) {
        paths.push(files.getNext().QueryInterface(Ci.nsIFile).path);
      }
      await this.#attachPaths(paths);
    }
    if (this.#open) {
      this.#input.focus();
    }
  }

  // Dropped or pasted files: the browser's own know where they live; a
  // picture from the clipboard does not, so its bytes are kept.
  async #attachDomFiles(files) {
    const found = [];
    for (const file of files) {
      if (file.mozFullPath) {
        found.push(file.mozFullPath);
      } else if (file.size > lazy.ATTACH_MAX_BYTES) {
        this.#refuse(file.name, "is over 25 MB");
      } else {
        found.push({
          name: file.name || "pasted-file",
          size: file.size,
          type: file.type,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
      }
    }
    await this.#attachPaths(found);
  }

  async #attachPaths(found) {
    for (const item of found) {
      if (this.#attachments.length >= lazy.ATTACH_MAX_FILES) {
        this.#refuse(
          "",
          `Only ${lazy.ATTACH_MAX_FILES} files go with a request`
        );
        break;
      }
      if (typeof item != "string") {
        this.#attachments.push(item);
        continue;
      }
      const name = PathUtils.filename(item);
      let info;
      try {
        info = await IOUtils.stat(item);
      } catch (e) {
        this.#refuse(name, "could not be read");
        continue;
      }
      if (info.type == "directory") {
        this.#refuse(name, "is a folder");
      } else if (info.size > lazy.ATTACH_MAX_BYTES) {
        this.#refuse(name, "is over 25 MB");
      } else if (!this.#attachments.some(file => file.path == item)) {
        this.#attachments.push({ name, size: info.size, path: item });
      }
    }
    this.#renderAttachments();
    this.#syncComposer();
    this.#queueRender();
  }

  #refuse(name, why) {
    this.#notice = name ? `${name} ${why}` : why;
  }

  #removeAttachment(file) {
    this.#releasePreviews([file]);
    this.#attachments = this.#attachments.filter(other => other != file);
    this.#renderAttachments();
    this.#syncComposer();
  }

  #renderAttachments() {
    this.#attachRow.hidden = !this.#attachments.length;
    this.#attachRow.replaceChildren(
      ...this.#attachments.map(file => {
        const kind = lazy.mediaKind(file);
        if (kind) {
          return this.#renderTile(file, kind);
        }
        const chip = this.#create("span", "lazyvimium-agent-attachment");
        const name = this.#create(
          "span",
          "lazyvimium-agent-attachment-name",
          file.name
        );
        const size = this.#create(
          "span",
          "lazyvimium-agent-attachment-size",
          lazy.formatSize(file.size)
        );
        const remove = this.#create("button", "lazyvimium-agent-attachment-x");
        remove.title = `Remove ${file.name}`;
        remove.setAttribute("aria-label", remove.title);
        remove.addEventListener("mousedown", event => event.preventDefault());
        remove.addEventListener("click", () => this.#removeAttachment(file));
        chip.title = file.path ?? file.name;
        chip.append(name, size, remove);
        return chip;
      })
    );
  }

  // A picture or video: a rounded preview of it, not a chip.
  #renderTile(file, kind) {
    const tile = this.#create("span", "lazyvimium-agent-attachment-tile");
    tile.setAttribute("kind", kind);
    tile.title = `${file.name} · ${lazy.formatSize(file.size)}`;
    file.url ??= file.path
      ? PathUtils.toFileURI(file.path)
      : this.#window.URL.createObjectURL(
          new this.#window.Blob([file.bytes], { type: file.type })
        );
    const media = this.#create(kind == "image" ? "img" : "video");
    media.setAttribute("alt", file.name);
    if (kind == "video") {
      // Its first frame; it never plays.
      media.muted = true;
      media.preload = "metadata";
      media.src = `${file.url}#t=0.1`;
    } else {
      media.src = file.url;
    }
    const remove = this.#create("button", "lazyvimium-agent-attachment-x");
    remove.title = `Remove ${file.name}`;
    remove.setAttribute("aria-label", remove.title);
    remove.addEventListener("mousedown", event => event.preventDefault());
    remove.addEventListener("click", () => this.#removeAttachment(file));
    tile.append(media, remove);
    return tile;
  }

  // The copies of pasted pictures the previews were made from.
  #releasePreviews(files) {
    for (const file of files) {
      if (file.bytes && file.url) {
        this.#window.URL.revokeObjectURL(file.url);
      }
    }
  }

  // The send button: it sends what is written or attached, and stops the
  // agent while it works.
  #syncComposer() {
    const conversation = this.#conversation;
    const running = !!conversation?.running;
    const ready =
      !!conversation &&
      (!!this.#input.value.trim() || !!this.#attachments.length);
    this.#sendButton.toggleAttribute("running", running);
    this.#sendButton.disabled = !running && !ready;
    this.#sendButton.title = running ? "Stop (Ctrl+C)" : "Send (Enter)";
    this.#sendButton.setAttribute("aria-label", this.#sendButton.title);
  }

  #syncInstructions() {
    const count = lazy.LazyvimiumAgentInstructions.activeCount;
    this.#instructionsButton.toggleAttribute("active", count > 0);
    this.#instructionsButton.title = count
      ? `Agent instructions · ${count} on`
      : "Agent instructions";
    this.#instructionsButton.setAttribute(
      "aria-label",
      this.#instructionsButton.title
    );
  }

  #send() {
    const conversation = this.#conversation;
    const text = this.#input.value.trim();
    const files = this.#attachments;
    if (!conversation || (!text && !files.length) || conversation.running) {
      return;
    }
    this.#input.value = "";
    this.#attachments = [];
    this.#releasePreviews(files);
    this.#renderAttachments();
    this.#fitInput();
    this.#syncComposer();
    // The page takes focus while the agent types and presses keys in it;
    // the dock stays open, and <leader>aa comes back to it.
    if (this.#window.gBrowser.selectedBrowser == conversation.browser) {
      conversation.browser.focus();
    }
    conversation
      .send(
        text,
        files.map(({ name, path, bytes }) => ({ name, path, bytes }))
      )
      .catch(e => {
        console.error("Lazyvimium: the agent turn failed", e);
      });
  }

  /**
   * A request from a page the agent shows in the panel
   * (LazyvimiumUiParent).
   *
   * @param {Element} browser The page's browser.
   * @param {string} name
   * @param {object} data
   * @returns {true|string} true, or why not.
   */
  uiRequest(browser, name, data) {
    return this.#uiView.request(browser, name, data);
  }

  // A page's follow-up question, sent as if the user typed it.
  #askFromPage(text) {
    const conversation = this.#conversation;
    if (!conversation) {
      return "no agent to ask.";
    }
    if (conversation.running) {
      return `${conversation.agent.name} is still working; ask again when it is done.`;
    }
    conversation.send(text).catch(e => {
      console.error("Lazyvimium: the agent turn failed", e);
    });
    return true;
  }

  #fitInput() {
    this.#input.style.height = "auto";
    this.#input.style.height = `${Math.min(this.#input.scrollHeight, 160)}px`;
  }

  // Drawing.

  #queueRender() {
    if (this.#renderQueued) {
      return;
    }
    this.#renderQueued = true;
    this.#window.requestAnimationFrame(() => {
      this.#renderQueued = false;
      this.#render();
    });
  }

  #create(tag, className, text) {
    const element = this.#window.document.createElementNS(HTML_NS, tag);
    if (className) {
      element.className = className;
    }
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  }

  #render() {
    const conversation = this.#conversation;
    const atBottom =
      this.#log.scrollTop + this.#log.clientHeight >=
      this.#log.scrollHeight - 8;

    const rows = [];
    const messages = conversation?.messages ?? [];
    if (!conversation) {
      rows.push(...this.#renderNoAgent());
    } else if (!messages.length) {
      rows.push(this.#renderEmpty(conversation.agent));
    }
    for (const message of messages) {
      const streaming =
        !!conversation.running &&
        message.type == "agent" &&
        message == messages.at(-1);
      rows.push(this.#rowFor(message, streaming));
    }
    // Keep the rows that did not change, so a streaming answer redraws only
    // itself and a selection elsewhere survives.
    let child = this.#log.firstChild;
    for (const row of rows) {
      if (row == child) {
        child = child.nextSibling;
      } else {
        this.#log.insertBefore(row, child);
      }
    }
    while (child) {
      const next = child.nextSibling;
      child.remove();
      child = next;
    }
    this.#uiView.attach(this.#log);
    if (atBottom) {
      this.#log.scrollTop = this.#log.scrollHeight;
    }

    const agent = conversation?.agent;
    this.#agentChip.textContent = agent ? agent.name : "No agent";
    this.#agentChip.style.setProperty(
      "--lazyvimium-agent-color",
      lazy.agentColor(agent?.id)
    );
    this.#renderModel();
    const browser =
      conversation?.browser ?? this.#window.gBrowser.selectedBrowser;
    this.#tabChip.textContent =
      browser.contentTitle || browser.currentURI?.spec || "";
    this.#input.disabled = !conversation;
    let placeholder = "";
    let hint = `Enter send · Shift+Enter new line · Tab switch agent · Esc ${this.#layout == "split" ? "back to the page" : "close"}`;
    if (conversation?.pendingConfirm) {
      hint = "y allow · n deny · Esc hide";
    } else if (conversation?.running) {
      placeholder = `${agent.name} is working on this tab…`;
      hint = "Ctrl+C stop · Esc hide, it keeps working";
    } else if (agent) {
      placeholder = `Ask ${agent.name} to do something on this tab`;
    }
    this.#input.placeholder = placeholder;
    this.#hint.textContent = this.#notice || hint;
    this.#hint.toggleAttribute("warning", !!this.#notice);
    this.#root.toggleAttribute("running", !!conversation?.running);
    this.#syncComposer();
    this.#syncInstructions();
    this.#updateStatus();
  }

  // A message's row, built again only when what it shows changed. An answer
  // that streams in keeps its row and has its Markdown drawn again.
  #rowFor(message, streaming) {
    const key = [
      message.type,
      message.status,
      message.detail,
      streaming,
      message.text,
      message.revision,
      message.files?.join("\u0001"),
    ].join("\u0000");
    const cached = this.#rows.get(message);
    if (cached?.key == key) {
      return cached.row;
    }
    let row = cached?.row;
    // An answer and a table or page keep their row: a page's browser and a
    // table's filter box live in it.
    if (!row || (message.type != "agent" && message.type != "ui")) {
      row = this.#create("div", "lazyvimium-agent-message");
      row.setAttribute("type", message.type);
    }
    switch (message.type) {
      case "ui":
        this.#uiView.update(row, message);
        break;
      case "agent":
        row.classList.add("lazyvimium-md");
        row.toggleAttribute("streaming", streaming);
        lazy.renderMarkdown(row, message.text, {
          partial: streaming,
          onLink: href =>
            this.#window.openWebLinkIn(href, "tab", { relatedToCurrent: true }),
        });
        break;
      case "step": {
        row.setAttribute("status", message.status);
        row.append(
          this.#create(
            "span",
            "lazyvimium-agent-step-icon",
            STEP_ICONS[message.status] ?? "·"
          ),
          this.#create("span", "lazyvimium-agent-step-title", message.text)
        );
        if (message.detail) {
          row.append(
            this.#create("span", "lazyvimium-agent-step-detail", message.detail)
          );
        }
        break;
      }
      case "tool":
        row.textContent = `used ${message.text}`;
        break;
      case "user":
        row.append(this.#create("span", "", message.text));
        if (message.files?.length) {
          const files = this.#create("span", "lazyvimium-agent-sent-files");
          for (const name of message.files) {
            files.append(
              this.#create("span", "lazyvimium-agent-attachment", name)
            );
          }
          row.append(files);
        }
        break;
      case "confirm": {
        row.setAttribute("status", message.status);
        row.append(
          this.#create("span", "", `Allow the agent to ${message.text}?`)
        );
        if (message.status == "pending") {
          const allow = this.#create(
            "button",
            "lazyvimium-agent-button primary",
            "Allow  y"
          );
          const deny = this.#create(
            "button",
            "lazyvimium-agent-button",
            "Deny  n"
          );
          allow.addEventListener("click", () => message.answer(true));
          deny.addEventListener("click", () => message.answer(false));
          row.append(allow, deny);
        } else {
          row.append(
            this.#create("span", "lazyvimium-agent-step-detail", message.status)
          );
        }
        break;
      }
      default:
        row.textContent = message.text;
    }
    this.#rows.set(message, { key, row });
    return row;
  }

  #renderEmpty(agent) {
    const empty = this.#create("div", "lazyvimium-agent-empty");
    empty.append(
      this.#create(
        "div",
        "lazyvimium-agent-empty-title",
        `Ask ${agent.name} about this tab`
      ),
      this.#create(
        "div",
        "lazyvimium-agent-empty-detail",
        "It reads the page, clicks, types and moves between pages for you, and asks before anything you have to allow."
      )
    );
    return empty;
  }

  #renderNoAgent() {
    const rows = [
      this.#create(
        "div",
        "lazyvimium-agent-message",
        "No coding agent found on this computer. lazyvimium works with the one you already use: install one, then look again."
      ),
    ];
    const list = this.#create("div", "lazyvimium-agent-install");
    lazy.LazyvimiumAgents.agents().then(agents => {
      for (const agent of agents) {
        const row = this.#create("div", "lazyvimium-agent-install-row");
        row.append(
          this.#create("span", "lazyvimium-agent-install-name", agent.name),
          this.#create("code", "", agent.install)
        );
        list.append(row);
      }
    });
    const again = this.#create(
      "button",
      "lazyvimium-agent-button primary",
      "Look again"
    );
    again.addEventListener("click", async () => {
      await lazy.LazyvimiumAgents.agents({ refresh: true });
      this.open(this.#window.gBrowser.selectedBrowser);
    });
    rows.push(list, again);
    return rows;
  }

  #updateStatus() {
    const conversation = this.#conversation;
    const running = !!conversation?.running;
    this.#status.textContent = running
      ? `working · ${formatElapsed(Date.now() - conversation.startedAt)}`
      : "";
    if (running && !this.#timer) {
      this.#timer = this.#window.setInterval(() => {
        this.#updateStatus();
        this.#syncPill();
      }, 1000);
    } else if (!running && this.#timer) {
      this.#window.clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  // Under a closed dock, for the selected tab's conversation: the pill, or
  // the slid-out panel's handle at its side.
  #syncPill() {
    const conversation = lazy.LazyvimiumAgents.conversationFor(
      this.#window.gBrowser.selectedBrowser
    );
    const color = lazy.agentColor(conversation?.agent.id);
    const running = !!conversation?.running;
    const slide = this.#layout == "slide";
    this.#handle.hidden =
      this.#open || !slide || !conversation?.messages.length;
    this.#handle.style.setProperty("--lazyvimium-agent-color", color);
    this.#handle.toggleAttribute("running", running);
    this.#handle.toggleAttribute("unseen", !!conversation?.unseen);

    const show = !this.#open && !slide && (running || conversation?.unseen);
    this.#pill.hidden = !show;
    if (!show) {
      return;
    }
    this.#pill.style.setProperty("--lazyvimium-agent-color", color);
    this.#pill.toggleAttribute("running", running);
    this.#pill.textContent = running
      ? `${conversation.agent.name} is working · ${formatElapsed(Date.now() - conversation.startedAt)}`
      : `${conversation.agent.name} finished · open`;
  }
}
