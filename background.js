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
  chrome.alarms.create(REMINDER_ALARM, { periodInMinutes: 1 }); // 每分钟查一次（已读不回5分钟阈值需要）
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
function minutesSince(iso, now) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return (now - t) / 60000;
}

// 把记账本 + 自定义待办，算成「当前该提醒的清单」
// 返回 items，每条附 recKey / markReplyReminderSent / markUnreadReminderSent 供 refreshReminders 回写。
// 提醒逻辑：
//   已读不回（打开了对话但没回）→ 5分钟后提醒一次；对方在线时跳过等待立即提醒。
//   未读（根本没点进去）→ 1小时后提醒一次。
//   以上都只提醒一次；红人发新消息会重置计时（重新等5分钟）。
async function computeReminders() {
  const store = await chrome.storage.local.get(["kolThreads", "kolTodos"]);
  const threads = store.kolThreads || {};
  const todos = store.kolTodos || [];
  const now = Date.now();
  const items = [];

  Object.entries(threads).forEach(([recKey, rec]) => {
    if (!rec || rec.muted) return;
    const j = rec.judge || {};
    const title = rec.title || rec.creatorName || recKey;
    const sig = rec.judgeSignature || "";

    if (rec.needsReplyRaw && j.is_pleasantry !== true && rec.replyDismissedSig !== sig) {
      if (!rec.unread) {
        // 已读不回：5分钟 or 对方在线立即提醒，且只提醒一次
        if (!rec.replyReminderSent) {
          const elapsed = minutesSince(rec.lastCreatorMessageAt || rec.firstUnrepliedAt || rec.lastSeenAt, now);
          if (elapsed >= 5 || rec.isOnline) {
            items.push({
              key: "reply:" + recKey,
              kind: "reply",
              recKey,
              threadId: rec.threadId,
              title,
              label: rec.isOnline
                ? `${title} 在线！快回复`
                : (j.reminder_label || `${title} 等你回复`),
              waitingDays: Math.max(0, Math.floor(daysSince(rec.lastCreatorMessageAt || rec.firstUnrepliedAt || rec.lastSeenAt, now))),
              elapsedMs: now - (Date.parse(rec.lastCreatorMessageAt || rec.firstUnrepliedAt || rec.lastSeenAt) || now),
              markReplyReminderSent: true
            });
          }
        }
      } else {
        // 未读：1小时后提醒一次
        if (!rec.unreadReminderSent) {
          const elapsed = minutesSince(rec.unreadSince || rec.firstUnrepliedAt || rec.lastSeenAt, now);
          if (elapsed >= 60) {
            items.push({
              key: "unread:" + recKey,
              kind: "reply",
              recKey,
              threadId: rec.threadId,
              title,
              label: `${title} 有未读消息（1小时了）`,
              waitingDays: Math.max(0, Math.floor(elapsed / 60 / 24)),
              elapsedMs: elapsed * 60000,
              markUnreadReminderSent: true
            });
          }
        }
      }
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
          recKey,
          threadId: rec.threadId,
          title,
          label: j.reminder_label || `${title}：${j.waiting_for || "该跟进了"}`,
          waitingDays: Math.max(0, Math.floor(elapsed)),
          elapsedMs: elapsed * 86400000
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
        label: t.text || "待办提醒",
        elapsedMs: now - dueAt
      });
    }
  });

  // 按等待时间降序（等最久的排最上面）
  items.sort((a, b) => (b.elapsedMs || 0) - (a.elapsedMs || 0));

  return items;
}

let _refreshing = false;
async function refreshReminders() {
  if (_refreshing) return;
  _refreshing = true;
  try {
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

    // ② 桌面弹窗：只对「新出现的」弹，避免每分钟重复轰炸
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
          priority: 2,
          requireInteraction: true
        },
        ignoreLastError
      );

      // ③ 回写「已提醒」标记，避免下一分钟重复触发同一条
      const threadsCopy = (await chrome.storage.local.get("kolThreads")).kolThreads || {};
      let changed = false;
      fresh.forEach((item) => {
        if (!item.recKey || !threadsCopy[item.recKey]) return;
        if (item.markReplyReminderSent) { threadsCopy[item.recKey].replyReminderSent = true; changed = true; }
        if (item.markUnreadReminderSent) { threadsCopy[item.recKey].unreadReminderSent = true; changed = true; }
      });
      if (changed) await chrome.storage.local.set({ kolThreads: threadsCopy });
    }

    await chrome.storage.local.set({ kolNotified: items.map((i) => i.key) });
  } finally {
    _refreshing = false;
  }
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
