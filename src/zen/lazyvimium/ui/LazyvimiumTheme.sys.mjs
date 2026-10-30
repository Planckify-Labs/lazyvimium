// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// lazyvimium's colors, in one place. The palette is tokyonight, LazyVim's
// colorscheme: moon on a dark browser, and on a light one day's hues,
// darkened until each reads at 4.5:1 or more on light glass. Roles name what
// a color is for (a mode, a heading, a link) and point at the palette, so
// a role can change color without touching the code that uses it.
//
// Every window gets them as CSS variables on its root, written as
// light-dark() pairs so they follow Zen's light and dark themes:
// --lazyvimium-<palette name> and --lazyvimium-<role>. Code that needs a
// plain color (the statusline, the window's mode color) asks hex().
//
// The lazyvimium.theme pref, a JSON object, overrides any of it and applies
// at once:
//   {
//     "palette": { "pink": "#ff79c6", "blue": { "light": "#1d4ed8", "dark": "#7aa2f7" } },
//     "roles": { "md-strong": "pink", "accent": "#00d0a0" },
//     "glass": { "opacity": 0.6, "blur": 32 },
//     "agents": { "claude": "#e07a5f" }
//   }
// A role takes a palette name, another role, a #rrggbb color, or a
// { light, dark } pair of them.

const PREF_THEME = "lazyvimium.theme";

export const LAZYVIMIUM_PALETTE = {
  // Surfaces and text.
  base: { light: "#f5f6fa", dark: "#1e2030" },
  raised: { light: "#e6e8f0", dark: "#2a2d45" },
  border: { light: "#c4c8da", dark: "#3b4261" },
  text: { light: "#1f2335", dark: "#c8d3f5" },
  muted: { light: "#545c8a", dark: "#8f98c4" },
  // Dark text on the bright mode colors, and the statusline's own colors.
  ink: { light: "#1b1d2b", dark: "#1b1d2b" },
  night: { light: "#1a1b26", dark: "#1a1b26" },
  snow: { light: "#c0caf5", dark: "#c0caf5" },
  // Hues.
  pink: { light: "#b0307f", dark: "#fca7ea" },
  red: { light: "#c8174c", dark: "#ff757f" },
  orange: { light: "#9c4f00", dark: "#ff966c" },
  yellow: { light: "#7a5c14", dark: "#ffc777" },
  green: { light: "#476628", dark: "#c3e88d" },
  teal: { light: "#0b7461", dark: "#4fd6be" },
  cyan: { light: "#00668a", dark: "#86e1fc" },
  blue: { light: "#2160c4", dark: "#82aaff" },
  purple: { light: "#7340cc", dark: "#c099ff" },
};

export const LAZYVIMIUM_ROLES = {
  // NORMAL's pink is lazyvimium's own color.
  accent: "pink",
  // The modes, as lualine draws tokyonight's, with NORMAL in pink instead
  // of blue, the explorer taking the blue, the toolbar the command line's
  // yellow and the library the terminal's teal.
  "mode-n": "pink",
  "mode-i": "green",
  "mode-v": "purple",
  "mode-e": "blue",
  "mode-t": "yellow",
  "mode-l": "teal",
  "statusline-background": "night",
  "statusline-text": "snow",
  // Jump labels, in flash.nvim's colors from the user's LazyVim setup.
  hint: { light: "#a25772", dark: "#a25772" },
  "hint-text": { light: "#eef5ff", dark: "#eef5ff" },
  "which-key-key": "orange",
  "which-key-group": "purple",
  success: "green",
  warning: "yellow",
  error: "red",
  // The thumb of the scrollbars in lazyvimium's own panels.
  scrollbar: "accent",
  // The agent's answers, as render-markdown.nvim draws them in tokyonight:
  // each heading level in its own hue.
  "md-h1": "blue",
  "md-h2": "yellow",
  "md-h3": "green",
  "md-h4": "teal",
  "md-h5": "purple",
  "md-h6": "pink",
  "md-strong": "orange",
  "md-em": "text",
  "md-link": "blue",
  "md-code": "teal",
  "md-code-background": "raised",
  "md-quote": "purple",
  "md-bullet": "pink",
  "md-rule": "border",
  "md-table-head": "blue",
  // The agent panel.
  "agent-surface": "base",
  "agent-text": "text",
  "agent-muted": "muted",
  "agent-border": "border",
  "agent-user": "accent",
  "agent-confirm": "yellow",
};

// The agent panel's glass: how much of the surface color shows over the page
// (0 to 1), and the blur behind it in pixels.
export const LAZYVIMIUM_GLASS = { opacity: 0.78, blur: 40 };

// Each agent's own color, for its chip and the glow on the tab it drives.
export const LAZYVIMIUM_AGENT_COLORS = {
  claude: "#d97757",
  codex: "#10a37f",
  cursor: "#a3a3a3",
  antigravity: "#4285f4",
  opencode: "#f5a742",
};

