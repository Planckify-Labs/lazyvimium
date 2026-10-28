// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

const HTML_NS = "http://www.w3.org/1999/xhtml";

// tokyonight, LazyVim's default colorscheme, as lualine draws modes.
const MODES = {
  n: { label: "NORMAL", color: "#7aa2f7" },
  i: { label: "INSERT", color: "#9ece6a" },
  v: { label: "VISUAL", color: "#bb9af7" },
};

/**
 * The mode indicator in a browser window: the mode of the selected tab's
 * page and whatever has been typed towards a mapping.
 */
export class LazyvimiumStatusline {
  #element;
  #mode;
  #keys;

  /**
   * @param {Window} window A browser window.
   */
  constructor(window) {
    const document = window.document;
    this.#element = document.createElementNS(HTML_NS, "div");
    this.#element.id = "lazyvimium-statusline";
    Object.assign(this.#element.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
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
      color: "#1a1b26",
    });
    this.#keys = document.createElementNS(HTML_NS, "span");

    this.#element.append(this.#mode, this.#keys);
    (document.getElementById("browser") ?? document.documentElement).append(
      this.#element
    );
  }

  /**
   * @param {{mode: string, tokens?: string[], count?: number|null, group?: string|null}} state
   */
  update({ mode, tokens = [], count = null, group = null }) {
    const { label, color } = MODES[mode] ?? {
      label: mode.toUpperCase(),
      color: "#e0af68",
    };
    this.#mode.textContent = label;
    this.#mode.style.background = color;
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
  }

  destroy() {
    this.#element.remove();
  }
}
