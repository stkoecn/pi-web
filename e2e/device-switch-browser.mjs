import { chromium } from "playwright";

async function run() {
  console.log("[Browser QA] Launching browser to test port 9564...");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: true,
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  const networkFailures = [];

  page.on("pageerror", (err) => {
    console.error("[Page Error]", err.message);
    errors.push(err.message);
  });

  page.on("response", (res) => {
    const url = res.url();
    if (res.status() >= 400 && !url.includes("favicon") && !url.includes("/api/web-auth")) {
      console.warn(`[HTTP ${res.status()}]`, url);
      networkFailures.push({ url, status: res.status() });
    }
  });

  console.log("[Browser QA] Navigating to http://localhost:9564/?deviceId=localhost");
  await page.goto("http://localhost:9564/?deviceId=localhost", { waitUntil: "networkidle" });

  const title = await page.title();
  console.log(`[Browser QA] Loaded title: "${title}"`);

  // Verify Device Selector
  const deviceSelector = await page.$("select.device-selector, [aria-label*='Device'], select");
  console.log("[Browser QA] Device selector found:", Boolean(deviceSelector));

  // Check TabBar & Side Tab structure
  const tabCount = await page.$$eval(".tab, [role='tab']", (els) => els.length).catch(() => 0);
  console.log(`[Browser QA] Found ${tabCount} tabs in UI.`);

  // Switch to wsnas
  console.log("[Browser QA] Navigating to remote device wsnas...");
  await page.goto("http://localhost:9564/?deviceId=wsnas", { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // Check URL param sync
  const currentUrl = page.url();
  console.log("[Browser QA] Current URL:", currentUrl);

  await page.screenshot({ path: "/tmp/qa-wsnas-v0.14.2.png", fullPage: true });
  console.log("[Browser QA] Screenshot saved to /tmp/qa-wsnas-v0.14.2.png");

  await browser.close();

  console.log("==========================================");
  console.log(`Errors count: ${errors.length}`);
  console.log(`Network failures: ${networkFailures.length}`);
  console.log("==========================================");

  if (errors.length > 0) {
    process.exit(1);
  }
}

run().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
