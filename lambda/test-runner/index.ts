import { Handler } from "aws-lambda";
import { chromium as playwright } from "playwright-core";
import chromium from "@sparticuz/chromium";
import { getNextStep } from "./gemini.js";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as fs from "fs";

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);
const s3Client = new S3Client({ region: "us-east-1" });

const TABLE_NAME = process.env.TABLE_NAME || "TestRuns";
const BUCKET_NAME = process.env.BUCKET_NAME || "";

// --- THE SILENT ASSASSIN (NODE NATIVE CLEANUP) ---
const cleanupEnvironment = () => {
  // 1. Kill Zombies by reading /proc directly (No Shell commands)
  try {
    if (fs.existsSync("/proc")) {
      const pids = fs.readdirSync("/proc");
      pids.forEach((pid) => {
        // Check if it's a number (Process ID)
        if (/^\d+$/.test(pid)) {
          try {
            // Read command line of the process
            const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8");
            // If it's Chromium/Headless Shell and NOT the current Node process
            if (
              (cmdline.includes("chromium") ||
                cmdline.includes("headless_shell")) &&
              parseInt(pid) !== process.pid
            ) {
              console.log(`Killing zombie process: ${pid}`);
              process.kill(parseInt(pid), "SIGKILL");
            }
          } catch (e) {
            // Process might have died between listing and reading, ignore.
          }
        }
      });
    }
  } catch (e) {
    console.log("Process cleanup warning:", e);
  }

  // 2. Scrub /tmp files
  try {
    const tmpFiles = fs.readdirSync("/tmp");
    tmpFiles.forEach((file) => {
      // Delete screenshots, profiles, and heavy folders
      if (
        file.endsWith(".png") ||
        file.startsWith("playwright") ||
        file.startsWith("core.")
      ) {
        try {
          fs.rmSync(`/tmp/${file}`, { recursive: true, force: true });
        } catch (e) {}
      }
    });
  } catch (e) {}

  console.log("Environment Cleaned.");
};

export const handler: Handler = async (event) => {
  // RUN CLEANUP FIRST
  cleanupEnvironment();

  const { url, instructions, testId } = event;
  if (!url || !instructions || !testId) return { statusCode: 400 };

  // Auto-add https://
  let validUrl = url;
  if (!validUrl.startsWith("http://") && !validUrl.startsWith("https://")) {
    validUrl = "https://" + validUrl;
  }

  let browser = null;
  try {
    console.log(`[${testId}] Starting Agentic Loop for ${validUrl}`);

    chromium.setGraphicsMode = false;
    browser = await playwright.launch({
      args: [
        ...chromium.args,
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
      ],
      executablePath: await chromium.executablePath(),
      headless: true,
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();
    await page.goto(validUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    let history: string[] = [];
    let loopCount = 0;
    const MAX_LOOPS = 20; // Sufficient for complex flows
    let testResult = "Running";
    let finalMessage = "";

    while (loopCount < MAX_LOOPS) {
      loopCount++;
      console.log(`--- Loop ${loopCount} ---`);

      // 1. EXTRACT HTML
      const simplifiedHtml = await page.evaluate(() => {
        const elements = document.querySelectorAll(
          "button, a, input, select, textarea, [role='button'], [role='link']"
        );
        return Array.from(elements)
          .map((el) => {
            const element = el as HTMLElement;
            const style = window.getComputedStyle(element);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.opacity === "0"
            )
              return null;

            const val = (el as HTMLInputElement).value;
            const text =
              element.innerText?.replace(/\s+/g, " ").trim().substring(0, 50) ||
              "";
            const placeholder = element.getAttribute("placeholder") || "";
            const label = element.getAttribute("aria-label") || "";
            const name = element.getAttribute("name") || "";
            const id = element.id || "";
            const type = element.getAttribute("type") || "";
            const tag = element.tagName.toLowerCase();

            let desc = `<${tag}`;
            if (id) desc += ` id="${id}"`;
            if (name) desc += ` name="${name}"`;
            if (type) desc += ` type="${type}"`;
            if (text) desc += ` text="${text}"`;
            if (placeholder) desc += ` placeholder="${placeholder}"`;
            if (val) desc += ` value="${val}"`;
            desc += ` />`;
            return desc;
          })
          .filter(Boolean)
          .join("\n");
      });

      // 2. CONSULT AI
      let step = null;
      try {
        step = await getNextStep(instructions, history, simplifiedHtml);
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1000));
        step = await getNextStep(instructions, history, simplifiedHtml);
      }

      if (!step || !step.action) {
        testResult = "FAILED";
        finalMessage = "AI Brain Failure";
        break;
      }

      console.log("AI Decision:", JSON.stringify(step));

      if (step.action === "finish") {
        testResult = step.success ? "COMPLETED" : "FAILED";
        finalMessage = step.desc;
        break;
      }

      if (step.action === "wait") {
        await page.waitForTimeout(2000);
        continue;
      }

      // 3. EXECUTE
      try {
        await executeStep(page, step);
        history.push(`SUCCESS: ${step.action} on '${step.target}'`);
      } catch (e: any) {
        console.error("Step Failed:", e.message);
        history.push(`FAILED: ${step.action} on '${step.target}'`);
      }

      await page.waitForTimeout(2000);
    }

    if (loopCount >= MAX_LOOPS) {
      testResult = "FAILED";
      finalMessage = "Maximum steps exceeded.";
    }

    // 4. REPORT
    const screenshotBuffer = await page.screenshot();
    const s3Key = `${testId}.png`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Key,
        Body: screenshotBuffer,
        ContentType: "image/png",
      })
    );
    const signedUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key }),
      { expiresIn: 86400 }
    );

    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id: testId },
        UpdateExpression:
          "SET #s = :s, #r = :r, screenshot = :scr, updatedAt = :t, history = :h",
        ExpressionAttributeNames: { "#s": "status", "#r": "result" },
        ExpressionAttributeValues: {
          ":s": testResult,
          ":r": finalMessage,
          ":scr": signedUrl,
          ":h": history,
          ":t": new Date().toISOString(),
        },
      })
    );
  } catch (error: any) {
    console.error(`System Crash:`, error);
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { id: testId },
        UpdateExpression: "SET #s = :s, #e = :e, updatedAt = :t",
        ExpressionAttributeNames: { "#s": "status", "#e": "error" },
        ExpressionAttributeValues: {
          ":s": "FAILED",
          ":e": error.message,
          ":t": new Date().toISOString(),
        },
      })
    );
  } finally {
    if (browser) await browser.close();
  }
};

