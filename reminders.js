// KOL 今日待办窗口：打开 Chrome 时自动弹出，集中显示待回复/待跟进/待办。
// 自带读取+渲染逻辑，与侧边栏一致，但独立运行。
const listEl = document.getElementById("todo-window-list");
const subEl = document.getElementById("todo-window-sub");

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

// 打开提醒对应的对话：
// 1) 有对话数字 ID（threadId）→ 直接深链跳转，最准；
// 2) 没有 → 切到 IG 标签页，让页面脚本按名字在左边列表里找到那行并点开（不依赖 IG 行是不是链接）。
function openConversation(it) {
  const deepUrl = it.threadId ? threadUrl(it.threadId) : "";
  try {
    chrome.tabs.query({ url: "*://*.instagram.com/*" }, (tabs) => {
      const tab = tabs && tabs.length ? tabs[0] : null;
      if (!tab) {
        // 没有开着的 IG 标签：开一个（有深链开深链，否则开收件箱）
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

function computeItems(threads, todos, summaries) {
  const items = [];
  const looksLikeId = (x) => /^\d{6,}$/.test(String(x || ""));
  Object.entries(threads || {}).forEach(([recKey, rec]) => {
    if (!rec || rec.muted) return;
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
        kind: "reply", key: recKey, threadId: rec.threadId, isGroup: rec.isGroup, title,
        avatar: rec.avatarUrl || "",
        summary,
        online: !!rec.isOnline,
        meta: `${unreadTag} ${elapsedStr}${rec.isOnline ? " · 🟢 在线" : ""}`,
        elapsedMs
      });
    }
  });
  // 待办：今天到点（含已过期）→🟠今天跟进；未来日期→📅以后
  (todos || []).forEach((t) => {
    if (!t || t.done || t.dismissed) return;
    const due = Date.parse(t.dueAt);
    if (!Number.isFinite(due)) return;
    if (due <= endOfToday()) {
      items.push({ kind: "today", todoId: t.id, threadId: t.threadId || "", title: t.text, summary: "", meta: `到点：${fmt(t.dueAt)}`, elapsedMs: Date.now() - due });
    } else {
      items.push({ kind: "future", todoId: t.id, threadId: t.threadId || "", title: t.text, summary: "", meta: fmt(t.dueAt), elapsedMs: due - Date.now() });
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
  t.textContent = (isTodo ? "📝 " : "") + (it.title || "");
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

async function render() {
  const store = await chrome.storage.local.get(["kolThreads", "kolTodos", "kolSummaries"]);
  const items = computeItems(store.kolThreads || {}, store.kolTodos || [], store.kolSummaries || {});
  listEl.replaceChildren();
  subEl.textContent = items.length ? `共 ${items.length} 项待处理` : "";
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "twl-empty";
    p.textContent = "🎉 都处理完了，没有待办。";
    listEl.appendChild(p);
    return;
  }
  const groups = [
    ["reply", "🔴 立即回复（含未读 + 已读不回）"],
    ["today", "🟠 今天跟进"],
    ["future", "📅 以后"]
  ];
  groups.forEach(([kind, name]) => {
    const sub = items.filter((i) => i.kind === kind);
    if (!sub.length) return;
    const h = document.createElement("div");
    h.className = "reminder-group-title";
    h.textContent = `${name} · ${sub.length}`;
    listEl.appendChild(h);
    sub.forEach((it) => listEl.appendChild(card(it)));
  });
}

document.getElementById("todo-window-refresh").addEventListener("click", render);
chrome.storage.onChanged.addListener((changes, area) => {
  // kolSummaries 也要听：离开对话生成的「真总结」常单独写入（不动 kolThreads），
  // 漏听会导致已打开的窗口不刷新、新中文总结迟迟不出现。
  if (area === "local" && (changes.kolThreads || changes.kolTodos || changes.kolSummaries)) render();
});
render();
