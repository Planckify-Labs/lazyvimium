// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Matching and labeling for jumps, without any DOM: the targets are
// described by their text, so the same code runs for links and for words.

export const JUMP_LABELS = "asdfghjklqwertyuiopzxcvbnm";

/**
 * A pattern with an uppercase letter is matched as typed, any other ignores
 * case.
 *
 * @param {string} pattern
 * @returns {boolean}
 */
export function ignoresCase(pattern) {
  return pattern == pattern.toLowerCase();
}

/**
 * Where a pattern occurs in a text, and the characters that follow it.
 *
 * @param {string} text
 * @param {string} pattern
 * @returns {{index: number, next: string}[]}
 */
export function findMatches(text, pattern) {
  if (!pattern) {
    return [];
  }
  const fold = ignoresCase(pattern);
  const haystack = fold ? text.toLowerCase() : text;
  const matches = [];
  for (
    let index = haystack.indexOf(pattern);
    index != -1;
    index = haystack.indexOf(pattern, index + 1)
  ) {
    matches.push({ index, next: haystack[index + pattern.length] ?? "" });
  }
  return matches;
}

/**
 * Give labels to the targets. A label is never the next character of any
 * match, so a key is either a label or one more character of the pattern,
 * never both. Targets come in priority order; a target that had a label keeps
 * it while it is still free, so labels do not jump around as the pattern
 * grows.
 *
 * @param {number} count How many targets there are.
 * @param {object} [options]
 * @param {Iterable<string>} [options.skip] The characters that may follow a
 *   match.
 * @param {(string|null)[]} [options.previous] Each target's label before.
 * @param {string} [options.alphabet]
 * @returns {(string|null)[]} A label per target, null where they ran out.
 */
export function assignLabels(
  count,
  { skip = [], previous = [], alphabet = JUMP_LABELS } = {}
) {
  const blocked = new Set([...skip].map(char => char.toLowerCase()));
  const free = new Set([...alphabet].filter(char => !blocked.has(char)));
  const labels = Array(count).fill(null);
  for (let i = 0; i < count; i++) {
    const label = previous[i];
    if (label && free.has(label)) {
      labels[i] = label;
      free.delete(label);
    }
  }
  const rest = [...free];
  for (let i = 0; i < count && rest.length; i++) {
    labels[i] ??= rest.shift();
  }
  return labels;
}