// Colors are #rrggbb: the window's mode color is mixed from their channels.
const HEX = /^#[0-9a-f]{6}$/i;

function isColor(value) {
  return typeof value == "string" && HEX.test(value);
}

function readOverrides() {
  const json = Services.prefs.getStringPref(PREF_THEME, "");
  if (!json.trim()) {
    return {};
  }
  try {
    const value = JSON.parse(json);
    return value && typeof value == "object" ? value : {};
  } catch (e) {
    console.error(`Lazyvimium: ${PREF_THEME} is not JSON`, e);
    return {};
  }
}

function pair(value) {
  if (isColor(value)) {
    return { light: value, dark: value };
  }
  if (value && isColor(value.light) && isColor(value.dark)) {
    return { light: value.light, dark: value.dark };
  }
  return null;
}

class Theme {
  #documents = new Set();
  #resolved = null;
  #observing = false;

  // The palette, roles, glass and agent colors with the pref's overrides.
  get #theme() {
    if (this.#resolved) {
      return this.#resolved;
    }
    // Dropped when the pref changes.
    this.#observe();
    const overrides = readOverrides();
    const palette = { ...LAZYVIMIUM_PALETTE };
    for (const [name, value] of Object.entries(overrides.palette ?? {})) {
      const color = pair(value);
      if (color) {
        palette[name] = color;
      }
    }
    const roleSpecs = { ...LAZYVIMIUM_ROLES, ...(overrides.roles ?? {}) };
    const roles = {};
    const resolve = (spec, seen = new Set()) => {
      if (typeof spec == "string" && palette[spec]) {
        return palette[spec];
      }
      if (typeof spec == "string" && spec in roleSpecs && !seen.has(spec)) {
        seen.add(spec);
        return resolve(roleSpecs[spec], seen);
      }
      return pair(spec);
    };
    for (const [role, spec] of Object.entries(roleSpecs)) {
      roles[role] = resolve(spec) ?? resolve(LAZYVIMIUM_ROLES[role]);
    }
    const glass = { ...LAZYVIMIUM_GLASS };
    const opacity = Number(overrides.glass?.opacity);
    if (opacity >= 0 && opacity <= 1) {
      glass.opacity = opacity;
    }
    const blur = Number(overrides.glass?.blur);
    if (blur >= 0) {
      glass.blur = blur;
    }
    const agents = { ...LAZYVIMIUM_AGENT_COLORS };
    for (const [id, value] of Object.entries(overrides.agents ?? {})) {
      if (isColor(value)) {
        agents[id] = value;
      }
    }
    this.#resolved = { palette, roles, glass, agents };
    return this.#resolved;
  }

  /**
   * A role's or palette color's plain value, for code that cannot use the
   * CSS variables.
   *
   * @param {string} name A role or a palette name.
   * @param {"light"|"dark"} [scheme]
   * @returns {string|null}
   */
  hex(name, scheme = "dark") {
    const { roles, palette } = this.#theme;
    return (roles[name] ?? palette[name])?.[scheme] ?? null;
  }

  /**
   * @param {string} [id] An agent id.
   * @returns {string} Its color, or the explorer's blue for one without.
   */
  agentColor(id) {
    return this.#theme.agents[id] ?? this.hex("blue");
  }

  /**
   * @returns {object} The CSS variables, by name.
   */
  variables() {
    const { palette, roles, glass } = this.#theme;
    const variables = {};
    for (const [name, { light, dark }] of [
      ...Object.entries(palette),
      ...Object.entries(roles),
    ]) {
      variables[`--lazyvimium-${name}`] =
        light == dark ? light : `light-dark(${light}, ${dark})`;
    }
    variables["--lazyvimium-glass-opacity"] = `${glass.opacity * 100}%`;
    variables["--lazyvimium-glass-blur"] = `${glass.blur}px`;
    return variables;
  }

  /**
   * Give a window's document the variables, and keep them current.
   *
   * @param {Document} document
   */
  apply(document) {
    this.#observe();
    if (!this.#documents.has(document)) {
      this.#documents.add(document);
      document.defaultView?.addEventListener(
        "unload",
        () => this.#documents.delete(document),
        { once: true }
      );
    }
    const style = document.documentElement.style;
    for (const [name, value] of Object.entries(this.variables())) {
      style.setProperty(name, value);
    }
  }

  #listeners = new Set();

  /**
   * @param {() => void} listener Called after the theme changes.
   * @returns {() => void} Removes it.
   */
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #observe() {
    if (this.#observing) {
      return;
    }
    this.#observing = true;
    Services.prefs.addObserver(PREF_THEME, () => {
      this.#resolved = null;
      for (const document of this.#documents) {
        this.apply(document);
      }
      for (const listener of this.#listeners) {
        try {
          listener();
        } catch (e) {
          console.error("Lazyvimium: theme listener failed", e);
        }
      }
    });
  }
}

export const LazyvimiumTheme = new Theme();
