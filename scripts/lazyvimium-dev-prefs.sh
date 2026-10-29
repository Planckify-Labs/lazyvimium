#!/bin/sh
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

# Prefs for `npm run dev`. mach run only takes --setpref without --profile,
# so they go in the dev profile's user.js, which the browser reads at every
# start. Existing lines are kept; a pref already there is not added again.
#
#   browser.dom.window.dump.enabled  lets dump() reach the terminal
#   lazyvimium.agent.log.stdout      one line per agent log entry there

set -e
profile="$1"
mkdir -p "$profile"
touch "$profile/user.js"
for pref in browser.dom.window.dump.enabled lazyvimium.agent.log.stdout; do
  grep -q "\"$pref\"" "$profile/user.js" ||
    echo "user_pref(\"$pref\", true);" >> "$profile/user.js"
done
