/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Not a pass/fail test of speed: it reads a large page with the accessibility
// tree off and on and reports what each costs, so the pref's default rests on
// numbers. Run it alone and read the BENCH lines.

const { Lazyvimium } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/Lazyvimium.sys.mjs"
);
const { LazyvimiumAgentToolbox } = ChromeUtils.importESModule(
  "resource:///modules/lazyvimium/agent/LazyvimiumAgentTools.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const RUNS = 9;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function processMemory(browser) {
  const pid = browser.browsingContext.currentWindowGlobal.osPid;
  const info = await ChromeUtils.requestProcInfo();
  const child = info.children.find(c => c.pid == pid);
  return child ? Math.round(child.memory / 1024 / 1024) : null;
}

async function timed(fn) {
  const start = performance.now();
  const value = await fn();
  return { ms: performance.now() - start, value };
}

function report(name, fields) {
  info(`BENCH ${name} ${JSON.stringify(fields)}`);
}

add_task(async function bench_a11y_off_and_on() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    ROOT + "file_agent_heavy.html"
  );
  const browser = tab.linkedBrowser;
  const box = new LazyvimiumAgentToolbox({
    lazyvimium: Lazyvimium,
    browser: () => browser,
    retarget() {},
    onStep() {},
    confirm: async () => false,
  });
  const nodes = await SpecialPowers.spawn(
    browser,
    [],
    () => content.document.querySelectorAll("*").length
  );
  report("page", { nodes });

  async function measure(label) {
    const first = await timed(() => box.callTool("page_observe", {}));
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      runs.push((await timed(() => box.callTool("page_observe", {}))).ms);
    }
    const outline = await box.callTool("page_observe", { outline: true });
    const filters = outline.text.match(/\[(e\d+)\] form "Filters"/)[1];
    const scoped = await box.callTool("page_observe", { scope: filters });
    const reload = [];
    for (let i = 0; i < 3; i++) {
      const loaded = BrowserTestUtils.browserLoaded(browser);
      const start = performance.now();
      browser.reload();
      await loaded;
      reload.push(performance.now() - start);
    }
    const engineOn = await SpecialPowers.spawn(
      browser,
      ["resource:///modules/lazyvimium/plugins/LazyvimiumAgentContent.sys.mjs"],
      url => ChromeUtils.importESModule(url).a11yActive()
    );
    report(label, {
      engineOn,
      firstObserveMs: Math.round(first.ms),
      observeMedianMs: Math.round(median(runs)),
      observeChars: first.value.text.length,
      observeTokensApprox: Math.round(first.value.text.length / 4),
      outlineChars: outline.text.length,
      scopedChars: scoped.text.length,
      reloadMedianMs: Math.round(median(reload)),
      residentMB: await processMemory(browser),
    });
    return first.value.text;
  }

  // What an action costs, observation after it included: a button that
  // starts no navigation, as most clicks in a form are.
  const page = await box.callTool("page_observe", {});
  const add = page.text.match(/\[(e\d+)\] button "Add to cart"/)[1];
  const clicks = [];
  for (let i = 0; i < RUNS; i++) {
    clicks.push(
      (
        await timed(() =>
          box.callTool("page_act", { action: "click", element: add })
        )
      ).ms
    );
  }
  report("click", { medianMs: Math.round(median(clicks)) });

  report("memory before", { residentMB: await processMemory(browser) });
  await SpecialPowers.pushPrefEnv({ set: [["lazyvimium.agent.a11y", false]] });
  const off = await measure("a11y off");
  // The same again: what changes with nothing changed is drift, not cost.
  await measure("a11y off again");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.pushPrefEnv({ set: [["lazyvimium.agent.a11y", true]] });
  const on = await measure("a11y on");
  await SpecialPowers.popPrefEnv();

  // Same controls either way, names aside.
  const ids = text => text.split("\n").filter(l => l.startsWith("[")).length;
  report("controls listed", { off: ids(off), on: ids(on) });
  ok(ids(on) > 0 && ids(off) > 0, "both read the page");
  BrowserTestUtils.removeTab(tab);
});
