import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { strToU8, zipSync } from "fflate";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

const directory = await mkdtemp(join(tmpdir(), "wish-user-terminal-browser-"));
const sessionId = randomUUID();
const previousEnvironment = Object.fromEntries(["HOME", "SHELL", "CONDA_DEFAULT_ENV"].map(key => [key, process.env[key]]));
let booted, browser;
try {
  await mkdir(join(directory, "nested"));
  const condaInit = process.env.CONDA_EXE ? join(dirname(dirname(process.env.CONDA_EXE)), "etc", "profile.d", "conda.sh") : undefined;
  await writeFile(join(directory, ".bashrc"), [
    "export WISH_BROWSER_RC_LOADED=yes",
    "alias wish-browser-alias='printf \"__WISH_BROWSER_ALIAS__ok\\n\"'",
    ...(condaInit && process.env.CONDA_PREFIX ? [
      `[[ ! -r ${bashQuote(condaInit)} ]] || builtin source ${bashQuote(condaInit)}`,
      `conda activate ${bashQuote(process.env.CONDA_PREFIX)} >/dev/null 2>&1 || true`,
    ] : []),
    "__wish_browser_prompt() {",
    "  PS1=\"\\[\\e[1;36m\\](${CONDA_DEFAULT_ENV:-browser-env})\\[\\e[0m\\] \\[\\e[1;32m\\]host\\[\\e[0m\\]\\[\\e[90m\\]@\\[\\e[0m\\]\\[\\e[1;34m\\]wish\\[\\e[0m\\]:\\[\\e[35m\\]\\w\\[\\e[0m\\]\\n\\[\\e[1;33m\\]❯\\[\\e[0m\\] \"",
    "}",
    "PROMPT_COMMAND=__wish_browser_prompt",
    "",
  ].join("\n"), "utf8");
  process.env.HOME = directory;
  process.env.SHELL = "/bin/bash";
  process.env.CONDA_DEFAULT_ENV ??= "browser-env";
  await writeFile(join(directory, "README.md"), "---\ntitle: Browser preview\n---\n# Preview ready\n\n**Markdown works.**\n\n![pixel](pixel.png)\n", "utf8");
  await writeFile(join(directory, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeFile(join(directory, "sample.docx"), zipSync({
    "word/document.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Office preview works</w:t></w:r></w:p></w:body></w:document>'),
  }));
  await writeFile(join(directory, "nested", "aligned.txt"), "aligned\n", "utf8");
  booted = await bootstrap({
    surface: "webui", cwd: directory, homeDirectory: directory,
    environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, CORDIS_HMR: "0" },
    management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
  });
  const context = booted.surfaceContext;
  await context.get("sessions").manager.create({ sessionId, agentId: context.get("agents").agentId, scope: directory });
  await context.get("sessionPermissions").port.initialize(sessionId, "approval-required");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [], snapshots = [];
  page.on("pageerror", error => errors.push(error.message));
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  network.on("Network.eventSourceMessageReceived", event => {
    if (event.eventName !== "terminal.snapshot") return;
    try { snapshots.push(JSON.parse(event.data)); } catch { /* The assertion below reports missing snapshots. */ }
  });

  await page.goto(booted.context.get("webManagementHost").url);
  await page.locator("#wish-composer").waitFor();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "会话侧栏", exact: true });
  await sidebar.getByRole("button", { name: "选择终端 Shell", exact: true }).click();
  await sidebar.getByRole("menuitemradio", { name: /bash.*\/bin\/bash/u }).click();
  const screen = sidebar.locator(".user-terminal-screen");
  await screen.waitFor();
  await waitFor(() => snapshots.length >= 1, "initial terminal snapshot");
  await waitFor(async () => (await screen.locator(".xterm-rows").innerText()).includes("host@wish"), "host Bash prompt");
  const initialTerminalText = await screen.locator(".xterm-rows").innerText();
  assert.match(initialTerminalText, /\([^\r\n()]+\).*host@wish/u, "browser prompt must display the inherited environment label");
  const promptStyles = await terminalStyles(screen);
  assert.equal(new Set(promptStyles.spans.map(item => item.color)).size >= 4, true, `the browser must render the Host prompt with distinct ANSI colors: ${JSON.stringify(promptStyles)}`);
  await waitFor(async () => {
    const terminal = (await context.get("userTerminal").list(sessionId, directory))[0];
    return terminal !== undefined && (terminal.columns !== 120 || terminal.rows !== 40);
  }, "browser-driven terminal resize");
  await screen.click({ position: { x: 40, y: 40 } });
  const cursorAnimation = await screen.evaluate(node => {
    const cursor = node.querySelector(".xterm-rows.xterm-focus .xterm-cursor.xterm-cursor-blink");
    if (!(cursor instanceof HTMLElement)) return null;
    const style = getComputedStyle(cursor);
    return { name: style.animationName, duration: style.animationDuration, state: style.animationPlayState };
  });
  assert.deepEqual(cursorAnimation, { name: "wish-terminal-cursor-blink", duration: "1s", state: "running" }, "focused terminal cursor must run the visible blink animation");
  await page.keyboard.type("printf '__WISH_BROWSER_RC__%s\\n' \"$WISH_BROWSER_RC_LOADED\"; wish-browser-alias; printf 'BROWSER_DIRECT_PTY_OK\\n'; printf browser-input-ok > browser-terminal.txt");
  await page.keyboard.press("Enter");
  await waitForFile(join(directory, "browser-terminal.txt"), "browser-input-ok");
  await waitFor(async () => (await screen.locator(".xterm-rows").innerText()).includes("__WISH_BROWSER_ALIAS__ok"), "host Bash alias output");
  assert.match(await screen.locator(".xterm-rows").innerText(), /__WISH_BROWSER_RC__yes/u, "the browser terminal must load the Host Bash rc");
  await page.keyboard.type("printf '\\033]4;1;#00aa00\\007\\033[31mOSC_COLOR\\033[0m\\n'");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await textColor(screen, "OSC_COLOR")) !== null && (await paletteColor(screen, 1)) === "#00aa00", "OSC palette output");
  const oscColorBefore = await paletteColor(screen, 1);
  await page.evaluate(() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; });
  await waitFor(async () => (await paletteColor(screen, 1)) === oscColorBefore, "OSC palette after Wish theme change");
  assert.equal(oscColorBefore, "#00aa00", "Shell OSC palette changes must reach xterm and survive Wish theme changes");
  if (process.env.CONDA_EXE && process.env.CONDA_PREFIX) {
    await page.keyboard.type("wish_conda_prefix=$CONDA_PREFIX; conda deactivate; printf '__BROWSER_CONDA_OFF__%s\\n' \"${CONDA_DEFAULT_ENV:-none}\"; conda activate \"$wish_conda_prefix\"; printf '__BROWSER_CONDA_ON__%s\\n' \"$CONDA_DEFAULT_ENV\"");
    await page.keyboard.press("Enter");
    await waitFor(async () => {
      const text = await screen.locator(".xterm-rows").innerText();
      return text.includes("__BROWSER_CONDA_OFF__none") && text.includes(`__BROWSER_CONDA_ON__${previousEnvironment.CONDA_DEFAULT_ENV ?? "base"}`);
    }, "browser Conda deactivate and reactivate");
  }
  await page.keyboard.type("sleep 30"); await page.keyboard.press("Enter");
  await new Promise(resolve => setTimeout(resolve, 100));
  await page.keyboard.press("Control+C");
  await page.keyboard.type("printf browser-interrupt-ok > browser-interrupt.txt"); await page.keyboard.press("Enter");
  await waitForFile(join(directory, "browser-interrupt.txt"), "browser-interrupt-ok");
  assert.equal((await context.get("tmux").list({ workspaceRoot: directory })).length, 0, "User Terminal must not create a tmux session");

  await sidebar.getByRole("button", { name: "新标签页", exact: true }).click();
  await sidebar.getByRole("button", { name: "打开 文件", exact: true }).click();
  await sidebar.getByRole("button", { name: "nested", exact: true }).click();
  await sidebar.getByRole("button", { name: "aligned.txt", exact: true }).waitFor();
  await sidebar.getByRole("button", { name: "README.md", exact: true }).click();
  await sidebar.getByRole("heading", { name: "Preview ready", exact: true }).waitFor();
  assert.match(await sidebar.locator(".document-markdown").innerText(), /Markdown works\./u);
  await sidebar.getByRole("img", { name: "pixel", exact: true }).waitFor();
  await sidebar.getByRole("tab", { name: "文件", exact: true }).click();
  await sidebar.getByRole("button", { name: "pixel.png", exact: true }).click();
  await sidebar.getByRole("img", { name: "pixel.png", exact: true }).waitFor();
  await sidebar.getByRole("tab", { name: "文件", exact: true }).click();
  await sidebar.getByRole("button", { name: "sample.docx", exact: true }).click();
  await sidebar.getByText("Office preview works", { exact: true }).waitFor();
  await sidebar.getByRole("tab", { name: "bash", exact: true }).click();
  await waitFor(() => snapshots.length >= 2 && snapshots.at(-1)?.screen?.includes("BROWSER_DIRECT_PTY_OK"), "reconnected browser screen snapshot");
  const reconnectedScreen = sidebar.locator(".user-terminal-screen");
  await reconnectedScreen.click({ position: { x: 40, y: 40 } });
  await page.keyboard.type("pwd > browser-pwd.txt"); await page.keyboard.press("Enter");
  await waitForFile(join(directory, "browser-pwd.txt"), directory);

  await sidebar.getByRole("button", { name: "收起会话侧栏", exact: true }).click();
  await page.getByRole("button", { name: "打开会话侧栏", exact: true }).click();
  await sidebar.getByRole("tab", { name: "bash", exact: true }).click();
  await sidebar.locator(".user-terminal-screen").waitFor();

  const snapshotsBeforeReload = snapshots.length;
  await page.reload();
  await page.locator("#wish-composer").waitFor();
  const restoredSidebar = page.getByRole("complementary", { name: "会话侧栏", exact: true });
  await restoredSidebar.getByRole("tab", { name: "bash", exact: true }).click();
  const restoredScreen = restoredSidebar.locator(".user-terminal-screen");
  await restoredScreen.waitFor();
  await waitFor(() => snapshots.length > snapshotsBeforeReload, "terminal snapshot after browser reload");
  await restoredScreen.click({ position: { x: 40, y: 40 } });
  await page.keyboard.type("printf browser-reload-ok > browser-reload.txt"); await page.keyboard.press("Enter");
  await waitForFile(join(directory, "browser-reload.txt"), "browser-reload-ok");

  await restoredSidebar.getByRole("button", { name: "关闭 bash", exact: true }).click();
  await waitFor(async () => (await context.get("userTerminal").list(sessionId, directory)).length === 0, "terminal close");
  assert.deepEqual(errors, []);
  console.log("real browser User Terminal interaction and recovery smoke passed");
} finally {
  if (booted) {
    for (const terminal of await booted.surfaceContext.get("userTerminal")?.list(sessionId, directory).catch(() => []) ?? []) {
      await booted.surfaceContext.get("userTerminal").close(sessionId, directory, terminal.id).catch(() => undefined);
    }
  }
  await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true });
  restoreEnvironment(previousEnvironment);
}