// --- THE DRIVER ---
async function findBestLocator(page: any, target: string) {
  const regex = new RegExp(target, "i");
  if (target.match(/^[a-zA-Z0-9_-]+$/)) {
    const byId = page.locator(`#${target}`);
    const byName = page.locator(`[name="${target}"]`);
    if ((await byId.count()) > 0) return byId.first();
    if ((await byName.count()) > 0) return byName.first();
  }
  const byPlaceholder = page.getByPlaceholder(regex);
  if ((await byPlaceholder.count()) > 0) return byPlaceholder.first();
  const byLabel = page.getByLabel(regex);
  if ((await byLabel.count()) > 0) return byLabel.first();
  const byRoleBtn = page.getByRole("button", { name: regex });
  if ((await byRoleBtn.count()) > 0) return byRoleBtn.first();
  const byRoleLink = page.getByRole("link", { name: regex });
  if ((await byRoleLink.count()) > 0) return byRoleLink.first();
  return page.getByText(regex).first();
}

async function executeStep(page: any, step: any) {
  if (step.action === "click") {
    const locator = await findBestLocator(page, step.target);
    if ((await locator.count()) === 0)
      throw new Error(`Element not found: ${step.target}`);
    try {
      await locator.click({ timeout: 2000 });
    } catch (e) {
      try {
        console.log("Force click...");
        await locator.click({ timeout: 2000, force: true });
      } catch (e2) {
        console.log("JS Click...");
        await locator.evaluate((node: HTMLElement) => node.click());
      }
    }
  } else if (step.action === "fill") {
    const locator = await findBestLocator(page, step.target);
    if ((await locator.count()) === 0)
      throw new Error(`Input not found: ${step.target}`);
    try {
      await locator.fill(step.value, { timeout: 2000 });
    } catch (e) {
      try {
        console.log("Force fill...");
        await locator.fill(step.value, { timeout: 2000, force: true });
      } catch (e2) {
        console.log("JS Fill...");
        await locator.evaluate((node: HTMLInputElement, val: string) => {
          node.value = val;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        }, step.value);
      }
    }
    await locator.evaluate((node: any) => {
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.keyboard.press("Tab");
  } else if (step.action === "press") {
    await page.keyboard.press(step.key);
  }
}
