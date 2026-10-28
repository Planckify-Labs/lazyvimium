// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Vim key notation. A key sequence like "<leader>bd" or "<C-d>" is parsed
// into tokens, and a KeyboardEvent is normalized into the same token form so
// the two can be compared with plain string equality.
//
// Canonical tokens:
//   - a printable character stands for itself: "j", "G", "|", "!"
//   - everything else is bracketed: "<Space>", "<lt>", "<Esc>", "<CR>",
//     "<C-d>", "<C-S-d>", "<A-j>", "<S-Tab>"
// Modifiers are always written in the order C (Ctrl), A (Alt/Meta in vim),
// D (Cmd/Super), S (Shift). Shift is folded into printable characters, as in
// vim: "<S-h>" is "H".

const MODIFIER_ORDER = ["C", "A", "D", "S"];

const MODIFIER_ALIASES = {
  c: "C",
  a: "A",
  m: "A",
  d: "D",
  s: "S",
};

// Vim names (lowercased) to canonical names.
const NAMED_KEYS = {
  esc: "Esc",
  escape: "Esc",
  cr: "CR",
  enter: "CR",
  return: "CR",
  tab: "Tab",
  bs: "BS",
  backspace: "BS",
  space: "Space",
  del: "Del",
  delete: "Del",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  lt: "lt",
};

// Characters with a vim name that may appear in bracketed form.
const NAMED_CHARS = {
  bar: "|",
  bslash: "\\",
};

// KeyboardEvent.key values to canonical names.
const EVENT_KEYS = {
  Escape: "Esc",
  Enter: "CR",
  Tab: "Tab",
  Backspace: "BS",
  " ": "Space",
  Delete: "Del",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  "<": "lt",
};

// Keys that never form a token on their own.
const IGNORED_EVENT_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "AltGraph",
  "Meta",
  "OS",
  "Hyper",
  "Super",
  "Fn",
  "FnLock",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Unidentified",
  "Process",
]);

function isFunctionKey(name) {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(name);
}

/**
 * Build the canonical token for a key and a set of modifiers.
 *
 * @param {string} key A single printable character, or a canonical name
 *   ("Esc", "F5", "lt", ...).
 * @param {Set<string>} modifiers Canonical modifier letters.
 * @returns {string}
 */
function makeToken(key, modifiers) {
  if (key == " ") {
    key = "Space";
  }
  if (key.length == 1) {
    const chorded =
      modifiers.has("C") || modifiers.has("A") || modifiers.has("D");
    if (!chorded) {
      // Shift on a printable key is part of the character: <S-h> is "H".
      return modifiers.has("S") ? key.toUpperCase() : key;
    }
    // <C-D> and <C-d> are the same key; Shift is spelled out: <C-S-d>.
    key = key.toLowerCase();
  }
  const prefix = MODIFIER_ORDER.filter(m => modifiers.has(m))
    .map(m => m + "-")
    .join("");
  return `<${prefix}${key}>`;
}

/**
 * Parse the inside of a bracketed key ("C-d", "leader", "S-Tab").
 *
 * @param {string} inner
 * @returns {string|null} The canonical token, or null if this is not a key.
 */
function parseBracketed(inner) {
  const parts = inner.split("-");
  // "<C-->" means Ctrl and the "-" key.
  if (inner.endsWith("--")) {
    parts.splice(-2, 2, "-");
  }
  const keyPart = parts.pop();
  const modifiers = new Set();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier) {
      return null;
    }
    modifiers.add(modifier);
  }
  if (keyPart.length == 1) {
    if (!modifiers.size) {
      return null;
    }
    return makeToken(keyPart, modifiers);
  }
  const lower = keyPart.toLowerCase();
  if (NAMED_CHARS[lower]) {
    return makeToken(NAMED_CHARS[lower], modifiers);
  }
  if (NAMED_KEYS[lower]) {
    return makeToken(NAMED_KEYS[lower], modifiers);
  }
  if (isFunctionKey(keyPart.toUpperCase())) {
    return makeToken(keyPart.toUpperCase(), modifiers);
  }
  return null;
}

