// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const HTML_NS = "http://www.w3.org/1999/xhtml";

// tokyonight moon as lualine draws modes, with NORMAL in pink instead of blue,
// the explorer taking the blue and the toolbar the command line's yellow.
const MODES = {
  n: { label: "NORMAL", color: "#fca7ea" },
  i: { label: "INSERT", color: "#c3e88d" },
  v: { label: "VISUAL", color: "#c099ff" },
  e: { label: "EXPLORER", color: "#82aaff" },
  t: { label: "TOOLBAR", color: "#ffc777" },
};

function rgb(hex) {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * The mode indicator in a browser window: the mode of the selected tab's
 * page and whatever has been typed towards a mapping.
 */
export class LazyvimiumStatusline {
  #element;
  #mode;
  #keys;
  #root;
  #window;
  #color;

  /**
   * @param {Window} window A browser window.
   */
  constructor(window) {
    const document = window.document;
    this.#window = window;
    this.#root = document.documentElement;
    this.#element = document.createElementNS(HTML_NS, "div");
    this.#element.id = "lazyvimium-statusline";
    // lazyvimium.css picks the corner, away from the sidebar.
    Object.assign(this.#element.style, {
      position: "fixed",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      padding: "0 8px 0 0",
      borderRadius: "6px",
      background: "#1a1b26",
      color: "#c0caf5",
      font: "600 11px/20px ui-monospace, monospace",
      pointerEvents: "none",
      boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)",
    });

    this.#mode = document.createElementNS(HTML_NS, "span");
    Object.assign(this.#mode.style, {
      padding: "0 8px",
      borderRadius: "6px 0 0 6px",
      color: "#1b1d2b",
    });
    this.#keys = document.createElementNS(HTML_NS, "span");

    this.#element.append(this.#mode, this.#keys);
    (document.getElementById("browser") ?? document.documentElement).append(
      this.#element
    );
  }

  /**
   * @param {{mode: string, tokens?: string[], count?: number|null, group?: string|null, visual?: boolean}} state
   *   `visual` shows a selection made in another mode, like the explorer's.
   */
  update({ mode, tokens = [], count = null, group = null, visual = false }) {
    const { label, color } = MODES[visual ? "v" : mode] ?? {
      label: mode.toUpperCase(),
      color: "#ffc777",
    };
    this.#mode.textContent = label;
    this.#mode.style.background = color;
    if (color != this.#color) {
      this.#paintWindow(color);
    }
    const typed = `${count ?? ""}${tokens.join("")}`;
    this.#keys.textContent = group ? `${typed} +${group}` : typed;
    this.#element.style.paddingRight = typed ? "8px" : "0";
  }

  /**
   * @param {boolean} visible
   */
  setVisible(visible) {
    // The inline display: flex would win over the hidden attribute.
    this.#element.style.display = visible ? "flex" : "none";
    this.#root.toggleAttribute("lazyvimium-mode", visible);
  }

  destroy() {
    this.#element.remove();
    this.#root.removeAttribute("lazyvimium-mode");
    this.#root.style.removeProperty("--lazyvimium-mode-background");
    this.#root.style.removeProperty("--lazyvimium-mode-background-toolbar");
  }

  /**
   * Color the window and its sidebar the way a Zen space theme with the mode
   * color as its only dot would, so the opacity and blending of the space
   * still apply and the sidebar keeps matching the frame.
   *
   * @param {string} color
   */
  #paintWindow(color) {
    const picker = this.#window.gZenThemePicker;
    const dot = [{ c: rgb(color) }];
    const algo = picker?.useAlgo;
    this.#root.style.setProperty(
      "--lazyvimium-mode-background",
      picker?.getGradient(dot) ?? color
    );
    this.#root.style.setProperty(
      "--lazyvimium-mode-background-toolbar",
      picker?.getGradient(dot, true) ?? color
    );
    if (picker) {
      picker.useAlgo = algo;
      // Before the theme picker exists the raw color is only a placeholder.
      this.#color = color;
    }
  }
}
