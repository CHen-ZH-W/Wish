import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";

import { bootstrap } from "../dist/boot/bootstrap.js";
import { managedWebUi } from "../dist/apps/webui/host/composition.js";

const directory = await mkdtemp(join(tmpdir(), "wish-tmux-sidebar-browser-"));
const sessionId = randomUUID();
let booted, browser, terminal, captureCalls = 0;
try {
  booted = await bootstrap({
    surface: "webui", cwd: directory, homeDirectory: directory,
    environment: { WISH_DATA_DIR: join(directory, "data"), WISH_WEBUI_WORKSPACE_ROOT: directory, CORDIS_HMR: "0" },
    management: managedWebUi({ directory: join(directory, "management"), port: 0 }),
  });
  const context = booted.surfaceContext;
  const tmux = context.get("tmux"), capture = tmux.capture.bind(tmux);
  tmux.capture = async request => { captureCalls++; return capture(request); };
  await context.get("sessions").manager.create({ sessionId, agentId: context.get("agents").agentId, scope: directory });
  await context.get("sessionPermissions").port.initialize(sessionId, "approval-required");
  terminal = await context.get("tmux").start({ sessionId: "sidebar-layout", windowName: "observe", command: { executable: "/bin/cat", cwd: directory }, metadata: { workspaceRoot: directory, label: "Responsive managed terminal" } });
  await context.get("tmux").send({ target: terminal.target, text: `TMUX_SIDEBAR_LAYOUT ${"wide-output ".repeat(30)}`, enter: true });

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(booted.context.get("webManagementHost").url);
  await page.locator("#wish-composer").waitFor();
  await page.getByRole("button", { name: "执行记录", exact: true }).click();
  const sidebar = page.getByRole("complementary", { name: "会话侧栏", exact: true });
  await sidebar.getByRole("button", { name: "打开 tmux", exact: true }).click();
  await sidebar.getByRole("button", { name: "刷新 tmux 列表", exact: true }).click();
  await sidebar.locator(".terminal-output").filter({ hasText: "TMUX_SIDEBAR_LAYOUT" }).waitFor();

  const resize = page.getByRole("separator", { name: "调整右侧栏宽度", exact: true });
  await resize.press("Home");
  await assertLayout(sidebar, "narrow");
  const narrow = await sidebar.locator(".tmux-sidebar-view").evaluate(node => {
    const heading = node.querySelector(".tmux-process-heading");
    const snapshotHeader = node.querySelector(".terminal-snapshot > header");
    const time = node.querySelector(".terminal-snapshot-time");
    const footer = node.querySelector(".terminal-snapshot > footer");
    const toolbar = node.querySelector(".tmux-sidebar-toolbar");
    const refresh = toolbar?.querySelector("button");
    return {
      headingDirection: heading ? getComputedStyle(heading).flexDirection : null,
      snapshotDirection: snapshotHeader ? getComputedStyle(snapshotHeader).flexDirection : null,
      timeWidth: time?.getBoundingClientRect().width ?? 0,
      footerWidth: footer?.getBoundingClientRect().width ?? 0,
      rootWidth: node.getBoundingClientRect().width,
      toolbarWidth: toolbar?.getBoundingClientRect().width ?? 0,
      refreshRight: refresh?.getBoundingClientRect().right ?? 0,
      rootRight: node.getBoundingClientRect().right,
      statusRows: node.querySelectorAll(".tmux-sidebar-toolbar [role=status]").length,
    };
  });
  assert.equal(narrow.headingDirection, "column", "the session heading stacks in the minimum-width sidebar");
  assert.equal(narrow.snapshotDirection, "column", "snapshot metadata stacks in the minimum-width sidebar");
  assert.ok(narrow.timeWidth > narrow.footerWidth * 0.8, "snapshot time owns a full row at the minimum width");
  assert.ok(Math.abs(narrow.toolbarWidth - narrow.rootWidth) < 1, "the status separator spans the complete narrow sidebar");
  assert.ok(Math.abs(narrow.rootRight - narrow.refreshRight - 6) < 1, "the refresh action is anchored to the right edge");
  assert.equal(narrow.statusRows, 1, "tmux keeps one concise status line");

  await resize.press("End");
  await assertLayout(sidebar, "wide");
  const wide = await sidebar.locator(".tmux-sidebar-view").evaluate(node => {
    const toolbar = node.querySelector(".tmux-sidebar-toolbar"), refresh = toolbar.querySelector("button"), root = node.getBoundingClientRect();
    return {
      headingDirection: getComputedStyle(node.querySelector(".tmux-process-heading")).flexDirection,
      snapshotDirection: getComputedStyle(node.querySelector(".terminal-snapshot > header")).flexDirection,
      rootWidth: root.width,
      toolbarWidth: toolbar.getBoundingClientRect().width,
      toolbarHeight: toolbar.getBoundingClientRect().height,
      refreshSize: refresh.getBoundingClientRect().width,
      refreshRight: refresh.getBoundingClientRect().right,
      rootRight: root.right,
      processRadius: getComputedStyle(node.querySelector(".process-record")).borderRadius,
    };
  });
  assert.equal(wide.headingDirection, "row", "the session heading returns to one row when the sidebar is widened");
  assert.equal(wide.snapshotDirection, "row", "snapshot metadata returns to one row when the sidebar is widened");
  assert.equal(wide.toolbarHeight, 38, "tmux uses the same 38px resource toolbar as Files");
  assert.equal(wide.refreshSize, 28, "tmux uses the same 28px toolbar action as Files");
  assert.ok(wide.toolbarWidth > narrow.toolbarWidth && Math.abs(wide.toolbarWidth - wide.rootWidth) < 1, "the status separator grows with the sidebar");
  assert.ok(Math.abs(wide.rootRight - wide.refreshRight - 6) < 1, "the refresh action keeps a fixed right inset after resizing");
  assert.ok(Math.abs(wide.refreshRight - narrow.refreshRight) < 1, "resizing the left boundary does not move the refresh action");
  assert.equal(wide.processRadius, "0px", "sessions are flat resource sections rather than dashboard cards");
  assert.match(await sidebar.locator(".terminal-output").innerText(), /TMUX_SIDEBAR_LAYOUT/u, "tmux output survives both resize directions");

  await sidebar.getByRole("button", { name: "收起会话侧栏", exact: true }).click();
  await page.waitForTimeout(400);
  const hiddenCaptureCalls = captureCalls;
  await page.waitForTimeout(1_800);
  assert.equal(captureCalls, hiddenCaptureCalls, "a mounted but hidden tmux tab must not continue polling");
  await page.getByRole("button", { name: "打开会话侧栏", exact: true }).click();
  await waitFor(() => captureCalls > hiddenCaptureCalls, "tmux polling to resume after the tab becomes visible");
  assert.deepEqual(errors, []);
  console.log("responsive tmux sidebar layout and resource styling passed");
} finally {
  if (terminal && booted) await booted.surfaceContext.get("tmux")?.stop({ target: terminal.target }).catch(() => undefined);
  await browser?.close(); await booted?.dispose(); await rm(directory, { recursive: true, force: true });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function assertLayout(sidebar, label) {
  await sidebar.locator(".tmux-sidebar-view").waitFor();
  const layout = await sidebar.locator(".tmux-sidebar-view").evaluate(node => {
    const list = node.querySelector(".terminal-list");
    const output = node.querySelector(".terminal-output");
    return {
      rootClientWidth: node.clientWidth, rootScrollWidth: node.scrollWidth,
      rootClientHeight: node.clientHeight, rootScrollHeight: node.scrollHeight,
      listClientWidth: list?.clientWidth ?? 0, listScrollWidth: list?.scrollWidth ?? 0,
      outputClientWidth: output?.clientWidth ?? 0,
    };
  });
  assert.ok(layout.rootClientWidth > 0 && layout.rootClientHeight > 0, `${label}: tmux owns the available pane`);
  assert.ok(layout.rootScrollWidth <= layout.rootClientWidth, `${label}: the tmux root has no horizontal overflow: ${JSON.stringify(layout)}`);
  assert.ok(layout.rootScrollHeight <= layout.rootClientHeight, `${label}: scrolling stays in the tmux list: ${JSON.stringify(layout)}`);
  assert.ok(layout.listScrollWidth <= layout.listClientWidth, `${label}: the session list has no horizontal overflow: ${JSON.stringify(layout)}`);
  assert.ok(layout.outputClientWidth > 0 && layout.outputClientWidth <= layout.listClientWidth, `${label}: terminal output remains contained by the resized pane`);
}
