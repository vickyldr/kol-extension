const MENU_ID = "kol-analyze-selection";

function ignoreLastError() {
  void chrome.runtime.lastError;
}

function installContextMenu() {
  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) ignoreLastError();

    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: "用 KOL 助手分析这段消息",
        contexts: ["selection"]
      },
      ignoreLastError
    );
  });
}

async function openSidePanel(tabId) {
  if (!tabId) return;
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (error) {
    console.warn("KOL Assistant could not open the side panel:", error);
  }
}

chrome.runtime.onInstalled.addListener(installContextMenu);
chrome.runtime.onStartup.addListener(installContextMenu);

chrome.action.onClicked.addListener((tab) => {
  openSidePanel(tab?.id);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;

  try {
    await chrome.storage.session.set({
      pendingMessage: info.selectionText || "",
      pendingSource: tab.url || ""
    });
    await openSidePanel(tab.id);
  } catch (error) {
    console.warn("KOL Assistant context menu action failed:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "OPEN_KOL_ASSISTANT") return;

  chrome.storage.session
    .set({
      pendingMessage: message.text || "",
      pendingSource: message.source || ""
    })
    .then(() => openSidePanel(sender.tab?.id))
    .catch((error) => {
      console.warn("KOL Assistant message action failed:", error);
    });
});

// 网页内联翻译：由后台代发请求，绕过 HTTPS 页面对 HTTP 服务的混合内容拦截。
async function handleTranslate(text) {
  const { kolConfig } = await chrome.storage.local.get("kolConfig");
  const base = kolConfig?.apiBase || "http://106.54.206.174:3210";
  const token = kolConfig?.token || "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-KOL-Token"] = token;
  const response = await fetch(`${base}/api/translate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "翻译失败");
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "KOL_TRANSLATE") return;
  handleTranslate(message.text)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || "翻译失败" }));
  return true; // 保持消息通道开启以异步响应
});

// ====================== KOL 提醒引擎 ======================
// 全部基于本地记账本（chrome.storage.local），不碰 IG。
// 判断走 /api/judge（同翻译那台服务器），只发对话文本。

async function handleJudge(payload) {
  const { kolConfig } = await chrome.storage.local.get("kolConfig");
  const base = kolConfig?.apiBase || "http://106.54.206.174:3210";
  const token = kolConfig?.token || "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-KOL-Token"] = token;
  const response = await fetch(`${base}/api/judge`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "判断失败");
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "KOL_JUDGE") return;
  handleJudge(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || "判断失败" }));
  return true;
});

// 代发 /api/parse-todo：把一句话解析成事项+时间（供会话内"已约好"用）
async function handleParseTodo(payload) {
  const { kolConfig } = await chrome.storage.local.get("kolConfig");
  const base = kolConfig?.apiBase || "http://106.54.206.174:3210";
  const token = kolConfig?.token || "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-KOL-Token"] = token;
  const response = await fetch(`${base}/api/parse-todo`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "解析失败");
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "KOL_PARSE_TODO") return;
  handleParseTodo(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || "解析失败" }));
  return true;
});

// 代发 /api/summary：内容脚本在你离开对话时自动更新合作进展
async function handleSummary(payload) {
  const { kolConfig } = await chrome.storage.local.get("kolConfig");
  const base = kolConfig?.apiBase || "http://106.54.206.174:3210";
  const token = kolConfig?.token || "";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-KOL-Token"] = token;
  const response = await fetch(`${base}/api/summary`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(45000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "总结失败");
  return body;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "KOL_SUMMARY") return;
  handleSummary(message.payload)
    .then(sendResponse)
    .catch((error) => sendResponse({ error: error.message || "总结失败" }));
  return true;
});

const REMINDER_ALARM = "kol-reminder-tick";
function ensureAlarm() {
  chrome.alarms.create(REMINDER_ALARM, { periodInMinutes: 60 }); // 每小时查一次
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

// 打开 Chrome 时，若有待处理的红人，自动弹出"今日待办"窗口（解决"懒得开提醒面板"）
async function openTodoWindowIfPending() {
  try {
    const items = await computeReminders();
    if (items.length) openTodoWindow();
  } catch (e) {
    console.warn("待办窗口检查失败", e);
  }
}
function openTodoWindow() {
  chrome.windows.create(
    { url: chrome.runtime.getURL("reminders.html"), type: "popup", width: 460, height: 720 },
    ignoreLastError
  );
}
chrome.runtime.onStartup.addListener(openTodoWindowIfPending);

// 侧边栏/通知点"弹出待办窗口"
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "KOL_OPEN_TODO_WINDOW") openTodoWindow();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REMINDER_ALARM) refreshReminders();
});

function daysSince(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return (now - t) / 86400000;
}

// 把记账本 + 自定义待办，算成「当前该提醒的清单」
async function computeReminders() {
  const store = await chrome.storage.local.get(["kolThreads", "kolTodos"]);
  const threads = store.kolThreads || {};
  const todos = store.kolTodos || [];
  const now = Date.now();
  const items = [];

  Object.entries(threads).forEach(([recKey, rec]) => {
    if (!rec || rec.muted) return; // 静音的群不提醒
    const j = rec.judge || {};
    const title = rec.title || rec.creatorName || recKey;
    const sig = rec.judgeSignature || "";

    // 待回复：红人发了我没回，且不是寒暄收尾，且没被「忽略」
    if (rec.needsReplyRaw && j.is_pleasantry !== true && rec.replyDismissedSig !== sig) {
      const since = rec.firstUnrepliedAt || rec.lastSeenAt;
      items.push({
        key: "reply:" + recKey + ":" + sig,
        kind: "reply",
        threadId: rec.threadId,
        title,
        label: j.reminder_label || `${title} 等你回复`,
        waitingDays: Math.max(0, Math.floor(daysSince(since, now)))
      });
    }

    // 待跟进：我发了/口头答应了但红人没推进，过了阈值
    if (j.needs_follow_up && j.is_pleasantry !== true && rec.followDismissedSig !== sig) {
      const anchor = rec.judgedAt || rec.lastSeenAt;
      const elapsed = daysSince(anchor, now);
      const threshold = Number.isFinite(Number(j.follow_up_after_days))
        ? Number(j.follow_up_after_days)
        : 2;
      if (elapsed >= threshold) {
        items.push({
          key: "follow:" + recKey + ":" + sig,
          kind: "follow",
          threadId: rec.threadId,
          title,
          label: j.reminder_label || `${title}：${j.waiting_for || "该跟进了"}`,
          waitingDays: Math.max(0, Math.floor(elapsed))
        });
      }
    }
  });

  // 自定义待办：到点才提醒
  todos.forEach((t) => {
    if (!t || t.done || t.dismissed) return;
    const dueAt = Date.parse(t.dueAt);
    if (Number.isFinite(dueAt) && dueAt <= now) {
      items.push({
        key: "todo:" + t.id,
        kind: "todo",
        threadId: t.threadId || "",
        title: t.text || "待办",
        label: t.text || "待办提醒"
      });
    }
  });

  return items;
}

async function refreshReminders() {
  let items = [];
  try {
    items = await computeReminders();
  } catch (e) {
    console.warn("KOL 提醒计算失败", e);
    return;
  }

  // ① 工具栏图标红点数字
  chrome.action.setBadgeBackgroundColor({ color: "#e0245e" }, ignoreLastError);
  chrome.action.setBadgeText({ text: items.length ? String(items.length) : "" }, ignoreLastError);

  // ② 桌面弹窗：只对「新出现的」弹，避免每小时重复轰炸
  const { kolNotified } = await chrome.storage.local.get("kolNotified");
  const already = new Set(kolNotified || []);
  const fresh = items.filter((i) => !already.has(i.key));
  if (fresh.length) {
    const head = fresh[0];
    const more = fresh.length > 1 ? `\n…等共 ${fresh.length} 条待处理` : "";
    chrome.notifications.create(
      "kol-" + Date.now(),
      {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon128.png"),
        title: "KOL 待办提醒",
        message: (head.label || head.title) + more,
        priority: 1
      },
      ignoreLastError
    );
  }
  await chrome.storage.local.set({ kolNotified: items.map((i) => i.key) });
}

// 记账本/待办一变，立刻刷新角标（搭便车采集后即时反映）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.kolThreads || changes.kolTodos)) {
    refreshReminders();
  }
});

// 点桌面通知 → 弹出"今日待办"窗口
chrome.notifications.onClicked.addListener(() => {
  openTodoWindow();
});

ensureAlarm();
refreshReminders();
