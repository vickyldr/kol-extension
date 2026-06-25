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

function openConversationTab(url) {
  try {
    chrome.tabs.query({ url: "*://*.instagram.com/*" }, (tabs) => {
      if (tabs && tabs.length) {
        chrome.tabs.update(tabs[0].id, { url, active: true });
        if (tabs[0].windowId != null) chrome.windows.update(tabs[0].windowId, { focused: true });
      } else {
        chrome.tabs.create({ url });
      }
    });
  } catch (e) {
    chrome.tabs.create({ url });
  }
}

function computeItems(threads, todos) {
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
    if (rec.needsReplyRaw && j.is_pleasantry !== true && rec.replyDismissedSig !== sig) {
      items.push({
        kind: "reply", key: recKey, threadId: rec.threadId, isGroup: rec.isGroup, title,
        label: rec.needsReplyReason || j.reminder_label || "等你回复",
        ai: j.ai_note || "",
        meta: `已搁置约 ${daysSince(rec.firstUnrepliedAt || rec.lastSeenAt)} 天`
      });
    }
    if (j.needs_follow_up && j.is_pleasantry !== true && rec.followDismissedSig !== sig) {
      const threshold = Number.isFinite(Number(j.follow_up_after_days)) ? Number(j.follow_up_after_days) : 2;
      const elapsed = daysSince(rec.judgedAt || rec.lastSeenAt);
      if (elapsed >= threshold) {
        items.push({
          kind: "follow", key: recKey, threadId: rec.threadId, isGroup: rec.isGroup, title,
          label: j.reminder_label || `该跟进：${j.waiting_for || ""}`,
          ai: j.ai_note || "",
          meta: `在等：${j.waiting_for || "—"} · 已 ${elapsed} 天`
        });
      }
    }
  });
  (todos || []).forEach((t) => {
    if (!t || t.done || t.dismissed) return;
    const due = Date.parse(t.dueAt);
    if (Number.isFinite(due) && due <= Date.now()) {
      items.push({ kind: "todo", todoId: t.id, threadId: t.threadId || "", title: t.text, label: "", meta: `到点：${fmt(t.dueAt)}` });
    }
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
  const t = document.createElement("div");
  t.className = "rc-title";
  t.textContent = (it.kind === "todo" ? "📝 " : "") + (it.title || "");
  el.appendChild(t);
  if (it.label) {
    const l = document.createElement("div");
    l.className = "rc-label";
    l.textContent = it.label;
    el.appendChild(l);
  }
  if (it.ai) {
    const a = document.createElement("div");
    a.className = "rc-ai";
    a.textContent = "🤖 " + it.ai;
    el.appendChild(a);
  }
  const m = document.createElement("div");
  m.className = "rc-meta";
  m.textContent = it.meta || "";
  el.appendChild(m);

  const actions = document.createElement("div");
  actions.className = "rc-actions";
  if (it.kind !== "todo") {
    const url = it.threadId ? threadUrl(it.threadId) : "https://www.instagram.com/direct/inbox/";
    actions.appendChild(btn("打开对话", () => openConversationTab(url)));
  }
  if (it.kind === "reply") {
    actions.appendChild(btn("不用提醒了", async () => { await dismissThread(it.key, "reply"); render(); }));
  } else if (it.kind === "follow") {
    actions.appendChild(btn("不用提醒了", async () => { await dismissThread(it.key, "follow"); render(); }));
  } else if (it.kind === "todo") {
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
  const store = await chrome.storage.local.get(["kolThreads", "kolTodos"]);
  const items = computeItems(store.kolThreads || {}, store.kolTodos || []);
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
    ["reply", "📥 待回复（红人发了我没回）"],
    ["follow", "⏳ 待跟进（口头答应没推进 / 该催）"],
    ["todo", "📝 待办"]
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
  if (area === "local" && (changes.kolThreads || changes.kolTodos)) render();
});
render();
