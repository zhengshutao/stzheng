#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const PROFILE_DIR = path.join(ROOT, ".local/wealthsimple-browser");
const DOWNLOAD_DIR = path.join(ROOT, "data/wealthsimple/downloads");
const ACTIVITY_URL = "https://my.wealthsimple.com/app/activity";

function usage() {
  console.log(`
Usage:
  node scripts/wealthsimple/download-activities.mjs [--auto] [--keep-open]

What it does:
  Opens Wealthsimple with a persistent local browser profile.
  You log in and complete 2FA yourself.
  The script watches for CSV downloads and saves them into data/wealthsimple/downloads.
  After each CSV download, it runs the local importer in dry-run mode.

Options:
  --auto        Try to click a visible "Download activities" / "Export" button.
  --keep-open   Keep watching after the first CSV download.
  --help        Show this help.
`);
}

function parseArgs(argv) {
  const args = { auto: false, keepOpen: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--auto") args.auto = true;
    else if (arg === "--keep-open") args.keepOpen = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    throw new Error("Playwright is not installed. Run: npm install");
  }
}

function runImporter(file) {
  const importerArgs = ["scripts/wealthsimple/import-csv.mjs", "--file", file];
  if (process.env.WS_IMPORT_APPLY === "1") importerArgs.push("--apply");
  const result = spawnSync(process.execPath, importerArgs, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    console.warn(`Importer exited with status ${result.status}. The CSV was still saved.`);
  }
}

async function visibleControls(page) {
  return page
    .locator("button, [role='button'], a")
    .evaluateAll((els) =>
      els
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const text = el.textContent?.trim().replace(/\s+/g, " ") ?? "";
          const aria = el.getAttribute("aria-label") ?? "";
          const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            style.opacity !== "0";
          return visible ? { text, aria, disabled, tag: el.tagName.toLowerCase() } : null;
        })
        .filter(Boolean)
        .filter((item) => (item.text || item.aria) && `${item.text} ${item.aria}`.length <= 120)
        .slice(0, 20)
    )
    .catch(() => []);
}

async function selectVisibleAccountOptions(page) {
  const selected = await page
    .evaluate(() => {
      const selectors = "input[type='checkbox'], [role='checkbox']";
      const controls = [...document.querySelectorAll(selectors)];
      let count = 0;
      for (const el of controls) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          style.opacity !== "0";
        if (!visible) continue;

        const input = el instanceof HTMLInputElement ? el : null;
        const checked = input ? input.checked : el.getAttribute("aria-checked") === "true";
        const disabled = input ? input.disabled : el.getAttribute("aria-disabled") === "true";
        if (checked || disabled) continue;

        if (el instanceof HTMLElement) {
          el.click();
          count++;
        }
      }
      return count;
    })
    .catch(() => 0);
  if (selected > 0) {
    console.log(`Selected ${selected} visible account option(s).`);
    return true;
  }
  return false;
}