export const LazyvimiumKeys = {
  DEFAULT_LEADER: "<Space>",

  /**
   * Parse a key sequence in vim notation into canonical tokens.
   *
   * @param {string} lhs e.g. "gg", "<leader>bd", "<C-w>v"
   * @param {object} [options]
   * @param {string} [options.leader] The key sequence <leader> expands to.
   * @returns {string[]}
   */
  parse(lhs, { leader = this.DEFAULT_LEADER } = {}) {
    if (typeof lhs != "string" || !lhs.length) {
      throw new Error("Lazyvimium: a key sequence cannot be empty");
    }
    const tokens = [];
    let i = 0;
    while (i < lhs.length) {
      const char = lhs[i];
      if (char == "<") {
        const close = lhs.indexOf(">", i + 2);
        if (close != -1) {
          const inner = lhs.slice(i + 1, close);
          if (inner.toLowerCase() == "leader") {
            if (leader.toLowerCase().includes("<leader>")) {
              throw new Error("Lazyvimium: the leader cannot contain <leader>");
            }
            tokens.push(...this.parse(leader, { leader }));
            i = close + 1;
            continue;
          }
          const token = parseBracketed(inner);
          if (token) {
            tokens.push(token);
            i = close + 1;
            continue;
          }
        }
        // A "<" that does not start a key name is the "<" key itself.
        tokens.push("<lt>");
        i++;
        continue;
      }
      tokens.push(char == " " ? "<Space>" : char);
      i++;
    }
    return tokens;
  },

  /**
   * Normalize a keydown event into a canonical token.
   *
   * @param {KeyboardEvent} event
   * @returns {string|null} null for events that are not a key on their own
   *   (bare modifiers, dead keys, IME composition).
   */
  fromEvent(event) {
    if (event.isComposing || IGNORED_EVENT_KEYS.has(event.key)) {
      return null;
    }
    const altGraph = event.getModifierState?.("AltGraph") ?? false;
    const modifiers = new Set();
    // AltGr reports Ctrl+Alt on some platforms; the character it produced is
    // what the user typed.
    if (event.ctrlKey && !altGraph) {
      modifiers.add("C");
    }
    if (event.altKey && !altGraph) {
      modifiers.add("A");
    }
    if (event.metaKey) {
      modifiers.add("D");
    }
    if (event.shiftKey) {
      modifiers.add("S");
    }

    let key = event.key;
    const chorded =
      modifiers.has("C") || modifiers.has("A") || modifiers.has("D");
    if (key.length == 1 && key != " " && !chorded) {
      // Shift is already in the character ("<", "!"), even when the
      // character has a bracketed name.
      modifiers.delete("S");
    }
    if (EVENT_KEYS[key]) {
      key = EVENT_KEYS[key];
    } else if (key.length > 1 && !isFunctionKey(key)) {
      // Media keys, "Clear", "ContextMenu" and the like.
      return null;
    }

    if (chorded && key.length == 1) {
      // Alt and Ctrl change event.key on some layouts (Option+j is "∆" on
      // macOS). Use the physical key so <A-j> means the j key.
      const code = event.code ?? "";
      if (/^Key[A-Z]$/.test(code)) {
        key = code.slice(3).toLowerCase();
      } else if (/^Digit[0-9]$/.test(code)) {
        key = code.slice(5);
      }
    }
    return makeToken(key, modifiers);
  },

  /**
   * Join tokens back into a display string.
   *
   * @param {string[]} tokens
   * @returns {string}
   */
  format(tokens) {
    return tokens.join("");
  },

  /**
   * A stable key for a token sequence, usable as a Map key.
   *
   * @param {string[]} tokens
   * @returns {string}
   */
  sequenceKey(tokens) {
    return tokens.join("\u0000");
  },

  /**
   * Whether a token is a count digit. "0" only continues a count.
   *
   * @param {string} token
   * @param {boolean} counting Whether a count is already being typed.
   * @returns {boolean}
   */
  isCountDigit(token, counting) {
    return counting ? /^[0-9]$/.test(token) : /^[1-9]$/.test(token);
  },
};
