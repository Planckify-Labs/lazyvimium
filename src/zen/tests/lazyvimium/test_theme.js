/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LazyvimiumTheme, LAZYVIMIUM_PALETTE } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/ui/LazyvimiumTheme.sys.mjs"
);

const PREF = "lazyvimium.theme";

add_task(function test_roles_point_at_the_palette() {
  Services.prefs.clearUserPref(PREF);
  Assert.equal(LazyvimiumTheme.hex("mode-n"), LAZYVIMIUM_PALETTE.pink.dark);
  Assert.equal(
    LazyvimiumTheme.hex("accent", "light"),
    LAZYVIMIUM_PALETTE.pink.light
  );
  Assert.equal(
    LazyvimiumTheme.hex("agent-user"),
    LAZYVIMIUM_PALETTE.pink.dark,
    "a role can point at another role"
  );
  const variables = LazyvimiumTheme.variables();
  Assert.equal(
    variables["--lazyvimium-md-link"],
    `light-dark(${LAZYVIMIUM_PALETTE.blue.light}, ${LAZYVIMIUM_PALETTE.blue.dark})`,
    "each variable follows Zen's light and dark themes"
  );
  Assert.equal(variables["--lazyvimium-ink"], "#1b1d2b");
  Assert.equal(variables["--lazyvimium-glass-opacity"], "78%");
});

add_task(function test_the_pref_overrides_it() {
  Services.prefs.setStringPref(
    PREF,
    JSON.stringify({
      palette: { pink: "#ff79c6" },
      roles: {
        "md-strong": "teal",
        "md-link": { light: "#111111", dark: "#eeeeee" },
        "md-h1": "not a color",
      },
      glass: { opacity: 0.5, blur: 12 },
      agents: { claude: "#123456" },
    })
  );
  registerCleanupFunction(() => Services.prefs.clearUserPref(PREF));
  Assert.equal(LazyvimiumTheme.hex("accent"), "#ff79c6", "through the role");
  Assert.equal(LazyvimiumTheme.hex("md-strong"), LAZYVIMIUM_PALETTE.teal.dark);
  Assert.equal(LazyvimiumTheme.hex("md-link", "light"), "#111111");
  Assert.equal(
    LazyvimiumTheme.hex("md-h1"),
    LAZYVIMIUM_PALETTE.blue.dark,
    "what is not a color keeps the default"
  );
  Assert.equal(LazyvimiumTheme.agentColor("claude"), "#123456");
  const variables = LazyvimiumTheme.variables();
  Assert.equal(variables["--lazyvimium-glass-opacity"], "50%");
  Assert.equal(variables["--lazyvimium-glass-blur"], "12px");

  Services.prefs.setStringPref(PREF, "{not json");
  Assert.equal(
    LazyvimiumTheme.hex("accent"),
    LAZYVIMIUM_PALETTE.pink.dark,
    "a broken pref falls back to the defaults"
  );
});