async function maybeClickDownload(page, state) {
  const isModalOpen =
    (await page.getByText(/generate a csv report/i).first().isVisible().catch(() => false)) ||
    (await page.getByText(/select period/i).first().isVisible().catch(() => false)) ||
    (await page.getByText(/select account/i).first().isVisible().catch(() => false)) ||
    (await page.getByText(/select accounts/i).first().isVisible().catch(() => false));
  const inExportFlow = isModalOpen || state.startedFlow;
  if (!inExportFlow) {
    const entryCandidates = [
      page.getByRole("button", { name: /download activities/i }),
      page.getByRole("link", { name: /download activities/i }),
      page.locator('button:has-text("Download activities")'),
      page.locator('[role="button"]:has-text("Download activities")'),
      page.getByRole("button", { name: /export/i }),
      page.getByRole("link", { name: /export/i }),
    ];

    for (const locator of entryCandidates) {
      try {
        const first = locator.first();
        await first.waitFor({ state: "visible", timeout: 900 });
        await first.click().catch(() => first.click({ force: true }));
        state.startedFlow = true;
        console.log("Clicked Download activities entry point.");
        return true;
      } catch {
        // Try the next selector; Wealthsimple changes UI text occasionally.
      }
    }
    console.log("Could not find a visible download button yet. Please click Download activities manually.");
    return false;
  }

  const now = Date.now();
  if (state.finalClickedAt && now - state.finalClickedAt < 25000) {
    if (now - state.lastWaitLogAt > 5000) {
      state.lastWaitLogAt = now;
      console.log("Download CSV was clicked; waiting for Wealthsimple to generate the file.");
    }
    return false;
  }

  const stepCandidates = [
    { label: "Next", final: false, locator: page.getByText(/^next$/i) },
    { label: "Next", final: false, locator: page.getByRole("button", { name: /^next$/i }) },
    { label: "Next", final: false, locator: page.locator('button:has-text("Next")') },
    { label: "Next", final: false, locator: page.locator('[role="button"]:has-text("Next")') },
    { label: "Download CSV", final: true, locator: page.getByRole("button", { name: /download csv/i }) },
    { label: "Download CSV", final: true, locator: page.locator('button:has-text("Download CSV")') },
    { label: "Download CSV", final: true, locator: page.locator('[role="button"]:has-text("Download CSV")') },
    { label: "Generate", final: true, locator: page.getByRole("button", { name: /^generate$/i }) },
  ];

  for (const candidate of stepCandidates) {
    try {
      const first = candidate.locator.first();
      await first.waitFor({ state: "visible", timeout: 900 });
      const text = (await first.textContent().catch(() => ""))?.trim() || "step button";
      const disabled = await first
        .evaluate((el) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true")
        .catch(() => false);
      if (disabled) {
        const selected = await selectVisibleAccountOptions(page);
        if (selected) return true;
        const controls = await visibleControls(page);
        console.log(`${candidate.label} is visible but disabled; controls: ${JSON.stringify(controls)}`);
        return false;
      }
      await first.click().catch(() => first.click({ force: true }));
      console.log(`Clicked ${text}.`);
      state.startedFlow = true;
      if (candidate.final) state.finalClickedAt = Date.now();
      return true;
    } catch {
      // Try the next step control.
    }
  }

  const clickedByDomText = await page
    .evaluate(() => {
      const controls = [...document.querySelectorAll("button, [role='button'], a")];
      const wanted = controls.find((el) => /^(next|download csv|generate)$/i.test(el.textContent?.trim() ?? ""));
      if (!(wanted instanceof HTMLElement)) return null;
      if (wanted.hasAttribute("disabled") || wanted.getAttribute("aria-disabled") === "true") return "DISABLED";
      const text = wanted.textContent?.trim() ?? "control";
      wanted.click();
      return text;
    })
    .catch(() => null);
  if (clickedByDomText === "DISABLED") {
    console.log("A matching export control is visible but disabled; waiting.");
    return false;
  }
  if (clickedByDomText) {
    console.log(`Clicked ${clickedByDomText} via DOM text fallback.`);
    state.startedFlow = true;
    if (/download|generate|confirm|done/i.test(clickedByDomText)) state.finalClickedAt = Date.now();
    return true;
  }

  const controls = await visibleControls(page);
  console.log(`Download modal is open; visible controls: ${JSON.stringify(controls)}`);
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }

  const { chromium } = await loadPlaywright();
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  console.log(`Browser profile: ${PROFILE_DIR}`);
  console.log(`Download folder: ${DOWNLOAD_DIR}`);
  console.log("The script never asks for or stores your Wealthsimple password.");

  const launchOptions = {
    headless: false,
    acceptDownloads: true,
    downloadsPath: DOWNLOAD_DIR,
    viewport: { width: 1440, height: 950 },
  };

  if (process.env.WS_BROWSER_CHANNEL) launchOptions.channel = process.env.WS_BROWSER_CHANNEL;

  const context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);
  const page = context.pages()[0] || (await context.newPage());
  let downloads = 0;
  const clickState = { finalClickedAt: 0, lastWaitLogAt: 0, startedFlow: false };

  page.on("download", async (download) => {
    downloads++;
    const suggested = download.suggestedFilename();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(DOWNLOAD_DIR, `${stamp}-${suggested}`);
    await download.saveAs(file);
    console.log(`Saved download: ${file}`);
    if (file.toLowerCase().endsWith(".csv")) runImporter(file);
    if (!args.keepOpen) {
      console.log("Done. Closing browser in 3 seconds. Use --keep-open to keep watching.");
      setTimeout(() => context.close().catch(() => {}), 3000);
    }
  });

  await page.goto(ACTIVITY_URL, { waitUntil: "domcontentloaded" });
  console.log("\nIn the browser:");
  console.log("1. Log in to Wealthsimple and complete 2FA if asked.");
  console.log("2. Go to Activities if Wealthsimple redirects elsewhere.");
  console.log("3. Click Download activities, choose period/accounts, then Download CSV.");

  while (context.pages().length && (args.keepOpen || downloads === 0)) {
    if (args.auto && downloads === 0) await maybeClickDownload(page, clickState);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (existsSync(PROFILE_DIR)) {
    console.log("Your browser session was kept in the local profile for next time.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
