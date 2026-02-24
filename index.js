const { chromium } = require("playwright-core");
const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "50mb" }));

const sessions = new Map();

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", activeSessions: sessions.size });
});

// Create a browser session
app.post("/session/create", async (req, res) => {
  try {
    const { apiKey, projectId } = req.body;
    if (!apiKey || !projectId) {
      return res.status(400).json({ error: "apiKey and projectId required" });
    }

    const wsUrl = `wss://connect.browserbase.com?apiKey=${apiKey}&projectId=${projectId}`;
    console.log("Connecting to Browserbase...");

    const browser = await chromium.connectOverCDP(wsUrl, { timeout: 30000 });
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();

    const id = crypto.randomUUID();
    sessions.set(id, { browser, page, createdAt: Date.now() });
    console.log(`Session created: ${id}`);

    res.json({ sessionId: id });
  } catch (err) {
    console.error("Session create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Execute a browser action
app.post("/session/:id/action", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  const { action, params } = req.body;
  const { page } = session;

  try {
    let observation = "";
    let screenshot = "";

    switch (action) {
      case "navigate": {
        await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        observation = `Navigated to ${params.url}. Title: "${await page.title()}"`;
        break;
      }

      case "click": {
        const selector = params.selector;
        // Try CSS selector first, then text-based
        try {
          await page.click(selector, { timeout: 5000 });
          observation = `Clicked element: ${selector}`;
        } catch {
          // Try by text content
          const el = page.getByText(selector, { exact: false }).first();
          await el.click({ timeout: 5000 });
          observation = `Clicked element with text: "${selector}"`;
        }
        await page.waitForTimeout(1000);
        break;
      }

      case "type_text": {
        const input = params.selector;
        try {
          await page.fill(input, params.text, { timeout: 5000 });
        } catch {
          const el = page.getByLabel(input, { exact: false }).first();
          await el.fill(params.text, { timeout: 5000 });
        }
        observation = `Typed "${params.text}" into ${input}`;
        break;
      }

      case "scroll": {
        const amount = params.amount || 500;
        const delta = params.direction === "up" ? -amount : amount;
        await page.mouse.wheel(0, delta);
        await page.waitForTimeout(500);
        observation = `Scrolled ${params.direction} by ${amount}px`;
        break;
      }

      case "wait": {
        await page.waitForTimeout(params.ms || 1000);
        observation = `Waited ${params.ms || 1000}ms`;
        break;
      }

      case "get_page_content": {
        const content = await page.evaluate(() =>
          document.body.innerText.substring(0, 4000)
        );
        observation = `Page content:\n${content}`;
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    // Take screenshot after every action
    try {
      const buffer = await page.screenshot({ type: "jpeg", quality: 50 });
      screenshot = buffer.toString("base64");
    } catch (err) {
      console.error("Screenshot error:", err.message);
    }

    res.json({ observation, screenshot });
  } catch (err) {
    console.error(`Action "${action}" error:`, err.message);

    // Still try to get a screenshot on error
    let screenshot = "";
    try {
      const buffer = await page.screenshot({ type: "jpeg", quality: 50 });
      screenshot = buffer.toString("base64");
    } catch {}

    res.json({
      observation: `Action failed: ${err.message}`,
      error: err.message,
      screenshot,
    });
  }
});

// Close a session
app.post("/session/:id/close", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (session) {
    try {
      await session.browser.close();
    } catch {}
    sessions.delete(req.params.id);
    console.log(`Session closed: ${req.params.id}`);
  }
  res.json({ ok: true });
});

// Cleanup stale sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > 10 * 60 * 1000) {
      try { session.browser.close(); } catch {}
      sessions.delete(id);
      console.log(`Cleaned up stale session: ${id}`);
    }
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ShipSafe Browser Service running on port ${PORT}`);
});
