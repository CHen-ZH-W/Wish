"use strict";

(() => {
  const MAX_ACTIVITY_ITEMS = 80;
  const state = {
    agentId: undefined,
    sessionStatus: "active",
    sessions: [],
    session: undefined,
    history: [],
    activeRun: undefined,
    stream: undefined,
    streamRunId: undefined,
    runCursors: new Map(),
    liveMessages: [],
    approvals: new Map(),
    activities: [],
    selectedVersion: 0,
    dialogMode: "create",
    liveRenderPending: false,
    composerIsComposing: false,
  };

  const elements = {};

  document.addEventListener("DOMContentLoaded", () => {
    void boot();
  }, { once: true });

  async function boot() {
    collectElements();
    bindInteractions();
    autoSizeComposer();
    try {
      const [health] = await Promise.all([api("/api/health"), loadSessions()]);
      state.agentId = health.agentId;
      elements.agentName.textContent = `agent · ${health.agentId}`;
      setConnection("online", "online");
      const remembered = localStorage.getItem("wish.session.active");
      const first = state.sessions.find((session) => session.sessionId === remembered)
        ?? state.sessions[0];
      if (first !== undefined) await selectSession(first.sessionId);
    } catch (error) {
      setConnection("offline", "unavailable");
      showToast(errorMessage(error), true);
      renderSessions();
      showEmptyState();
    }
  }

  function collectElements() {
    const ids = [
      "app-shell", "session-rail", "session-list", "new-session-button",
      "empty-new-session", "connection-dot", "agent-name", "server-state",
      "toggle-sessions", "session-title", "session-status", "session-scope",
      "rename-session", "archive-session", "toggle-inspector", "close-inspector",
      "inspector-pane", "empty-state", "message-scroll", "message-list",
      "live-region", "composer", "composer-input", "composer-hint", "run-indicator",
      "idle-actions", "active-actions", "send-steer", "send-follow-up", "abort-run",
      "run-status", "run-facts", "approval-section", "approval-count",
      "approval-list", "activity-list", "clear-activity", "scrim",
      "session-dialog", "session-form", "dialog-title", "session-title-input",
      "session-id-input", "workspace-input", "session-id-field", "workspace-field",
      "session-form-error", "save-session", "toast-stack",
    ];
    for (const id of ids) elements[toCamel(id)] = document.getElementById(id);
  }

  function bindInteractions() {
    elements.newSessionButton.addEventListener("click", () => openSessionDialog("create"));
    elements.emptyNewSession.addEventListener("click", () => openSessionDialog("create"));
    elements.sessionList.addEventListener("click", (event) => {
      const row = event.target.closest("[data-session-id]");
      if (row !== null) void selectSession(row.dataset.sessionId);
    });
    for (const chip of document.querySelectorAll("[data-session-status]")) {
      chip.addEventListener("click", () => void switchSessionStatus(chip.dataset.sessionStatus));
    }
    elements.renameSession.addEventListener("click", () => openSessionDialog("rename"));
    elements.archiveSession.addEventListener("click", () => void archiveSelectedSession());
    elements.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      if (runIsActive()) {
        showToast("运行中输入需要明确选择“送入下一步”或“排队新回合”。", true);
        return;
      }
      void startRun();
    });
    elements.composerInput.addEventListener("input", autoSizeComposer);
    elements.composerInput.addEventListener("compositionstart", () => {
      state.composerIsComposing = true;
    });
    elements.composerInput.addEventListener("compositionend", () => {
      state.composerIsComposing = false;
    });
    elements.composerInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
      if (event.isComposing || state.composerIsComposing) return;
      event.preventDefault();
      if (runIsActive()) {
        showToast("运行中请使用两个明确的控制按钮。", true);
      } else {
        elements.composer.requestSubmit();
      }
    });
    elements.sendSteer.addEventListener("click", () => void sendControl("steer"));
    elements.sendFollowUp.addEventListener("click", () => void sendControl("follow_up"));
    elements.abortRun.addEventListener("click", () => void sendControl("abort"));
    elements.clearActivity.addEventListener("click", () => {
      state.activities = [];
      renderActivity();
    });
    elements.approvalList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-approval-id]");
      if (button !== null) {
        void decideApproval(button.dataset.approvalId, button.dataset.decision === "approve");
      }
    });
    elements.toggleInspector.addEventListener("click", openInspector);
    elements.closeInspector.addEventListener("click", closeOverlays);
    elements.toggleSessions.addEventListener("click", openSessions);
    elements.scrim.addEventListener("click", closeOverlays);
    elements.sessionForm.addEventListener("submit", (event) => {
      if (event.submitter?.value === "cancel") return;
      event.preventDefault();
      void saveSessionDialog();
    });
    elements.sessionDialog.addEventListener("close", () => {
      elements.sessionFormError.hidden = true;
      elements.sessionFormError.textContent = "";
    });
    window.addEventListener("beforeunload", closeEventStream);
  }

  async function loadSessions() {
    const result = await api(`/api/sessions?status=${encodeURIComponent(state.sessionStatus)}`);
    state.sessions = Array.isArray(result.sessions) ? result.sessions : [];
    state.sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    renderSessions();
  }

  async function switchSessionStatus(status) {
    if (status !== "active" && status !== "archived") return;
    state.sessionStatus = status;
    for (const chip of document.querySelectorAll("[data-session-status]")) {
      chip.classList.toggle("is-active", chip.dataset.sessionStatus === status);
    }
    clearSelectedSession();
    try {
      await loadSessions();
      if (state.sessions[0] !== undefined) await selectSession(state.sessions[0].sessionId);
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  }

  function renderSessions() {
    const fragment = document.createDocumentFragment();
    if (state.sessions.length === 0) {
      const empty = document.createElement("p");
      empty.className = "list-empty";
      empty.textContent = state.sessionStatus === "active"
        ? "还没有活跃会话。\n创建一个，让 Wish 开始工作。"
        : "没有已归档的会话。";
      fragment.append(empty);
    }
    for (const session of state.sessions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "session-row";
      button.dataset.sessionId = session.sessionId;
      button.classList.toggle("is-active", session.sessionId === state.session?.sessionId);
      button.setAttribute("aria-current", session.sessionId === state.session?.sessionId ? "page" : "false");
      const title = document.createElement("strong");
      title.textContent = session.title || "未命名会话";
      const time = document.createElement("time");
      time.dateTime = session.updatedAt;
      time.textContent = relativeTime(session.updatedAt);
      const scope = document.createElement("small");
      scope.textContent = session.scope;
      button.append(title, time, scope);
      fragment.append(button);
    }
    elements.sessionList.replaceChildren(fragment);
  }

  async function selectSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    const version = ++state.selectedVersion;
    closeEventStream();
    state.activeRun = undefined;
    state.liveMessages = [];
    state.approvals.clear();
    state.activities = [];
    renderActivity();
    renderApprovals();
    setConversationLoading(sessionId);
    closeOverlays();
    try {
      const encoded = encodeURIComponent(sessionId);
      const [sessionResult, historyResult, runsResult] = await Promise.all([
        api(`/api/sessions/${encoded}`),
        api(`/api/sessions/${encoded}/history`),
        api(`/api/sessions/${encoded}/runs`),
      ]);
      if (version !== state.selectedVersion) return;
      state.session = sessionResult.session;
      state.history = historyResult.history?.records ?? [];
      const runs = Array.isArray(runsResult.runs) ? runsResult.runs : [];
      state.activeRun = [...runs].reverse().find((run) => run.status === "running")
        ?? runs.at(-1);
      localStorage.setItem("wish.session.active", sessionId);
      renderSessions();
      renderSessionHeader();
      renderHistory();
      syncRunUi();
      if (runIsActive()) {
        await loadApprovals();
        connectEventStream(state.activeRun);
      }
    } catch (error) {
      if (version !== state.selectedVersion) return;
      showToast(errorMessage(error), true);
      clearSelectedSession();
    }
  }

  function setConversationLoading(sessionId) {
    elements.sessionTitle.textContent = "载入会话…";
    elements.sessionScope.textContent = sessionId;
    elements.emptyState.hidden = true;
    elements.messageScroll.hidden = false;
    elements.composer.hidden = true;
    elements.messageList.replaceChildren();
    elements.liveRegion.replaceChildren();
  }

  function clearSelectedSession() {
    state.selectedVersion += 1;
    closeEventStream();
    state.session = undefined;
    state.history = [];
    state.activeRun = undefined;
    state.liveMessages = [];
    state.approvals.clear();
    renderSessions();
    renderApprovals();
    showEmptyState();
    syncRunUi();
  }

  function showEmptyState() {
    elements.sessionTitle.textContent = "选择一个会话";
    elements.sessionScope.textContent = "创建会话后即可开始工作";
    elements.sessionStatus.hidden = true;
    elements.renameSession.hidden = true;
    elements.archiveSession.hidden = true;
    elements.emptyState.hidden = false;
    elements.messageScroll.hidden = true;
    elements.composer.hidden = true;
  }

  function renderSessionHeader() {
    if (state.session === undefined) return;
    elements.sessionTitle.textContent = state.session.title || "未命名会话";
    elements.sessionScope.textContent = state.session.scope;
    elements.sessionStatus.hidden = false;
    elements.sessionStatus.dataset.status = state.session.status;
    elements.sessionStatus.textContent = state.session.status;
    elements.renameSession.hidden = false;
    elements.archiveSession.hidden = state.session.status === "archived";
    elements.emptyState.hidden = true;
    elements.messageScroll.hidden = false;
    elements.composer.hidden = false;
  }

  function renderHistory() {
    const fragment = document.createDocumentFragment();
    for (const record of state.history) fragment.append(messageElement(record));
    if (state.history.length === 0) {
      const welcome = document.createElement("article");
      welcome.className = "message message-assistant";
      welcome.innerHTML = `<div class="message-meta">Wish</div><div class="message-body"><p>会话已准备好。说说你希望在这个 workspace 中完成什么。</p></div>`;
      fragment.append(welcome);
    }
    elements.messageList.replaceChildren(fragment);
    renderLiveMessages(true);
    requestAnimationFrame(() => scrollToBottom(true));
  }

  function messageElement(record) {
    const message = record.message ?? {};
    const role = record.kind === "checkpoint" ? "checkpoint" : message.role ?? "assistant";
    const article = document.createElement("article");
    article.className = `message message-${role}`;
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const label = document.createElement("span");
    label.textContent = record.kind === "checkpoint"
      ? "Compaction checkpoint"
      : record.origin === "steering"
      ? "Steering"
      : roleLabel(role);
    meta.append(label);
    if (record.createdAt !== undefined) {
      const time = document.createElement("time");
      time.dateTime = record.createdAt;
      time.textContent = formatClock(record.createdAt);
      meta.append(time);
    }
    const body = document.createElement("div");
    body.className = "message-body";
    body.innerHTML = renderMarkdown(message.content || emptyMessageText(message));
    if (typeof message.reasoningContent === "string" && message.reasoningContent.length > 0) {
      article.append(meta, reasoningElement(message.reasoningContent), body);
    } else {
      article.append(meta, body);
    }
    appendContentImages(body, message.contentParts);
    return article;
  }

  function emptyMessageText(message) {
    if (Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      return message.toolCalls.map((call) => `调用工具 \`${call.name}\``).join("\n");
    }
    return "（空消息）";
  }

  function appendContentImages(container, parts) {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      const source = part?.type === "image_url" ? part.imageUrl?.url : undefined;
      if (typeof source !== "string" || !source.startsWith("data:image/")) continue;
      const image = document.createElement("img");
      image.src = source;
      image.alt = "消息图片";
      image.loading = "lazy";
      container.append(image);
    }
  }

  function reasoningElement(text) {
    const details = document.createElement("details");
    details.className = "reasoning-block";
    const summary = document.createElement("summary");
    summary.textContent = "推理过程";
    const content = document.createElement("pre");
    content.textContent = text;
    details.append(summary, content);
    return details;
  }

  async function startRun() {
    if (state.session === undefined || state.session.status !== "active") return;
    const text = elements.composerInput.value.trim();
    if (text.length === 0) {
      elements.composerInput.focus();
      return;
    }
    setComposerBusy(true);
    try {
      const sessionId = encodeURIComponent(state.session.sessionId);
      const accepted = await api(`/api/sessions/${sessionId}/runs`, {
        method: "POST",
        body: { text },
      });
      state.activeRun = accepted.run;
      state.activities = [];
      state.approvals.clear();
      state.liveMessages = [{
        key: `user:${accepted.run.initialUserTurnId}`,
        role: "user",
        label: "You",
        text,
      }];
      elements.composerInput.value = "";
      autoSizeComposer();
      renderLiveMessages(true);
      renderActivity();
      renderApprovals();
      syncRunUi();
      addActivity("Run 已提交", shortId(accepted.run.runId), "success");
      connectEventStream(accepted.run, accepted.eventsUrl);
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      setComposerBusy(false);
    }
  }

  async function sendControl(type) {
    if (!runIsActive()) return;
    const text = elements.composerInput.value.trim();
    if (type !== "abort" && text.length === 0) {
      elements.composerInput.focus();
      return;
    }
    const body = type === "abort"
      ? { type: "abort", reason: "Stopped from Wish WebUI" }
      : { type, text };
    setComposerBusy(true);
    try {
      const result = await api(`/api/runs/${encodeURIComponent(state.activeRun.runId)}/controls`, {
        method: "POST",
        body,
      });
      const receipt = result.receipt;
      if (!receipt.accepted) {
        showToast(`控制未接受：${receipt.reason || "unknown"}`, true);
        addActivity(`${controlLabel(type)}被拒绝`, receipt.reason || "unknown", "error");
        return;
      }
      if (type !== "abort") {
        elements.composerInput.value = "";
        autoSizeComposer();
      }
      addActivity(
        controlLabel(type),
        receipt.position === undefined ? shortId(receipt.controlId) : `队列位置 ${receipt.position}`,
        type === "abort" ? "error" : "success",
      );
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      setComposerBusy(false);
    }
  }

  function connectEventStream(run, suppliedUrl) {
    closeEventStream();
    if (run === undefined || run.status !== "running") return;
    const cursor = state.runCursors.get(run.runId) ?? 0;
    const base = suppliedUrl ?? `/api/runs/${encodeURIComponent(run.runId)}/events`;
    const separator = base.includes("?") ? "&" : "?";
    const source = new EventSource(`${base}${separator}after=${cursor}`);
    state.stream = source;
    state.streamRunId = run.runId;
    setConnection("online", "stream connecting");

    source.addEventListener("stream.ready", () => {
      if (state.stream !== source) return;
      setConnection("online", "stream live");
      addActivity("事件流已连接", cursor === 0 ? "从头观察" : `从事件 ${cursor} 继续`, "success");
    });
    source.addEventListener("model.stream", (event) => handleOutputEvent(event, "model"));
    source.addEventListener("tool.lifecycle", (event) => handleOutputEvent(event, "tool"));
    source.addEventListener("runtime.transition", (event) => handleOutputEvent(event, "runtime"));
    source.addEventListener("approval.snapshot", (event) => {
      const data = eventData(event);
      state.approvals.clear();
      for (const approval of data.approvals ?? []) state.approvals.set(approval.approvalId, approval);
      renderApprovals();
    });
    source.addEventListener("approval.requested", (event) => {
      const approval = eventData(event).approval;
      if (approval !== undefined) state.approvals.set(approval.approvalId, approval);
      renderApprovals();
      openInspector();
      showToast(`工具 ${approval?.call?.name ?? ""} 等待授权`);
    });
    source.addEventListener("approval.resolved", (event) => {
      const approval = eventData(event).approval;
      if (approval !== undefined) state.approvals.delete(approval.approvalId);
      renderApprovals();
      addActivity(`工具授权${approval?.status === "approved" ? "通过" : "结束"}`, approval?.call?.name ?? "", approval?.status === "approved" ? "success" : "error");
    });
    source.addEventListener("stream.error", (event) => {
      const error = eventData(event).error;
      addActivity("事件流错误", error?.message ?? "unknown", "error");
      showToast(error?.message ?? "事件流无法继续", true);
      source.close();
      if (
        error?.code === "event_cursor_expired" &&
        Number.isSafeInteger(error.earliestAvailable) &&
        state.activeRun?.runId === run.runId
      ) {
        state.runCursors.set(run.runId, Math.max(0, error.earliestAvailable - 1));
        connectEventStream(run);
      }
    });
    source.onerror = () => {
      if (state.stream !== source || !runIsActive()) return;
      setConnection("online", "stream reconnecting");
    };
  }

  function handleOutputEvent(event, kind) {
    const envelope = eventData(event);
    if (envelope.runId !== state.activeRun?.runId) return;
    const sequence = Number(event.lastEventId || envelope.sequence);
    if (Number.isSafeInteger(sequence)) {
      state.runCursors.set(envelope.runId, sequence);
      updateRunFacts();
    }
    if (kind === "model") handleModelEvent(envelope);
    if (kind === "tool") handleToolEvent(envelope);
    if (kind === "runtime") handleRuntimeEvent(envelope);
  }

  function handleModelEvent(envelope) {
    const payload = envelope.payload ?? {};
    if (payload.type === "start") {
      state.activeRun.model = `${payload.model?.provider ?? "?"}/${payload.model?.model ?? "?"}`;
      addActivity("模型开始响应", state.activeRun.model, "success");
      updateRunFacts();
      return;
    }
    if (payload.type === "text_delta" || payload.type === "reasoning_delta") {
      const message = ensureLiveAssistant(envelope.stepId, envelope.userTurnId);
      if (payload.type === "text_delta") message.text += payload.text ?? "";
      else message.reasoning += payload.text ?? "";
      scheduleLiveRender();
      return;
    }
    if (payload.type === "tool_call") {
      addActivity("模型请求工具", payload.call?.name ?? "unknown", "tool");
      return;
    }
    if (payload.type === "retry") {
      addActivity("模型重试", payload.error?.message ?? `第 ${payload.retryCount} 次`, "error");
      return;
    }
    if (payload.type === "error") {
      addActivity("模型错误", payload.error?.message ?? "unknown", "error");
      return;
    }
    if (payload.type === "done") {
      addActivity("模型输出完成", usageText(payload.usage), "success");
    }
  }

  function handleToolEvent(envelope) {
    const payload = envelope.payload ?? {};
    const toolName = payload.call?.name ?? "tool";
    const labels = {
      "tool.queued": "工具已排队",
      "tool.prepared": "工具已准备",
      "tool.authorization_requested": "工具请求授权",
      "tool.authorization_denied": "工具授权拒绝",
      "tool.dispatched": "工具执行中",
      "tool.completed": "工具完成",
      "tool.failed": "工具失败",
      "tool.aborted": "工具终止",
    };
    const failure = payload.type === "tool.failed" || payload.type === "tool.aborted" || payload.type === "tool.authorization_denied";
    addActivity(labels[payload.type] ?? payload.type ?? "工具事件", toolName, failure ? "error" : "tool");
  }

  function handleRuntimeEvent(envelope) {
    const transition = envelope.payload ?? {};
    if (transition.type === "user_turn.started") {
      const text = transition.input?.text;
      const key = `user:${transition.userTurnId}`;
      if (typeof text === "string" && !state.liveMessages.some((item) => item.key === key)) {
        state.liveMessages.push({ key, role: "user", label: "You", text });
        renderLiveMessages(true);
      }
    }
    const meaningful = runtimeActivity(transition);
    if (meaningful !== undefined) addActivity(...meaningful);
    if (transition.type === "run.completed") finishRun("completed");
    if (transition.type === "run.failed") finishRun("failed", transition.error?.message);
    if (transition.type === "run.aborted") finishRun("aborted", transition.cancellation?.reason);
  }

  function runtimeActivity(transition) {
    switch (transition.type) {
      case "run.started": return ["Run 开始", "Runtime 已接管", "success"];
      case "user_turn.started": return ["新回合", `第 ${transition.ordinal} 回合`, "success"];
      case "step.started": return ["Step 开始", `第 ${transition.ordinal} 步`, ""];
      case "step.completed": return ["Step 完成", transition.reason ?? "", "success"];
      case "step.failed": return ["Step 失败", transition.error?.message ?? "", "error"];
      case "control.queued": return [controlLabel(transition.kind), `队列位置 ${transition.position}`, ""];
      case "control.steering_delivered": return ["指引已送达", shortId(transition.stepId), "success"];
      case "control.follow_up_dequeued": return ["新回合已出队", shortId(transition.controlId), "success"];
      case "control.rejected": return ["控制被拒绝", transition.reason ?? "", "error"];
      default: return undefined;
    }
  }

  function finishRun(status, reason) {
    if (state.activeRun === undefined) return;
    state.activeRun.status = status;
    addActivity(`Run ${status}`, reason ?? shortId(state.activeRun.runId), status === "completed" ? "success" : "error");
    closeEventStream();
    syncRunUi();
    void refreshTerminalFacts(state.activeRun.runId);
  }

  async function refreshTerminalFacts(runId) {
    if (state.session === undefined) return;
    try {
      const encodedSession = encodeURIComponent(state.session.sessionId);
      const [runResult, historyResult] = await Promise.all([
        api(`/api/runs/${encodeURIComponent(runId)}`),
        api(`/api/sessions/${encodedSession}/history`),
      ]);
      if (state.activeRun?.runId !== runId) return;
      state.activeRun = runResult.run;
      state.history = historyResult.history?.records ?? [];
      state.liveMessages = [];
      renderHistory();
      syncRunUi();
      await loadSessions();
    } catch (error) {
      showToast(`终态历史刷新失败：${errorMessage(error)}`, true);
    }
  }

  function ensureLiveAssistant(stepId, userTurnId) {
    const key = `assistant:${stepId ?? userTurnId ?? state.liveMessages.length}`;
    let message = state.liveMessages.find((item) => item.key === key);
    if (message === undefined) {
      message = { key, role: "assistant", label: "Wish · live", text: "", reasoning: "" };
      state.liveMessages.push(message);
    }
    return message;
  }

  function scheduleLiveRender() {
    if (state.liveRenderPending) return;
    state.liveRenderPending = true;
    requestAnimationFrame(() => {
      state.liveRenderPending = false;
      renderLiveMessages();
    });
  }

  function renderLiveMessages(forceBottom = false) {
    const stick = forceBottom || shouldStickToBottom();
    const fragment = document.createDocumentFragment();
    for (const item of state.liveMessages) {
      const article = document.createElement("article");
      article.className = `message message-${item.role} ${item.role === "assistant" ? "live-card" : ""}`;
      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = item.label;
      const body = document.createElement("div");
      body.className = `message-body ${item.role === "assistant" && runIsActive() ? "live-caret" : ""}`;
      body.innerHTML = renderMarkdown(item.text || (item.reasoning ? "正在组织回答…" : "等待响应…"));
      article.append(meta);
      if (item.reasoning) article.append(reasoningElement(item.reasoning));
      article.append(body);
      fragment.append(article);
    }
    elements.liveRegion.replaceChildren(fragment);
    if (stick) requestAnimationFrame(() => scrollToBottom());
  }

  function syncRunUi() {
    const active = runIsActive();
    elements.idleActions.hidden = active;
    elements.activeActions.hidden = !active;
    elements.composerInput.disabled = state.session?.status === "archived";
    elements.composerHint.textContent = active
      ? "运行中输入必须选择用途"
      : state.session?.status === "archived"
      ? "已归档会话不可运行"
      : "Ctrl / ⌘ + Enter 发送";
    elements.runIndicator.classList.toggle("is-running", active);
    elements.runIndicator.querySelector("span").textContent = active ? "运行中" : "准备就绪";
    elements.runStatus.dataset.status = state.activeRun?.status ?? "idle";
    elements.runStatus.textContent = state.activeRun?.status ?? "idle";
    updateRunFacts();
  }

  function updateRunFacts() {
    const values = elements.runFacts.querySelectorAll("dd");
    const cursor = state.activeRun === undefined ? undefined : state.runCursors.get(state.activeRun.runId);
    values[0].textContent = state.activeRun === undefined ? "—" : shortId(state.activeRun.runId);
    values[0].title = state.activeRun?.runId ?? "";
    values[1].textContent = state.activeRun?.model ?? "—";
    values[1].title = state.activeRun?.model ?? "";
    values[2].textContent = cursor === undefined ? "—" : `#${cursor}`;
  }

  async function loadApprovals() {
    if (!runIsActive()) return;
    try {
      const result = await api(`/api/approvals?runId=${encodeURIComponent(state.activeRun.runId)}`);
      state.approvals.clear();
      for (const approval of result.approvals ?? []) state.approvals.set(approval.approvalId, approval);
      renderApprovals();
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  }

  function renderApprovals() {
    const approvals = [...state.approvals.values()];
    elements.approvalSection.hidden = approvals.length === 0;
    elements.approvalCount.textContent = String(approvals.length);
    const fragment = document.createDocumentFragment();
    for (const approval of approvals) {
      const card = document.createElement("article");
      card.className = "approval-card";
      const title = document.createElement("strong");
      title.textContent = approval.call?.name ?? "Unknown tool";
      const scope = document.createElement("p");
      scope.textContent = approval.workspace?.cwd ?? "";
      const input = document.createElement("pre");
      input.textContent = JSON.stringify(approval.call?.input ?? {}, null, 2);
      const actions = document.createElement("div");
      actions.className = "approval-actions";
      const deny = approvalButton("拒绝", approval.approvalId, "deny", "secondary-button");
      const approve = approvalButton("仅本次允许", approval.approvalId, "approve", "primary-button");
      actions.append(deny, approve);
      card.append(title, scope, input, actions);
      fragment.append(card);
    }
    elements.approvalList.replaceChildren(fragment);
  }

  function approvalButton(label, approvalId, decision, className) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.dataset.approvalId = approvalId;
    button.dataset.decision = decision;
    button.textContent = label;
    return button;
  }

  async function decideApproval(approvalId, approved) {
    for (const button of elements.approvalList.querySelectorAll("button")) button.disabled = true;
    try {
      await api(`/api/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        body: { approved },
      });
      state.approvals.delete(approvalId);
      renderApprovals();
    } catch (error) {
      showToast(errorMessage(error), true);
      renderApprovals();
    }
  }

  function addActivity(title, detail = "", tone = "") {
    state.activities.unshift({ title, detail, tone, at: new Date().toISOString() });
    state.activities = state.activities.slice(0, MAX_ACTIVITY_ITEMS);
    renderActivity();
  }

  function renderActivity() {
    const fragment = document.createDocumentFragment();
    if (state.activities.length === 0) {
      const empty = document.createElement("li");
      empty.className = "activity-empty";
      empty.textContent = "运行事件会显示在这里";
      fragment.append(empty);
    }
    for (const activity of state.activities) {
      const item = document.createElement("li");
      item.className = `activity-item${activity.tone ? ` is-${activity.tone}` : ""}`;
      const title = document.createElement("strong");
      title.textContent = activity.title;
      const detail = document.createElement("span");
      detail.textContent = `${activity.detail}${activity.detail ? " · " : ""}${formatClock(activity.at)}`;
      item.append(title, detail);
      fragment.append(item);
    }
    elements.activityList.replaceChildren(fragment);
  }

  function openSessionDialog(mode) {
    state.dialogMode = mode;
    elements.sessionForm.reset();
    elements.sessionFormError.hidden = true;
    const creating = mode === "create";
    elements.dialogTitle.textContent = creating ? "新建会话" : "重命名会话";
    elements.saveSession.textContent = creating ? "创建" : "保存";
    elements.sessionIdField.hidden = !creating;
    elements.workspaceField.hidden = !creating;
    if (!creating && state.session !== undefined) {
      elements.sessionTitleInput.value = state.session.title ?? "";
    }
    elements.sessionDialog.showModal();
    requestAnimationFrame(() => elements.sessionTitleInput.focus());
  }

  async function saveSessionDialog() {
    elements.sessionFormError.hidden = true;
    elements.saveSession.disabled = true;
    try {
      if (state.dialogMode === "rename") {
        if (state.session === undefined) return;
        const title = elements.sessionTitleInput.value.trim();
        const result = await api(`/api/sessions/${encodeURIComponent(state.session.sessionId)}`, {
          method: "PATCH",
          body: { title: title.length === 0 ? null : title },
        });
        state.session = result.session;
        const match = state.sessions.findIndex((session) => session.sessionId === state.session.sessionId);
        if (match >= 0) state.sessions[match] = state.session;
        renderSessions();
        renderSessionHeader();
      } else {
        const body = compactObject({
          title: elements.sessionTitleInput.value.trim(),
          sessionId: elements.sessionIdInput.value.trim(),
          workspaceRoot: elements.workspaceInput.value.trim(),
        });
        const result = await api("/api/sessions", { method: "POST", body });
        state.sessionStatus = "active";
        for (const chip of document.querySelectorAll("[data-session-status]")) {
          chip.classList.toggle("is-active", chip.dataset.sessionStatus === "active");
        }
        await loadSessions();
        await selectSession(result.session.sessionId);
      }
      elements.sessionDialog.close();
    } catch (error) {
      elements.sessionFormError.textContent = errorMessage(error);
      elements.sessionFormError.hidden = false;
    } finally {
      elements.saveSession.disabled = false;
    }
  }

  async function archiveSelectedSession() {
    if (state.session === undefined || runIsActive()) {
      if (runIsActive()) showToast("请先终止当前 Run，再归档会话。", true);
      return;
    }
    if (!window.confirm(`归档“${state.session.title || "未命名会话"}”？历史不会被删除。`)) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(state.session.sessionId)}/archive`, {
        method: "POST",
        body: {},
      });
      await loadSessions();
      clearSelectedSession();
      if (state.sessions[0] !== undefined) await selectSession(state.sessions[0].sessionId);
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  }

  function openInspector() {
    if (window.matchMedia("(max-width: 1080px)").matches) {
      elements.inspectorPane.classList.add("is-open");
      elements.scrim.hidden = false;
    }
  }

  function openSessions() {
    elements.sessionRail.classList.add("is-open");
    elements.scrim.hidden = false;
  }

  function closeOverlays() {
    elements.inspectorPane.classList.remove("is-open");
    elements.sessionRail.classList.remove("is-open");
    elements.scrim.hidden = true;
  }

  function closeEventStream() {
    state.stream?.close();
    state.stream = undefined;
    state.streamRunId = undefined;
    if (state.agentId !== undefined) setConnection("online", "online");
  }

  function setConnection(kind, text) {
    elements.connectionDot.className = `connection-dot is-${kind}`;
    elements.connectionDot.title = text;
    elements.serverState.textContent = text;
  }

  function setComposerBusy(busy) {
    for (const button of elements.composer.querySelectorAll("button")) button.disabled = busy;
    if (!runIsActive()) elements.composerInput.disabled = busy || state.session?.status === "archived";
  }

  function autoSizeComposer() {
    // Modern browsers size the textarea through CSS `field-sizing: content`.
    // Keeping sizing out of element.style preserves the strict style CSP.
  }

  function shouldStickToBottom() {
    const scroll = elements.messageScroll;
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 110;
  }

  function scrollToBottom(immediate = false) {
    elements.messageScroll.scrollTo({
      top: elements.messageScroll.scrollHeight,
      behavior: immediate ? "auto" : "smooth",
    });
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method ?? "GET",
      headers: options.body === undefined ? undefined : { "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let value;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    if (!response.ok) {
      const error = new Error(value?.error?.message ?? `HTTP ${response.status}`);
      error.code = value?.error?.code;
      throw error;
    }
    return value;
  }

  function eventData(event) {
    try {
      return JSON.parse(event.data);
    } catch {
      return {};
    }
  }

  function renderMarkdown(source) {
    const lines = String(source ?? "").replace(/\r\n?/gu, "\n").split("\n");
    const output = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (line.startsWith("```")) {
        const language = line.slice(3).trim().replace(/[^a-zA-Z0-9_-]/gu, "");
        const code = [];
        index += 1;
        while (index < lines.length && !lines[index].startsWith("```")) code.push(lines[index++]);
        if (index < lines.length) index += 1;
        output.push(`<pre><code${language ? ` class="language-${language}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
        continue;
      }
      if (line.trim() === "") {
        index += 1;
        continue;
      }
      const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
      if (heading !== null) {
        output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`);
        index += 1;
        continue;
      }
      const nextNonEmpty = lines[index + 1]?.trim() === "" ? index + 2 : index + 1;
      if (line.includes("|") && tableSeparator(lines[nextNonEmpty])) {
        const headers = tableCells(line);
        const alignments = tableCells(lines[nextNonEmpty]).map(tableAlignment);
        const rows = [];
        index = nextNonEmpty + 1;
        while (index < lines.length && lines[index].includes("|") && lines[index].trim() !== "") {
          rows.push(tableCells(lines[index++]));
        }
        output.push(`<table><thead><tr>${headers.map((cell, cellIndex) => `<th class="align-${alignments[cellIndex] ?? "left"}">${inlineMarkdown(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td class="align-${alignments[cellIndex] ?? "left"}">${inlineMarkdown(row[cellIndex] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
        continue;
      }
      if (/^\s*[-*+]\s+/u.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*[-*+]\s+/u.test(lines[index])) {
          items.push(lines[index++].replace(/^\s*[-*+]\s+/u, ""));
        }
        output.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
        continue;
      }
      if (/^\s*\d+[.)]\s+/u.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*\d+[.)]\s+/u.test(lines[index])) {
          items.push(lines[index++].replace(/^\s*\d+[.)]\s+/u, ""));
        }
        output.push(`<ol>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ol>`);
        continue;
      }
      if (/^>\s?/u.test(line)) {
        const quote = [];
        while (index < lines.length && /^>\s?/u.test(lines[index])) quote.push(lines[index++].replace(/^>\s?/u, ""));
        output.push(`<blockquote>${quote.map(inlineMarkdown).join("<br>")}</blockquote>`);
        continue;
      }
      if (/^\s*([-*_])\1\1+\s*$/u.test(line)) {
        output.push("<hr>");
        index += 1;
        continue;
      }
      const paragraph = [line];
      index += 1;
      while (index < lines.length && lines[index].trim() !== "" && !blockStart(lines, index)) {
        paragraph.push(lines[index++]);
      }
      output.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
    }
    return output.join("");
  }

  function blockStart(lines, index) {
    const line = lines[index];
    return line.startsWith("```") || /^(#{1,3})\s+/u.test(line) || /^\s*[-*+]\s+/u.test(line)
      || /^\s*\d+[.)]\s+/u.test(line) || /^>\s?/u.test(line)
      || /^\s*([-*_])\1\1+\s*$/u.test(line) || tableSeparator(lines[index + 1]);
  }

  function inlineMarkdown(source) {
    const code = [];
    const prepared = String(source).replace(/[\uE000\uE001]/gu, "").replace(/`([^`]+)`/gu, (_all, value) => {
      const token = `\uE000${code.length}\uE001`;
      code.push(`<code>${escapeHtml(value)}</code>`);
      return token;
    });
    return escapeHtml(prepared)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
      .replace(/\*\*([^*]+)\*\*/gu, "<strong>$1</strong>")
      .replace(/__([^_]+)__/gu, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/gu, "$1<em>$2</em>")
      .replace(/\uE000(\d+)\uE001/gu, (_all, value) => code[Number(value)] ?? "");
  }

  function tableSeparator(line) {
    if (typeof line !== "string" || !line.includes("-")) return false;
    const cells = tableCells(line);
    return cells.length > 0 && cells.every((cell) => /^:?-+:?$/u.test(cell.replace(/\s/gu, "")));
  }

  function tableCells(line) {
    return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
  }

  function tableAlignment(separator) {
    const value = separator.replace(/\s/gu, "");
    if (value.startsWith(":") && value.endsWith(":")) return "center";
    if (value.endsWith(":")) return "right";
    return "left";
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/gu, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function roleLabel(role) {
    return ({ user: "You", assistant: "Wish", tool: "Tool", system: "System", developer: "Developer", checkpoint: "Checkpoint" })[role] ?? role;
  }

  function controlLabel(type) {
    return ({ steer: "送入下一步", follow_up: "排队新回合", abort: "请求终止" })[type] ?? type;
  }

  function usageText(usage) {
    if (usage === undefined) return "完成";
    return `${usage.inputTokens ?? 0} in · ${usage.outputTokens ?? 0} out`;
  }

  function runIsActive() {
    return state.activeRun?.status === "running";
  }

  function compactObject(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined));
  }

  function shortId(value) {
    if (typeof value !== "string") return "—";
    return value.length <= 14 ? value : `${value.slice(0, 7)}…${value.slice(-5)}`;
  }

  function relativeTime(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return "";
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
    if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
    return formatter.format(Math.round(hours / 24), "day");
  }

  function formatClock(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date)
      : "";
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function showToast(message, error = false) {
    const toast = document.createElement("div");
    toast.className = `toast${error ? " is-error" : ""}`;
    toast.textContent = message;
    elements.toastStack.append(toast);
    window.setTimeout(() => toast.remove(), 4_600);
  }

  function toCamel(value) {
    return value.replace(/-([a-z])/gu, (_all, letter) => letter.toUpperCase());
  }
})();
