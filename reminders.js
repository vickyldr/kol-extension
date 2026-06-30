// KOL 今日待办窗口：打开 Chrome 时自动弹出，集中显示待回复/待跟进/待办。
// 自带读取+渲染逻辑，与侧边栏一致，但独立运行。
const listEl = document.getElementById("todo-window-list");
const subEl = document.getElementById("todo-window-sub");
const filtersEl = document.getElementById("todo-window-filters");
const digestEl = document.getElementById("todo-window-digest");

function daysSince(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}
function fmt(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "—";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function threadUrl(id) { return `https://www.instagram.com/direct/t/${id}/`; }

// 多账号：thread 记了 account(我方号) 时，挑「正登录该号」的 IG 标签开对话。
// 否则深链开到另一个账号的标签上，IG 找不到这条对话 → 显示空白收件箱（用户报的"打不开"）。
function pickTabByAccount(tabs, account) {
  return new Promise((resolve) => {
    const want = String(account || "").replace(/^@/, "").toLowerCase();
    if (!want || tabs.length <= 1) { resolve(tabs[0] || null); return; }
    let pending = tabs.length, matched = null;
    tabs.forEach((t) => {
      chrome.tabs.sendMessage(t.id, { type: "KOL_GET_MY_HANDLE" }, (resp) => {
        const h = (!chrome.runtime.lastError && resp && resp.handle) || ""; // 没注入内容脚本的标签会有 lastError，忽略
        if (h && h === want && !matched) matched = t;
        pending -= 1;
        if (pending === 0) resolve(matched || tabs[0] || null);
      });
    });
  });
}

// 打开提醒对应的对话：
// 1) 有对话数字 ID（threadId）→ 直接深链跳转，最准；
// 2) 没有 → 切到 IG 标签页，让页面脚本按名字在左边列表里找到那行并点开（不依赖 IG 行是不是链接）。
// 多账号时先按 it.account 挑对应账号的标签，避免深链开到别的号上一片空白。
function openConversation(it) {
  const deepUrl = it.threadId ? threadUrl(it.threadId) : "";
  try {
    chrome.tabs.query({ url: "*://*.instagram.com/*" }, async (tabs) => {
      tabs = tabs || [];
      if (!tabs.length) {
        // 没有开着的 IG 标签：开一个（有深链开深链，否则开收件箱）
        chrome.tabs.create({ url: deepUrl || "https://www.instagram.com/direct/inbox/" });
        return;
      }
      const tab = await pickTabByAccount(tabs, it.account);
      if (!tab) {
        chrome.tabs.create({ url: deepUrl || "https://www.instagram.com/direct/inbox/" });
        return;
      }
      const focusTab = () => {
        chrome.tabs.update(tab.id, { active: true });
        if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
      };
      if (deepUrl) {
        chrome.tabs.update(tab.id, { url: deepUrl, active: true });
        if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
        return;
      }
      // 无深链：先确保在收件箱页，再让内容脚本按名字点开
      focusTab();
      const tryClick = () => {
        chrome.tabs.sendMessage(tab.id, { type: "KOL_OPEN_THREAD_BY_NAME", key: it.key }, (resp) => {
          // 内容脚本没加载/没找到：退回收件箱首页，至少能手动找
          if (chrome.runtime.lastError || !resp || !resp.ok) {
            chrome.tabs.update(tab.id, { url: "https://www.instagram.com/direct/inbox/", active: true });
          } else if (resp.tid) {
            learnThreadId(it.key, resp.tid); // 学到对话数字 ID → 存上，下次深链直达
          }
        });
      };
      // 当前不在私信页就先跳收件箱，等列表加载出来再点
      const onInbox = /\/direct\//.test(tab.url || "");
      if (onInbox) {
        tryClick();
      } else {
        chrome.tabs.update(tab.id, { url: "https://www.instagram.com/direct/inbox/", active: true }, () => {
          setTimeout(tryClick, 1800);
        });
      }
    });
  } catch (e) {
    chrome.tabs.create({ url: deepUrl || "https://www.instagram.com/direct/inbox/" });
  }
}

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// 调后端生成「跟进话术」（读 kolConfig 拿地址/口令）。话术只生成，发不发同学自己定。
async function genFollowupText(item) {
  const cfg = (await chrome.storage.local.get("kolConfig")).kolConfig || {};
  const base = (cfg.apiBase || "").replace(/\/+$/, "");
  if (!base) throw new Error("没填服务器地址");
  const headers = { "Content-Type": "application/json" };
  if (cfg.token) headers["X-KOL-Token"] = cfg.token;
  const resp = await fetch(`${base}/api/followup`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      level: item.level,
      message: item.lastMsgPreview || "",
      context: item.summary || ""
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!resp.ok) throw new Error("生成失败（" + resp.status + "）");
  return resp.json();
}

function computeItems(threads, todos, summaries) {
  const items = [];
  const looksLikeId = (x) => /^\d{6,}$/.test(String(x || ""));
  Object.entries(threads || {}).forEach(([recKey, rec]) => {
   try {
    if (!rec || typeof rec !== "object" || rec.muted) return;
    const j = rec.judge || {};
    let title = rec.title || rec.creatorName || recKey || "";
    if (looksLikeId(title)) title = "";
    if (!title) title = (rec.inboxPreview || rec.lastMsgPreview || "").slice(0, 24);
    if (!title) title = "未命名对话";
    const sig = rec.judgeSignature || "";
    // 一行总结（中文，给看不懂外语的运营）：
    //   ① 点进去过 → kolSummaries 的真总结（离开对话时按 12 步流程生成，最完整）；
    //   ② 没点进去过的待回复 → autoSummary（AI 把红人最新预览归纳成一句中文）；
    //   ③ 都没有 → 留空，不显示那行（绝不贴外语原文、不放占位）。
    const sumRec = (summaries && (summaries[recKey] || (rec.threadId && summaries[rec.threadId]))) || null;
    const summary =
      (sumRec ? (sumRec.text || "").trim() : "") ||
      (rec.autoSummary || "").trim() ||
      "";

    // 🔴 立即回复：needsReplyRaw 天然含「未读 + 已读不回」
    if (rec.needsReplyRaw && j.is_pleasantry !== true && rec.replyDismissedSig !== sig) {
      const since = rec.lastCreatorMessageAt || rec.firstUnrepliedAt || rec.lastSeenAt;
      const elapsedMs = Date.now() - (Date.parse(since) || Date.now());
      const elapsedMin = Math.floor(elapsedMs / 60000);
      const unreadTag = rec.unread ? "未读" : "已读未回";
      const elapsedStr = elapsedMin < 60 ? `${elapsedMin} 分钟` : `${daysSince(since)} 天`;
      items.push({
        kind: "reply", key: recKey, threadId: rec.threadId, account: rec.account || "", isGroup: rec.isGroup, title,
        avatar: rec.avatarUrl || "",
        summary,
        online: !!rec.isOnline,
        unread: !!rec.unread, // 未读 vs 已读不回，用于优先级分组
        meta: `${unreadTag} ${elapsedStr}${rec.isOnline ? " · 🟢 在线" : ""}`,
        elapsedMs
      });
    }

    // 📤 该催对方：我方已发、红人不回 → 逐级升级跟进（满 1 天提醒下一级）。
    // 升级只在「同学真发了上一级」后推进（followUpLevel 由采集层数我方主动跟进次数）。
    if (!rec.needsReplyRaw && rec.lastFollowUpAt && j.is_pleasantry !== true) {
      const days = daysSince(rec.lastFollowUpAt);
      const lvl = Math.min((rec.followUpLevel || 0) + 1, 4);
      if (days >= 1 && rec.followDismissedLevel !== lvl) {
        const LABELS = { 1: "二次跟进", 2: "再跟进", 3: "最后通牒", 4: "建议终止" };
        items.push({
          kind: "followup", level: lvl, levelLabel: LABELS[lvl],
          key: recKey, threadId: rec.threadId, account: rec.account || "", isGroup: rec.isGroup, title,
          avatar: rec.avatarUrl || "", summary, online: !!rec.isOnline,
          lastMsgPreview: rec.lastMsgPreview || "", // 红人最后一句，给 AI 认语言
          meta: `已等 ${days} 天没回 · 该${LABELS[lvl]}`,
          elapsedMs: Date.now() - (Date.parse(rec.lastFollowUpAt) || Date.now())
        });
      }
    }
   } catch (e) { /* 单条记录坏了就跳过它，绝不让整个清单白屏（之前一条异常→render 静默失败→全空） */ }
  });
  // 待办关联红人时，按 threadId 反查它属于哪个登录号（多账号开对话用）+ 红人在不在线（优先级分组用）
  const acctByThreadId = {}, onlineByThreadId = {};
  Object.values(threads || {}).forEach((rec) => {
    if (rec && rec.threadId) {
      if (rec.account) acctByThreadId[rec.threadId] = rec.account;
      if (rec.isOnline) onlineByThreadId[rec.threadId] = true;
    }
  });
  // 待办：今天到点（含已过期）→🟠今天跟进；未来日期→📅以后
  (todos || []).forEach((t) => {
    if (!t || t.done || t.dismissed) return;
    const due = Date.parse(t.dueAt);
    if (!Number.isFinite(due)) return;
    const account = t.threadId ? (acctByThreadId[t.threadId] || "") : "";
    const online = t.threadId ? !!onlineByThreadId[t.threadId] : false;
    if (due <= endOfToday()) {
      items.push({ kind: "today", todoId: t.id, threadId: t.threadId || "", account, online, title: t.text, summary: "", meta: `到点：${fmt(t.dueAt)}`, elapsedMs: Date.now() - due });
    } else {
      items.push({ kind: "future", todoId: t.id, threadId: t.threadId || "", account, online, title: t.text, summary: "", meta: fmt(t.dueAt), elapsedMs: due - Date.now() });
    }
  });
  // 🔴 在线优先、再按等最久降序；待办按到点先后
  items.sort((a, b) => {
    if (a.kind === "reply" && b.kind === "reply") {
      const ao = a.online ? 1 : 0, bo = b.online ? 1 : 0;
      if (bo !== ao) return bo - ao;
      return (b.elapsedMs || 0) - (a.elapsedMs || 0);
    }
    return (b.elapsedMs || 0) - (a.elapsedMs || 0);
  });
  return items;
}

async function patchThread(id, patch) {
  const store = await chrome.storage.local.get("kolThreads");
  const map = store.kolThreads || {};
  if (map[id]) { map[id] = { ...map[id], ...patch }; await chrome.storage.local.set({ kolThreads: map }); }
}
// 按名字点开成功后，把抓回来的对话数字 ID 存上（原来没有才补），下次「打开对话」就深链直达。
async function learnThreadId(key, tid) {
  try {
    const store = await chrome.storage.local.get("kolThreads");
    const map = store.kolThreads || {};
    if (map[key] && !map[key].threadId && tid) {
      map[key].threadId = tid;
      await chrome.storage.local.set({ kolThreads: map });
    }
  } catch (_) {}
}
async function dismissThread(id, kind) {
  const store = await chrome.storage.local.get("kolThreads");
  const map = store.kolThreads || {};
  if (map[id]) {
    map[id][kind === "reply" ? "replyDismissedSig" : "followDismissedSig"] = map[id].judgeSignature || "";
    await chrome.storage.local.set({ kolThreads: map });
  }
}
async function patchTodo(id, patch) {
  const store = await chrome.storage.local.get("kolTodos");
  const todos = (store.kolTodos || []).map((t) => (t.id === id ? { ...t, ...patch } : t));
  await chrome.storage.local.set({ kolTodos: todos });
}

function btn(label, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function card(it) {
  const el = document.createElement("div");
  el.className = `reminder-card ${it.kind}`;
  // 标题行：真实头像（红人/群聊）+ 名字
  const head = document.createElement("div");
  head.className = "rc-head";
  if (it.avatar) {
    const av = document.createElement("img");
    av.className = "rc-avatar";
    av.src = it.avatar;
    av.referrerPolicy = "no-referrer"; // IG 头像 CDN 需要无 referrer 才能加载
    av.onerror = () => av.remove();    // 链接失效就移除，不显示破图
    head.appendChild(av);
  }
  const isTodo = it.kind === "today" || it.kind === "future";
  const t = document.createElement("div");
  t.className = "rc-title";
  t.textContent = (isTodo ? "📝 " : it.kind === "followup" ? "📤 " : "") + (it.title || "");
  head.appendChild(t);
  el.appendChild(head);
  // 一行总结（每条必有）：红人说到哪了 + 该干嘛。待办没有总结。
  if (it.summary) {
    const s = document.createElement("div");
    s.className = "rc-summary-line";
    s.textContent = it.summary;
    el.appendChild(s);
  }
  const m = document.createElement("div");
  m.className = "rc-meta";
  m.textContent = it.meta || "";
  el.appendChild(m);

  const actions = document.createElement("div");
  actions.className = "rc-actions";
  if (!isTodo) {
    actions.appendChild(btn("打开对话", () => openConversation(it)));
  } else if (it.threadId) {
    actions.appendChild(btn("打开对话", () => openConversation(it)));
  }
  if (it.kind === "reply") {
    actions.appendChild(btn("不用提醒了", async () => { await dismissThread(it.key, "reply"); render(); }));
  } else if (it.kind === "followup") {
    if (it.level < 4) {
      actions.appendChild(btn(`✍️ 生成${it.levelLabel}话术`, async (e) => {
        const b = e.currentTarget; b.textContent = "生成中…"; b.disabled = true;
        try {
          const r = await genFollowupText(it);
          el.querySelector(".rc-followup-draft")?.remove();
          const box = document.createElement("div");
          box.className = "rc-followup-draft";
          const tgt = document.createElement("div"); tgt.className = "fd-target";
          tgt.textContent = r.reply_target || "（没生成出来，重试一下）";
          const cn = document.createElement("div"); cn.className = "fd-cn";
          cn.textContent = r.reply_chinese || "";
          box.appendChild(tgt); box.appendChild(cn);
          box.appendChild(btn("📋 复制话术", () => navigator.clipboard.writeText(r.reply_target || "")));
          el.appendChild(box);
          b.textContent = "重新生成";
        } catch (err) {
          b.textContent = "生成失败，点重试";
        } finally { b.disabled = false; }
      }));
    }
    actions.appendChild(btn("这级不用提醒", async () => { await patchThread(it.key, { followDismissedLevel: it.level }); render(); }));
  } else if (isTodo) {
    actions.appendChild(btn("完成", async () => { await patchTodo(it.todoId, { done: true }); render(); }));
    actions.appendChild(btn("删除", async () => { await patchTodo(it.todoId, { dismissed: true }); render(); }));
  }
  if (it.isGroup && it.key) {
    actions.appendChild(btn("🔕 这个群别再提醒", async () => { await patchThread(it.key, { muted: true }); render(); }));
  }
  el.appendChild(actions);
  return el;
}

// 四象限（艾森豪威尔）：紧急 = 红人此刻在线 或 今天到期；重要 = 久等/隔夜没回 或 该催 或 今天该做。
// 用 tab 左右切，默认开「🔥马上做」，每个 tab 只看一类——不再一股脑竖排堆。
const QUADRANTS = [
  ["now", "🔥 马上做", "红人在线又久等 / 今天到期 — 立刻处理"],
  ["quick", "⚡ 顺手回", "红人在线但只是刚来 — 趁在线顺手回"],
  ["plan", "⭐ 尽快安排", "久等 / 隔夜没回 或 该催，但红人不在线 — 排时间做"],
  ["later", "🧊 有空清", "刚来的、不在线、不急 — 有空再清"]
];
const IMPORTANT_MS = 12 * 3600 * 1000; // 等待≥12小时(含隔夜) = 久等 = 重要
function isUrgent(it) { return !!it.online || it.kind === "today"; }      // 红人在线 或 今天到期
function isImportant(it) {
  if (it.kind === "followup" || it.kind === "today") return true;        // 该催 / 今天该做
  if (it.kind === "future") return false;                                // 以后
  return (it.elapsedMs || 0) >= IMPORTANT_MS;                            // 待回复：久等/隔夜=重要
}
function quadrant(it) {
  const u = isUrgent(it), im = isImportant(it);
  if (u && im) return "now";
  if (u && !im) return "quick";
  if (!u && im) return "plan";
  return "later";
}
let twlTab = "now"; // 当前 tab，默认「马上做」

async function render() {
 try {
  const store = await chrome.storage.local.get(["kolThreads", "kolTodos", "kolSummaries"]);
  const todos = store.kolTodos || [];
  const items = computeItems(store.kolThreads || {}, todos, store.kolSummaries || {});
  listEl.replaceChildren();
  // 今日待办进度（成就感）：今天到期(含过期)的待办，完成了几条 / 共几条
  const dueToday = todos.filter((t) => { if (!t || t.dismissed) return false; const d = Date.parse(t.dueAt); return Number.isFinite(d) && d <= endOfToday(); });
  const doneN = dueToday.filter((t) => t.done).length, totalN = dueToday.length;
  subEl.textContent = items.length ? `共 ${items.length} 项待处理` : "";
  // 分到四象限
  const bucket = { now: [], quick: [], plan: [], later: [] };
  items.forEach((it) => { (bucket[quadrant(it)] || bucket.later).push(it); });
  Object.values(bucket).forEach((arr) => arr.sort((a, b) => (b.elapsedMs || 0) - (a.elapsedMs || 0)));
  // 置顶「今日概览」（晨间摘要常驻版）：问候 + 各档数量 + 待办进度条。每次刷新实时更新。
  if (digestEl) {
    const hr = new Date().getHours();
    const greet = hr < 11 ? "☀️ 早上好" : hr < 18 ? "👋 下午好" : "🌙 晚上好";
    const onlineN = items.filter((i) => i.online).length;
    if (!items.length) {
      digestEl.innerHTML = `<div class="dg1">${greet}　🎉 今天都处理完啦，休息一下</div>`;
    } else {
      const pct = totalN ? Math.round((doneN / totalN) * 100) : 0;
      digestEl.innerHTML =
        `<div class="dg1">${greet}　今天 <b>${items.length}</b> 项待处理</div>` +
        `<div class="dg2">` +
          `<span>🔥 马上做 <b>${bucket.now.length}</b></span>` +
          `<span>⭐ 隔夜该催 <b>${bucket.plan.length}</b></span>` +
          `<span>🟢 在线 <b>${onlineN}</b></span>` +
          (totalN ? `<span>✅ 待办 <b>${doneN}/${totalN}</b></span>` : "") +
        `</div>` +
        (totalN ? `<div class="twl-progress"><div class="twl-pbar"><div class="twl-pfill" style="width:${pct}%"></div></div><span class="twl-ptext">${doneN}/${totalN}</span></div>` : "");
    }
  }
  // tab 行（当前 tab 空了就跳到第一个有内容的）
  if (filtersEl) {
    if (!bucket[twlTab] || !bucket[twlTab].length) {
      const f = QUADRANTS.map(([k]) => k).find((k) => bucket[k] && bucket[k].length);
      if (f) twlTab = f;
    }
    filtersEl.replaceChildren();
    QUADRANTS.forEach(([k, label], i) => {
      const n = bucket[k].length;
      const c = document.createElement("button");
      c.type = "button";
      // tab-${k} 给每档配色(红→橙→蓝→灰，左到右优先级递减)；序号①②③④强化"先做哪个"。
      c.className = `twl-tab tab-${k}` + (twlTab === k ? " on" : "") + (n ? "" : " empty");
      c.innerHTML = `<b class="ord">${"①②③④"[i]}</b> ${label}<span class="n">${n}</span>`;
      c.addEventListener("click", () => { twlTab = k; render(); });
      filtersEl.appendChild(c);
    });
  }
  // 当前 tab 说明 + 内容
  const meta = QUADRANTS.find(([k]) => k === twlTab) || [];
  if (meta[2]) { const d = document.createElement("div"); d.className = "twl-tabdesc"; d.textContent = meta[2]; listEl.appendChild(d); }
  const sub = bucket[twlTab] || [];
  if (!sub.length) {
    const p = document.createElement("p");
    p.className = "twl-empty";
    p.textContent = items.length ? "这一类暂时没有，点上面别的 tab 看看 👆" : "🎉 都处理完了，没有待办。";
    listEl.appendChild(p);
  } else {
    sub.forEach((it) => { try { listEl.appendChild(card(it)); } catch (e) {} });
  }
 } catch (e) {
  // 兜底：万一渲染抛错，给个提示而不是整窗空白（之前 async render 抛错=静默失败=全空）。
  try {
    listEl.replaceChildren();
    const p = document.createElement("p");
    p.className = "twl-empty";
    p.textContent = "提醒清单加载出错，点右上角「刷新」重试。";
    listEl.appendChild(p);
  } catch (_) {}
 }
}

// 顶层接线各自包 try/catch：任何一处抛错都不能挡住 render()——之前若 addEventListener
// 命中 null 等，render() 就永远不会跑，整窗一片空白（连"🎉/出错提示"都不显示）。
try {
  const rb = document.getElementById("todo-window-refresh");
  if (rb) rb.addEventListener("click", () => render());
} catch (_) {}
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    // kolSummaries 也要听：离开对话生成的「真总结」常单独写入（不动 kolThreads），漏听则不刷新。
    if (area === "local" && (changes.kolThreads || changes.kolTodos || changes.kolSummaries)) render();
  });
} catch (_) {}
render();
// 兜底再跑一次：首帧 storage 偶尔还没就绪
setTimeout(() => { try { render(); } catch (_) {} }, 400);
