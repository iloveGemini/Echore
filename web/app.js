/**
 * Echore · 内部算法联调与性格测试台 (Observatory & Testbench) 前端逻辑
 * 对接 HTTP + SSE 双通道接口：
 *  - 陪伴主视图 (Companion Surface): GET /api/companion/state, POST /api/chat
 *  - 造物主观测台 (Observatory Surface): GET /api/observatory/state, GET /api/observatory/archetypes,
 *    POST /api/observatory/persona, POST /api/heartbeat, POST /api/fast-forward, POST /api/sleep
 *  - 实时事件流 (SSE): GET /api/events
 */

(function () {
  "use strict";

  const ARCHETYPE_DEFAULT_NAMES = {
    cat_aloof: "林栖",
    dog_sunny: "向阳",
    cool_detached: "沈疏",
    clingy_sensitive: "小满",
    steady_anchor: "周叙",
  };

  // DOM 引用
  const els = {
    sseStatus: document.getElementById("sse-status"),
    clockDisplay: document.getElementById("clock-display"),
    dateDisplay: document.getElementById("date-display"),
    personaNameDisplay: document.getElementById("persona-name-display"),
    archetypeBadge: document.getElementById("archetype-badge"),

    expressionBadge: document.getElementById("expression-badge"),
    toneText: document.getElementById("tone-text"),
    handoverPill: document.getElementById("handover-pill"),
    concernsContent: document.getElementById("concerns-content"),
    chatStream: document.getElementById("chat-stream"),
    chatForm: document.getElementById("chat-form"),
    chatInput: document.getElementById("chat-input"),
    sendBtn: document.getElementById("send-btn"),

    refreshStateBtn: document.getElementById("refresh-state-btn"),
    archetypeSelect: document.getElementById("archetype-select"),
    applyArchetypeBtn: document.getElementById("apply-archetype-btn"),
    resetHormonesCheck: document.getElementById("reset-hormones-check"),

    matrixBaseline: document.getElementById("matrix-baseline"),
    matrixSensHalflife: document.getElementById("matrix-sens-halflife"),
    slotHurt: document.getElementById("slot-hurt"),
    slotMissing: document.getElementById("slot-missing"),
    slotBored: document.getElementById("slot-bored"),
    slotWarm: document.getElementById("slot-warm"),

    lastStepTime: document.getElementById("last-step-time"),
    valCortisol: document.getElementById("val-cortisol"),
    barCortisol: document.getElementById("bar-cortisol"),
    valOxytocin: document.getElementById("val-oxytocin"),
    barOxytocin: document.getElementById("bar-oxytocin"),
    valDopamine: document.getElementById("val-dopamine"),
    barDopamine: document.getElementById("bar-dopamine"),
    valMelatonin: document.getElementById("val-melatonin"),
    barMelatonin: document.getElementById("bar-melatonin"),

    btnHeartbeat: document.getElementById("btn-heartbeat"),
    btnSleep: document.getElementById("btn-sleep"),
    clearEventsBtn: document.getElementById("clear-events-btn"),
    eventsLog: document.getElementById("events-log"),
  };

  let cachedPresets = null;
  let currentProfile = null;
  let eventSource = null;

  /**
   * 根据零数字《潜意识心境交接单》推导 7 态表情标签
   */
  function deriveExpressionFromHandover(handover) {
    if (!handover) return "normal";
    const tone = String(handover.当下心境基调 || "");
    const circadian = String(handover.身体节律感 || "");

    if (circadian.includes("困意") || circadian.includes("入睡")) {
      return "sleepy";
    }
    if (tone.includes("疏离") || tone.includes("闹僵") || tone.includes("无事发生")) {
      return "alienated";
    }
    if (
      tone.includes("不痛快") ||
      tone.includes("防御") ||
      tone.includes("委屈") ||
      tone.includes("摸不准")
    ) {
      return "aggrieved";
    }
    if (tone.includes("惦记") || tone.includes("一阵子没")) {
      return "yearning";
    }
    if (tone.includes("有点闲") || tone.includes("打发时间")) {
      return "solitary";
    }
    if (
      tone.includes("很暖") ||
      tone.includes("轻快") ||
      tone.includes("顺了不少")
    ) {
      return "happy";
    }
    return "normal";
  }

  function formatTimeShort(isoOrStr) {
    if (!isoOrStr) return "--:--";
    if (/^\d{2}:\d{2}$/.test(isoOrStr)) return isoOrStr;
    const d = new Date(isoOrStr);
    if (Number.isNaN(d.getTime())) return String(isoOrStr);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function appendEventLog(category, text, level = "info") {
    if (!els.eventsLog) return;
    const row = document.createElement("div");
    row.className = `log-entry log-${level}`;
    const nowStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    row.textContent = `[${nowStr}] [${category}] ${text}`;
    els.eventsLog.appendChild(row);
    els.eventsLog.scrollTop = els.eventsLog.scrollHeight;
  }

  async function apiRequest(path, options = {}) {
    const res = await fetch(path, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status} on ${path}`);
    }
    return data;
  }

  /**
   * 渲染陪伴主视图心境与牵挂栏
   */
  function renderHandover(handover) {
    if (!handover) return;
    const expr = deriveExpressionFromHandover(handover);
    if (els.expressionBadge) {
      els.expressionBadge.textContent = expr;
      els.expressionBadge.className = `expression-badge ${expr}`;
    }
    if (els.toneText) {
      const tone = handover.当下心境基调 || "心境平稳自然";
      els.toneText.textContent =
        tone.length > 34 ? `${tone.slice(0, 34)}…` : tone;
    }
    if (els.handoverPill) {
      els.handoverPill.title = `心境：${handover.当下心境基调 || ""}\n节律：${handover.身体节律感 || ""}`;
    }

    const items = Array.isArray(handover.脑子里盘旋的事)
      ? handover.脑子里盘旋的事
      : [];
    if (els.concernsContent) {
      if (items.length === 0) {
        els.concernsContent.textContent = "暂无牵挂";
        els.concernsContent.title = "";
      } else {
        const text = items
          .map((item) => `${item.牵挂}（${item.当时原话印象}）`)
          .join(" ｜ ");
        els.concernsContent.textContent = text;
        els.concernsContent.title = text;
      }
    }
  }

  /**
   * 渲染单条聊天气泡
   */
  function createMessageNode(msg, journalEntry) {
    const row = document.createElement("div");
    row.className = `msg-row ${msg.role === "user" ? "user" : "assistant"}`;

    const meta = document.createElement("div");
    meta.className = "msg-meta";

    const speakerSpan = document.createElement("span");
    speakerSpan.textContent =
      msg.role === "user" ? "你 (User)" : msg.speaker || "林栖";
    meta.appendChild(speakerSpan);

    const timeSpan = document.createElement("span");
    timeSpan.textContent = formatTimeShort(msg.timestamp);
    meta.appendChild(timeSpan);

    if (msg.proactive) {
      const tag = document.createElement("span");
      tag.className = "proactive-tag";
      tag.textContent = "主动破冰";
      meta.appendChild(tag);
    }

    const bubble = document.createElement("div");
    bubble.className = "msg-bubble";
    bubble.textContent = msg.content;

    row.appendChild(meta);
    row.appendChild(bubble);

    if (journalEntry) {
      const badge = document.createElement("div");
      badge.className = "journal-badge";
      badge.textContent = `热记事已落盘：${journalEntry}`;
      row.appendChild(badge);
    }

    return row;
  }

  function renderMessageList(messages) {
    if (!els.chatStream) return;
    els.chatStream.innerHTML = "";
    if (!Array.isArray(messages) || messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "system-hint";
      empty.textContent = "尚无对话记录，发送下方话术开始测试人设反应与内分泌脉冲。";
      els.chatStream.appendChild(empty);
      return;
    }

    for (const msg of messages) {
      els.chatStream.appendChild(createMessageNode(msg));
    }
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
  }

  function appendChatMessage(msg, journalEntry) {
    if (!els.chatStream) return;
    const hint = els.chatStream.querySelector(".system-hint");
    if (hint) {
      hint.remove();
    }
    els.chatStream.appendChild(createMessageNode(msg, journalEntry));
    els.chatStream.scrollTop = els.chatStream.scrollHeight;
  }

  /**
   * 渲染性格原型参数与 4 槽位
   */
  function renderProfileCard(profile) {
    if (!profile) return;
    currentProfile = profile;

    if (els.personaNameDisplay) {
      els.personaNameDisplay.textContent = profile.name || "林栖";
    }
    if (els.archetypeBadge) {
      els.archetypeBadge.textContent =
        profile.dominant_archetype || "cat_aloof";
    }
    if (
      els.archetypeSelect &&
      profile.dominant_archetype &&
      els.archetypeSelect.value !== profile.dominant_archetype
    ) {
      els.archetypeSelect.value = profile.dominant_archetype;
    }

    const b = profile.baseline || {};
    const f = profile.resting_floor || {};
    if (els.matrixBaseline) {
      els.matrixBaseline.innerHTML = [
        `B: cort=${Number(b.cortisol ?? 0).toFixed(2)} | ox=${Number(b.oxytocin ?? 0).toFixed(2)} | da=${Number(b.dopamine ?? 0).toFixed(2)}`,
        `F: cort=${Number(f.cortisol ?? 0).toFixed(2)} | ox=${Number(f.oxytocin ?? 0).toFixed(2)} | da=${Number(f.dopamine ?? 0).toFixed(2)}`,
        `快代谢恢复率 γ=${Number((profile.fast_relief_ratio ?? 0) * 100).toFixed(0)}% · 作息=${profile.chronotype || "regular"}`,
      ].join("<br/>");
    }

    const s = profile.sensitivity || {};
    const hl = profile.half_life_hours || {};
    if (els.matrixSensHalflife) {
      els.matrixSensHalflife.innerHTML = [
        `α: cort=${Number(s.cortisol ?? 1).toFixed(2)}x | ox=${Number(s.oxytocin ?? 1).toFixed(2)}x | da=${Number(s.dopamine ?? 1).toFixed(2)}x`,
        `T½: cort=${Number(hl.cortisol ?? 0).toFixed(1)}h | ox=${Number(hl.oxytocin ?? 0).toFixed(1)}h | da=${Number(hl.dopamine ?? 0).toFixed(1)}h`,
      ].join("<br/>");
    }

    const slots = profile.mood_action_slots || {};
    if (els.slotHurt) els.slotHurt.textContent = slots.when_hurt_or_tense || "--";
    if (els.slotMissing) els.slotMissing.textContent = slots.when_missing_user || "--";
    if (els.slotBored) els.slotBored.textContent = slots.when_bored_alone || "--";
    if (els.slotWarm) els.slotWarm.textContent = slots.when_warm_excited || "--";
  }

  /**
   * 渲染 4 激素实时仪表盘
   */
  function renderHormones(hormoneState) {
    if (!hormoneState) return;

    const setBar = (valEl, barEl, val) => {
      const clamped = Math.max(0, Math.min(1, Number(val ?? 0)));
      if (valEl) valEl.textContent = clamped.toFixed(2);
      if (barEl) barEl.style.width = `${(clamped * 100).toFixed(1)}%`;
    };

    setBar(els.valCortisol, els.barCortisol, hormoneState.cortisol);
    setBar(els.valOxytocin, els.barOxytocin, hormoneState.oxytocin);
    setBar(els.valDopamine, els.barDopamine, hormoneState.dopamine);
    setBar(els.valMelatonin, els.barMelatonin, hormoneState.melatonin);

    if (els.lastStepTime) {
      const floorCort = Number(hormoneState.floor_cort ?? 0).toFixed(2);
      const capOx = Number(hormoneState.cap_ox ?? 1).toFixed(2);
      els.lastStepTime.textContent = `步进：${formatTimeShort(hormoneState.updated_at)} (Floor_cort=${floorCort}, Cap_ox=${capOx})`;
    }
  }

  /**
   * 同步拉取 Companion + Observatory 全量状态
   */
  async function refreshAllState(options = { renderMessages: true }) {
    try {
      const [companion, observatory] = await Promise.all([
        apiRequest("/api/companion/state"),
        apiRequest("/api/observatory/state"),
      ]);

      if (els.clockDisplay) {
        els.clockDisplay.textContent =
          observatory.clock?.localTimeHm || companion.currentTime || "--:--";
      }
      if (els.dateDisplay) {
        els.dateDisplay.textContent =
          observatory.clock?.todayStr || companion.currentDate || "----";
      }

      renderHandover(companion.handover);
      if (options.renderMessages) {
        renderMessageList(companion.messages);
      }

      renderProfileCard(observatory.profile);
      renderHormones(observatory.hormoneState);
    } catch (err) {
      appendEventLog(
        "ERROR",
        `拉取状态失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  /**
   * 预加载内置 5 套性格原型
   */
  async function loadArchetypePresets() {
    try {
      const data = await apiRequest("/api/observatory/archetypes");
      cachedPresets = data.presets || null;
      if (data.current) {
        renderProfileCard(data.current);
      }
    } catch (err) {
      appendEventLog(
        "ERROR",
        `加载性格原型失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  }

  /**
   * 发送聊天消息（环 1 实时交互环）
   */
  async function sendChatMessage(rawText) {
    const message = String(rawText || "").trim();
    if (!message) return;

    if (els.chatInput) els.chatInput.disabled = true;
    if (els.sendBtn) els.sendBtn.disabled = true;

    const optimisticTimestamp = new Date().toISOString();
    appendChatMessage({
      role: "user",
      speaker: "user",
      content: message,
      timestamp: optimisticTimestamp,
    });

    try {
      const resp = await apiRequest("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message }),
      });

      appendChatMessage(
        {
          role: "assistant",
          speaker: currentProfile?.name || "林栖",
          content: resp.reply,
          timestamp: resp.currentTime || new Date().toISOString(),
        },
        resp.journalEntry,
      );

      if (els.clockDisplay && resp.currentTime) {
        els.clockDisplay.textContent = resp.currentTime;
      }
      if (els.dateDisplay && resp.currentDate) {
        els.dateDisplay.textContent = resp.currentDate;
      }

      renderHandover(resp.handover);
      await refreshAllState({ renderMessages: false });
    } catch (err) {
      appendEventLog(
        "CHAT",
        `发送对话失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      if (els.chatInput) {
        els.chatInput.disabled = false;
        els.chatInput.value = "";
        els.chatInput.focus();
      }
      if (els.sendBtn) els.sendBtn.disabled = false;
    }
  }

  /**
   * 切换性格原型
   */
  async function applySelectedArchetype() {
    const selectedArchetype = els.archetypeSelect?.value || "cat_aloof";
    const resetHormonesToBaseline = Boolean(els.resetHormonesCheck?.checked);
    const defaultName =
      ARCHETYPE_DEFAULT_NAMES[selectedArchetype] ||
      currentProfile?.name ||
      "林栖";

    if (els.applyArchetypeBtn) els.applyArchetypeBtn.disabled = true;
    try {
      const res = await apiRequest("/api/observatory/persona", {
        method: "POST",
        body: JSON.stringify({
          persona: {
            name: defaultName,
            archetype: selectedArchetype,
            chronotype: currentProfile?.chronotype || "regular",
          },
          resetHormonesToBaseline,
        }),
      });

      if (res.profile) {
        renderProfileCard(res.profile);
      }
      appendEventLog(
        "PERSONA",
        `已切换住户为「${defaultName}」(${selectedArchetype})，重置基线=${resetHormonesToBaseline}`,
        "info",
      );
      await refreshAllState({ renderMessages: false });
    } catch (err) {
      appendEventLog(
        "PERSONA",
        `切换性格原型失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      if (els.applyArchetypeBtn) els.applyArchetypeBtn.disabled = false;
    }
  }

  /**
   * 触发单步自主心跳（环 2）
   */
  async function triggerHeartbeat() {
    if (els.btnHeartbeat) els.btnHeartbeat.disabled = true;
    try {
      const hb = await apiRequest("/api/heartbeat", {
        method: "POST",
        body: JSON.stringify({}),
      });

      const branchDesc =
        hb.branch === "proactive"
          ? `分支 A [主动破冰] (${hb.proactiveTrigger || "trigger"}): "${hb.proactiveMessage || ""}"`
          : hb.branch === "solitary"
            ? `分支 B [独居行动] (${hb.solitaryResult?.actionKind || "solitary"}): "${hb.solitaryResult?.journalEntry || ""}"`
            : hb.branch === "sleep_cycle"
              ? `触发入夜闸门 -> 自动执行【环 3 睡眠代谢】(${hb.sleepCycleOutput?.dateStr || ""})`
              : "分支 C [静默呼吸] (零 LLM 消耗)";

      appendEventLog("HEARTBEAT", branchDesc, "heartbeat");
      await refreshAllState({ renderMessages: hb.branch === "proactive" });
    } catch (err) {
      appendEventLog(
        "HEARTBEAT",
        `心跳执行失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      if (els.btnHeartbeat) els.btnHeartbeat.disabled = false;
    }
  }

  /**
   * 触发时间快进仿真
   */
  async function triggerFastForward(duration) {
    if (!duration) return;
    const ffBtns = document.querySelectorAll("button[data-ff]");
    ffBtns.forEach((b) => {
      b.disabled = true;
    });

    try {
      appendEventLog("FAST-FORWARD", `开始快进仿真 +${duration} ...`, "info");
      const report = await apiRequest("/api/fast-forward", {
        method: "POST",
        body: JSON.stringify({
          duration,
          disableGitCommit: true,
        }),
      });

      const counts = report.branchCounts || {};
      appendEventLog(
        "FAST-FORWARD",
        `快进 +${report.durationSpec} 完成（跨 ${report.daysCrossed} 天）：破冰=${counts.proactive ?? 0}，独居=${counts.solitary ?? 0}，睡眠=${counts.sleep_cycle ?? 0}，静默=${counts.idle ?? 0}`,
        "heartbeat",
      );
      await refreshAllState({ renderMessages: true });
    } catch (err) {
      appendEventLog(
        "FAST-FORWARD",
        `快进失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      ffBtns.forEach((b) => {
        b.disabled = false;
      });
    }
  }

  /**
   * 手动触发夜间睡眠结转（环 3）
   */
  async function triggerSleepCycle() {
    if (els.btnSleep) els.btnSleep.disabled = true;
    try {
      const out = await apiRequest("/api/sleep", {
        method: "POST",
      });
      const settledCount = Array.isArray(out.verdict?.items)
        ? out.verdict.items.length
        : 0;
      const archivedCount = Array.isArray(out.decayReport?.archivedIds)
        ? out.decayReport.archivedIds.length
        : 0;
      appendEventLog(
        "SLEEP",
        `夜间冷闭环完成 (${out.dateStr})：肝脏结算牵挂=${settledCount} 项，沉底归档=${archivedCount} 项，Linter=${out.lintReport?.passed ? "PASS" : "FAIL"}`,
        "sleep",
      );
      await refreshAllState({ renderMessages: false });
    } catch (err) {
      appendEventLog(
        "SLEEP",
        `夜间睡眠结转失败: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    } finally {
      if (els.btnSleep) els.btnSleep.disabled = false;
    }
  }

  /**
   * 建立 SSE 实时事件流订阅
   */
  function connectSseStream() {
    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource("/api/events");

    eventSource.addEventListener("open", () => {
      if (els.sseStatus) {
        els.sseStatus.classList.add("connected");
        els.sseStatus.classList.remove("error");
      }
    });

    eventSource.addEventListener("error", () => {
      if (els.sseStatus) {
        els.sseStatus.classList.remove("connected");
        els.sseStatus.classList.add("error");
      }
    });

    eventSource.addEventListener("connected", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        if (els.sseStatus) {
          els.sseStatus.classList.add("connected");
          els.sseStatus.classList.remove("error");
        }
        appendEventLog(
          "SSE",
          `已连接实时事件流（住户：${payload.data?.personaName || "林栖"}，时间：${payload.data?.currentDate || ""} ${payload.data?.currentTime || ""}）`,
          "info",
        );
      } catch {
        // ignore parse error
      }
    });

    eventSource.addEventListener("chat_turn", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const replyPreview = String(payload.data?.reply || "").slice(0, 36);
        appendEventLog(
          "SSE:CHAT",
          `对话回合完成 -> "${replyPreview}${replyPreview.length >= 36 ? "…" : ""}"`,
          "chat",
        );
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("proactive_message", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const d = payload.data || {};
        appendEventLog(
          "SSE:PROACTIVE",
          `[${d.trigger || "proactive"}] ${d.speaker || "住户"}主动破冰: "${d.content || ""}"`,
          "proactive",
        );
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("heartbeat", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const d = payload.data || {};
        if (d.hormoneState) {
          renderHormones(d.hormoneState);
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("fast_forward", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const d = payload.data || {};
        if (d.finalHormoneState) {
          renderHormones(d.finalHormoneState);
        }
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("sleep_cycle", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const d = payload.data || {};
        appendEventLog(
          "SSE:SLEEP",
          `睡前自省冷叙事落盘 (${d.dateStr || ""}): "${String(d.coldReflection || "").slice(0, 42)}…"`,
          "sleep",
        );
      } catch {
        // ignore
      }
    });

    eventSource.addEventListener("persona_updated", (ev) => {
      try {
        const payload = JSON.parse(ev.data);
        const d = payload.data || {};
        appendEventLog(
          "SSE:PERSONA",
          `人设已更新 -> ${d.name || ""} (${d.dominant_archetype || ""})`,
          "info",
        );
      } catch {
        // ignore
      }
    });
  }

  /**
   * 绑定全部页面交互事件
   */
  function bindEvents() {
    // 1. 聊天表单提交
    if (els.chatForm) {
      els.chatForm.addEventListener("submit", (e) => {
        e.preventDefault();
        const text = els.chatInput ? els.chatInput.value : "";
        sendChatMessage(text);
      });
    }

    // 2. 快速测试话术按钮
    const quickChips = document.querySelectorAll(".btn-chip[data-msg]");
    quickChips.forEach((chip) => {
      chip.addEventListener("click", () => {
        const msg = chip.getAttribute("data-msg");
        if (msg) {
          if (els.chatInput) els.chatInput.value = msg;
          sendChatMessage(msg);
        }
      });
    });

    // 3. 手动刷新按钮
    if (els.refreshStateBtn) {
      els.refreshStateBtn.addEventListener("click", () => {
        refreshAllState({ renderMessages: true });
        appendEventLog("SYSTEM", "已手动同步最新陪伴与观测台状态", "info");
      });
    }

    // 4. 性格原型下拉框预览与“应用原型”按钮
    if (els.archetypeSelect) {
      els.archetypeSelect.addEventListener("change", () => {
        const key = els.archetypeSelect.value;
        if (cachedPresets && cachedPresets[key]) {
          const preset = cachedPresets[key];
          renderProfileCard({
            name: ARCHETYPE_DEFAULT_NAMES[key] || currentProfile?.name || "林栖",
            dominant_archetype: key,
            chronotype: currentProfile?.chronotype || "regular",
            baseline: preset.baseline,
            resting_floor: preset.resting_floor,
            sensitivity: preset.sensitivity,
            half_life_hours: preset.half_life_hours,
            fast_relief_ratio: preset.fast_relief_ratio,
            mood_action_slots: preset.mood_action_slots,
          });
        }
      });
    }

    if (els.applyArchetypeBtn) {
      els.applyArchetypeBtn.addEventListener("click", () => {
        applySelectedArchetype();
      });
    }

    // 5. 引擎触发器按钮（心跳 / 快进 / 睡眠）
    if (els.btnHeartbeat) {
      els.btnHeartbeat.addEventListener("click", () => {
        triggerHeartbeat();
      });
    }

    const ffButtons = document.querySelectorAll("button[data-ff]");
    ffButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const duration = btn.getAttribute("data-ff");
        if (duration) {
          triggerFastForward(duration);
        }
      });
    });

    if (els.btnSleep) {
      els.btnSleep.addEventListener("click", () => {
        triggerSleepCycle();
      });
    }

    // 6. 清空事件流日志
    if (els.clearEventsBtn && els.eventsLog) {
      els.clearEventsBtn.addEventListener("click", () => {
        els.eventsLog.innerHTML = "";
        appendEventLog("SYSTEM", "事件日志已清屏", "info");
      });
    }
  }

  // 启动入口
  document.addEventListener("DOMContentLoaded", async () => {
    bindEvents();
    connectSseStream();
    await loadArchetypePresets();
    await refreshAllState({ renderMessages: true });
  });
})();