async function waitForFile(path, expected) {
  await waitFor(async () => (await readFile(path, "utf8").catch(() => "")).includes(expected), path);
}
async function waitFor(predicate, label) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out waiting for ${label}`);
}

async function terminalStyles(screen) {
  return screen.evaluate(node => ({
    spans: [...node.querySelectorAll(".xterm-rows span")]
      .filter(span => span.textContent?.trim())
      .map(span => ({ text: span.textContent, classes: span.className, inline: span.getAttribute("style"), color: getComputedStyle(span).color })),
  }));
}

async function textColor(screen, text) {
  return screen.evaluate((node, expected) => {
    const span = [...node.querySelectorAll(".xterm-rows span")].find(candidate => candidate.textContent?.trim() === expected);
    return span instanceof HTMLElement ? getComputedStyle(span).color : null;
  }, text);
}

async function paletteColor(screen, index) {
  return screen.evaluate((node, colorIndex) => {
    const pattern = new RegExp(`\\.xterm-fg-${colorIndex} \\{ color: ([^;]+);`);
    for (const style of node.querySelectorAll("style")) {
      const match = pattern.exec(style.textContent ?? "");
      if (match) return match[1];
    }
    return null;
  }, index);
}

function restoreEnvironment(values) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function bashQuote(value) { return `'${value.replaceAll("'", `'\\''`)}'`; }
