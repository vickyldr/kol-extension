// KOL 提醒 · 采集脚本（搭便车读屏，绝不碰 IG 账号）
// 只在你自己打开的 Instagram 私信/群聊页面上，读已经渲染出来的对话，
// 记进本地记账本（chrome.storage.local）。不发任何 IG 请求、不替你点/滚/发。
(function () {
  if (!location.hostname.includes("instagram.com")) return;

  const THREADS_KEY = "kolThreads"; // 记账本：每个对话一条
  const SETTINGS_KEY = "kolReminderSettings"; // 身份设置：我的产品 / 产品清单 / 我的号
  const DEFAULT_PREFIXES = ["recco", "rythmix", "aicatch", "vivavideo"];

  let settings = {
    enabled: true,
    myProduct: "",
    myHandle: "",
    productPrefixes: DEFAULT_PREFIXES.slice()
  };

  chrome.storage.local.get(SETTINGS_KEY).then((s) => {
    if (s[SETTINGS_KEY]) settings = { ...settings, ...s[SETTINGS_KEY] };
    maybeAutodetectHandle();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SETTINGS_KEY]) {
      settings = { ...settings, ...(changes[SETTINGS_KEY].newValue || {}) };
    }
  });

  // 一次性清理：旧版按"数字对话ID"存的记账本，换成按名字存后，把旧数据清掉，
  // 避免残留那些 @一串数字 的脏提醒。清一次即可。
  chrome.storage.local.get("kolThreadsSchema").then((s) => {
    if (s.kolThreadsSchema !== 3) {
      chrome.storage.local.set({ kolThreads: {}, kolThreadsSchema: 3 });
    }
  });

  // —— 工具 —————————————————————————————————————————————

  function log(...args) {
    // 调试用，真机上按需打开
    // console.debug("[KOL提醒]", ...args);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function prefixes() {
    const list = Array.isArray(settings.productPrefixes)
      ? settings.productPrefixes
      : DEFAULT_PREFIXES;
    return list.map((p) => String(p || "").toLowerCase().trim()).filter(Boolean);
  }

  // 账号名是不是「我方同事」（以产品名开头）
  function isColleagueHandle(handle) {
    const h = String(handle || "").toLowerCase().replace(/^@/, "").trim();
    if (!h) return false;
    return prefixes().some((p) => h.startsWith(p));
  }

  function isMyHandle(handle) {
    const h = String(handle || "").toLowerCase().replace(/^@/, "").trim();
    const mine = String(settings.myHandle || "").toLowerCase().replace(/^@/, "").trim();
    return Boolean(mine) && h === mine;
  }

  // 记账本的 key：用名字的"归一化前缀"，让列表里的截断名("Rythmix + yai…")
  // 和对话顶部的完整名("Rythmix + yaitoeii 3100thb…")归到同一条。
  function titleKey(s) {
    return String(s || "")
      .replace(/[…\.]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[^\p{L}\p{N}]+/u, "") // 去掉开头的 emoji/符号（🎵 等），让前缀对齐
      .slice(0, 22)
      .trim()
      .toLowerCase();
  }

  // 蓝气泡 / 靠右 = 我自己发的（沿用翻译脚本的判断思路）
  function isBlueLike(color) {
    const m = String(color).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const [, r, g, b] = m.map(Number);
    return b > 145 && b > r * 1.18 && b > g * 1.08;
  }
  function isOutgoingBubble(element) {
    let cur = element;
    for (let depth = 0; cur && depth < 7; depth += 1) {
      const style = getComputedStyle(cur);
      if (
        isBlueLike(style.backgroundColor) ||
        style.justifyContent === "flex-end" ||
        style.alignSelf === "flex-end"
      ) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function currentThreadId() {
    const m = location.pathname.match(/\/direct\/t\/([^/]+)/);
    return m ? m[1] : null;
  }
  function inDirect() {
    return location.pathname.startsWith("/direct/");
  }

  // 登录后顺手认出「我自己的号」，自动判出我的产品（读不到就算了，可手填）
  function maybeAutodetectHandle() {
    if (settings.myHandle) return;
    try {
      // 个人头像/菜单里常带 href="/<myhandle>/"，或 IG 注入的全局变量
      const link = document.querySelector('a[href^="/"][role="link"] img[alt*="头像"], a[href^="/"] img[alt*="profile picture"]');
      let handle = "";
      if (link) {
        const a = link.closest('a[href^="/"]');
        const href = a && a.getAttribute("href");
        if (href) handle = href.replace(/\//g, "").trim();
      }
      if (handle && handle.length < 40) {
        const product = prefixes().find((p) => handle.toLowerCase().startsWith(p)) || "";
        const next = { ...settings, myHandle: handle };
        if (product && !settings.myProduct) next.myProduct = product;
        settings = next;
        chrome.storage.local.set({ [SETTINGS_KEY]: next });
        log("自动认出我的号:", handle, "产品:", product);
      }
    } catch (e) {
      /* 读不到就算了 */
    }
  }

  // —— 读「打开的对话」————————————————————————————————

  // 找到对话里每条消息气泡（带文字的最内层），按出现顺序返回 {from,name,text}
  function readOpenConversation(limit = 14) {
    const main = document.querySelector('div[role="main"], main');
    if (!main) return null;

    // 消息气泡：main 里的 [dir='auto'] 文本块（排除导航/按钮）
    const nodes = main.querySelectorAll("div[dir='auto'], span[dir='auto']");
    const seen = new Set();
    const messages = [];

    nodes.forEach((el) => {
      const text = (el.innerText || "").trim();
      if (!text || text.length > 1500) return;
      if (el.closest("nav, header, footer, [role='dialog'], textarea, [role='textbox']")) return;
      // 去掉父子重复（外层和内层文字一样时只取一次）
      const parentAuto = el.parentElement && el.parentElement.closest("[dir='auto']");
      if (parentAuto && parentAuto !== el && (parentAuto.innerText || "").trim() === text) return;
      if (seen.has(text + "@" + messages.length)) return;

      const mine = isOutgoingBubble(el);
      let from, name = "";
      if (mine) {
        from = "me";
      } else {
        name = senderNameFor(el);
        if (isMyHandle(name)) from = "me";
        else if (isColleagueHandle(name)) from = "colleague";
        else from = "creator";
      }
      messages.push({ from, name, text });
    });

    if (!messages.length) return null;

    // 群聊判断：出现过同事，或出现过 2 个以上不同的非我发送者名字
    const incomingNames = new Set(
      messages.filter((m) => m.from !== "me" && m.name).map((m) => m.name)
    );
    const hasColleague = messages.some((m) => m.from === "colleague");
    const isGroup = hasColleague || incomingNames.size > 1;

    // 红人名字：取被判成 creator 的、出现最多的那个名字；否则用对话标题
    const creatorName =
      mostCommon(messages.filter((m) => m.from === "creator").map((m) => m.name)) ||
      conversationTitle() ||
      "";

    return { messages: messages.slice(-limit), isGroup, creatorName };
  }

  // 滚动累积缓冲：你往上滚加载出更老的消息时，把它们累加进来，
  // 这样不用一次性看到全部、也不靠 IG 复制粘贴，就能攒齐整段历史。
  let convBuffer = { tid: "", messages: [] };
  function msgSig(m) { return m.from + "|" + m.text; }
  function mergeIntoBuffer(current) {
    if (!current || !current.length) return;
    if (!convBuffer.messages.length) { convBuffer.messages = current.slice(); return; }
    const bufSigs = convBuffer.messages.map(msgSig);
    const curSigs = current.map(msgSig);
    const firstOverlap = curSigs.findIndex((s) => bufSigs.includes(s));
    if (firstOverlap === -1) {
      // 完全不重叠（跳得太远）：去重后直接追加
      current.forEach((m) => { if (!bufSigs.includes(msgSig(m))) convBuffer.messages.push(m); });
      return;
    }
    // current 开头那段是 buffer 之前的更老消息 → 前插
    const olderPrefix = current.slice(0, firstOverlap).filter((m) => !bufSigs.includes(msgSig(m)));
    if (olderPrefix.length) convBuffer.messages = olderPrefix.concat(convBuffer.messages);
    // current 末尾若有 buffer 之后的更新消息 → 追加
    const lastBufSig = bufSigs[bufSigs.length - 1];
    const lastBufInCur = curSigs.lastIndexOf(lastBufSig);
    if (lastBufInCur !== -1 && lastBufInCur < curSigs.length - 1) {
      const have = new Set(convBuffer.messages.map(msgSig));
      const newerSuffix = current.slice(lastBufInCur + 1).filter((m) => !have.has(msgSig(m)));
      if (newerSuffix.length) convBuffer.messages = convBuffer.messages.concat(newerSuffix);
    }
    // 安全上限，防止极长对话占内存
    if (convBuffer.messages.length > 600) convBuffer.messages = convBuffer.messages.slice(-600);
  }

  // 群聊里每条消息上方通常有发送者名字；尽量往上找一个短文本当名字
  function senderNameFor(el) {
    let row = el;
    for (let i = 0; i < 6 && row; i += 1) {
      // 同一「消息行」里找带 username 的小标签
      const label = row.querySelector && row.querySelector("h5, h4, [role='heading']");
      if (label) {
        const t = (label.innerText || "").trim();
        if (t && t.length < 40) return t;
      }
      row = row.parentElement;
    }
    return "";
  }

  function conversationTitle() {
    // 对话顶部标题栏的名字：右侧对话区"最顶一条"短文字（约 y<68，避免抓到消息气泡）
    const cands = document.querySelectorAll("span, h1, h2");
    for (const el of cands) {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.top > 68) continue; // 只看最顶的标题栏
      if (r.left < 360) continue; // 在右侧对话区，不是左边列表
      if (el.childElementCount > 2) continue;
      const t = (el.innerText || "").trim().split("\n")[0].trim();
      if (
        t && t.length > 1 && t.length < 80 &&
        !/在线|online|active|新消息|new message|正在输入|typing/i.test(t)
      ) {
        return t;
      }
    }
    return "";
  }

  function mostCommon(arr) {
    const counts = new Map();
    arr.filter(Boolean).forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
    let best = "", n = 0;
    counts.forEach((v, k) => {
      if (v > n) { n = v; best = k; }
    });
    return best;
  }

  // —— 读「收件箱列表」———————————————————————————————
  // IG 这版列表行不是链接、没 role，拿不到对话 ID。改为：
  // 靠每行的头像找到"行"，用"对话名字"当 key（不再依赖数字 ID）。
  function scanInbox() {
    const rows = [];
    const seen = new Set();
    const imgs = document.querySelectorAll("img");
    imgs.forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.left > 460 || r.top < 60) return; // 只看左侧列表区
      if (r.width < 18 || r.width > 84) return; // 头像大小
      // 从头像往上找"行"：含时间/新消息/在线标记、且文字不太长的最近祖先
      let row = img.parentElement;
      for (let hops = 0; row && hops < 9; hops += 1) {
        const t = row.innerText || "";
        if (
          t && t.length < 240 &&
          /(分钟|小时|天前|周前|昨天|今天|刚刚|秒前|new message|新消息|在线|online|active)/i.test(t)
        ) break;
        row = row.parentElement;
      }
      if (!row) return;
      const text = (row.innerText || "").trim();
      if (!text) return;
      const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
      const title = (lines[0] || "").slice(0, 80);
      if (!title || title.length < 2) return;
      // 跳过明显不是对话行的（比如"你的便签/分享一件趣事"）
      if (/便签|分享一件|note$/i.test(title)) return;
      const key = titleKey(title);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const preview = lines.slice(1).join(" ").slice(0, 120);
      // 未读：只认真正的未读信号（"N new messages" / 蓝色未读圆点）。
      // 不再用字重(isBold)——IG 名字几乎都是粗体，会把所有行误判成未读。
      const unread =
        /(\d+\s*new message|new messages|条新消息|未读)/i.test(text) ||
        hasUnreadDot(row);
      // 最后一条是不是我发的：兼容"你: …""你发送了…""You: …""You sent…"
      const lastFromMe = /^\s*(you|您|你|me)\s*[:：]/i.test(preview) ||
        /^\s*你(发送了|已发送)/.test(preview) ||
        /^\s*you\s+sent/i.test(preview);
      // 用名字归一化前缀当 key（id 字段沿用，后续代码不必大改）
      rows.push({ id: key, title, preview, unread, lastFromMe });
    });
    return rows;
  }

  // 行内找一个蓝色的小圆点（IG 未读指示）
  function hasUnreadDot(container) {
    const els = container.querySelectorAll("div, span");
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.width < 16 && r.height > 0 && r.height < 16) {
        if (isBlueLike(getComputedStyle(el).backgroundColor)) return true;
      }
    }
    return false;
  }

  function isBold(container) {
    const el = container.querySelector("span, div");
    if (!el) return false;
    const w = getComputedStyle(el).fontWeight;
    return Number(w) >= 600 || w === "bold";
  }

  // —— 记账本读写 ——————————————————————————————————

  async function getThreads() {
    const s = await chrome.storage.local.get(THREADS_KEY);
    return s[THREADS_KEY] || {};
  }
  async function saveThreads(map) {
    await chrome.storage.local.set({ [THREADS_KEY]: map });
  }

  // 更新一条对话记录，并在需要时请求 AI 判断
  async function upsertThread(id, patch, recentForJudge) {
    if (!id) return;
    const map = await getThreads();
    const prev = map[id] || {};
    const rec = { ...prev, ...patch, threadId: id, lastSeenAt: nowIso() };

    // 「第一次发现没回」的锚点：从「不是待回复」变成「待回复」时盖戳
    if (patch.needsReplyRaw && !prev.needsReplyRaw) {
      rec.firstUnrepliedAt = nowIso();
    }
    if (!patch.needsReplyRaw) {
      rec.firstUnrepliedAt = null;
    }

    map[id] = rec;
    await saveThreads(map);

    // 最后一条变了才请求 AI 判断，省调用
    if (recentForJudge && recentForJudge.length) {
      const sig = recentForJudge.map((m) => m.from + ":" + m.text).join("|").slice(-400);
      if (rec.judgeSignature !== sig && !rec.muted) {
        requestJudge(id, {
          messages: recentForJudge,
          isGroup: rec.isGroup,
          creatorName: rec.creatorName,
          productId: settings.myProduct
        }, sig);
      }
    }
  }

  let judging = false;
  const judgeQueue = [];
  async function requestJudge(id, payload, sig) {
    judgeQueue.push({ id, payload, sig });
    if (judging) return;
    judging = true;
    while (judgeQueue.length) {
      const job = judgeQueue.shift();
      try {
        const res = await chrome.runtime.sendMessage({ type: "KOL_JUDGE", payload: job.payload });
        if (res && !res.error) {
          const map = await getThreads();
          if (map[job.id]) {
            map[job.id].judge = res;
            map[job.id].judgeSignature = job.sig;
            map[job.id].judgedAt = nowIso();
            await saveThreads(map);
            maybeRenderDeadlineHint(job.id, res);
          }
        }
      } catch (e) {
        log("判断失败", e);
      }
    }
    judging = false;
  }

  // —— 会话内「该问 DDL」内嵌提示 ————————————————————

  const HINT_ID = "kol-ddl-hint";
  function removeHint() {
    const el = document.getElementById(HINT_ID);
    if (el) el.remove();
  }

  // 给这个会话「永久静音」DDL 提示（处理过了就别再烦），并可顺手建待办
  async function silenceDdl(id) {
    const m = await getThreads();
    if (m[id]) {
      m[id].ddlSilenced = true;
      await saveThreads(m);
    }
  }
  async function addTodo(text, dueAt, threadId) {
    const s = await chrome.storage.local.get("kolTodos");
    const todos = s.kolTodos || [];
    todos.push({ id: "t" + Date.now() + Math.floor(performance.now()), text, dueAt, threadId: threadId || "", done: false, dismissed: false });
    await chrome.storage.local.set({ kolTodos: todos });
  }
  function plusDaysIso(days) {
    return new Date(Date.now() + days * 86400000).toISOString();
  }

  async function maybeRenderDeadlineHint(id, judge) {
    if (id !== titleKey(conversationTitle())) return; // 只在当前打开的会话里提示（按 key 匹配）
    removeHint();
    if (!judge || !judge.should_ask_deadline) return;

    // 这个会话处理过 DDL（约好了/已问/这次不用）就永久不再弹
    const map = await getThreads();
    const rec = map[id] || {};
    if (rec.ddlSilenced) return;
    const name = rec.title || conversationTitle() || "这个红人";
    const threadId = rec.threadId || "";

    const box = document.querySelector('div[role="textbox"], textarea[placeholder]');
    const footer = box ? box.closest("form, div") : null;
    const anchor = footer || document.querySelector('div[role="main"]') || document.body;

    const hint = document.createElement("div");
    hint.id = HINT_ID;
    hint.className = "kol-ddl-hint";
    const tip = document.createElement("div");
    tip.className = "kol-ddl-tip";
    tip.textContent = "⏰ 还没和 TA 约交稿时间";
    hint.appendChild(tip);

    const askText =
      judge.suggested_ask_deadline_text ||
      "Hi! When do you think the first draft could be ready?（问初稿时间）";
    const defaultText =
      "Hi! We usually plan around 3 days for the first draft — does that work for you?（默认约 3 天交稿）";

    // 插入「问档期」：填话术 + 自动建一条"等对方回交稿时间"的待办，并静音
    hint.appendChild(makeHintBtn("插入「问档期」", async () => {
      insertIntoBox(askText);
      await addTodo(`等 ${name} 回交稿时间`, plusDaysIso(1), threadId);
      await silenceDdl(id);
      removeHint();
    }));
    // 插入「默认3天」：填话术 + 自动建"约了3天，到期检查"的待办，并静音
    hint.appendChild(makeHintBtn("插入「默认3天」", async () => {
      insertIntoBox(defaultText);
      await addTodo(`${name} 约3天交稿，到期检查`, plusDaysIso(3), threadId);
      await silenceDdl(id);
      removeHint();
    }));
    // 我已约好/已问：填一个时间 → 自动建待办 + 静音
    hint.appendChild(makeHintBtn("✅ 已约好/已问…", () => showDdlRecord(hint, id, name, threadId)));
    // 这次不用：永久静音这个会话的 DDL 提示
    hint.appendChild(makeHintBtn("这次不用", async () => {
      await silenceDdl(id);
      removeHint();
    }));

    if (footer && footer.parentElement) {
      footer.parentElement.insertBefore(hint, footer);
    } else {
      anchor.appendChild(hint);
    }
  }

  // 展开"已约好"的小输入：打一句时间 → AI 解析 → 建待办 + 静音
  function showDdlRecord(hint, id, name, threadId) {
    if (hint.querySelector(".kol-ddl-record")) return;
    const wrap = document.createElement("div");
    wrap.className = "kol-ddl-record";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "约定何时交？如 3天后 / 周五 / 6月30日";
    const save = document.createElement("button");
    save.type = "button";
    save.className = "kol-ddl-btn";
    save.textContent = "记进待办";
    save.addEventListener("click", async () => {
      const sentence = input.value.trim();
      if (!sentence) { input.focus(); return; }
      save.disabled = true;
      save.textContent = "解析中…";
      let dueAt = plusDaysIso(3);
      try {
        const r = await chrome.runtime.sendMessage({ type: "KOL_PARSE_TODO", payload: { sentence, now: new Date().toISOString() } });
        if (r && r.date) {
          const d = new Date(`${r.date}T${(r.time || "10:00")}:00`);
          if (!isNaN(d)) dueAt = d.toISOString();
        }
      } catch (e) { /* 解析失败用默认3天 */ }
      await addTodo(`${name} 交稿（约定：${sentence}）`, dueAt, threadId);
      await silenceDdl(id);
      removeHint();
    });
    wrap.append(input, save);
    hint.appendChild(wrap);
    input.focus();
  }

  function makeHintBtn(label, onClick) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "kol-ddl-btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  // 只把话术「填进」IG 输入框，绝不替你发送
  function insertIntoBox(text) {
    const box = document.querySelector('div[role="textbox"], textarea[placeholder]');
    if (!box) return;
    box.focus();
    try {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    } catch (e) {
      if ("value" in box) box.value = text;
      else box.textContent = text;
    }
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // —— 主扫描 ————————————————————————————————————————

  async function scan() {
    if (!settings.enabled || !inDirect()) return;
    try {
      // 1) 收件箱列表：把你划过的对话都记一笔。
      //    关键：只在列表里看到「未读」或「最后一条不是我发的」，就算待回复，
      //    不用你点进对话——这样"红人发了、我只瞄了一眼没点开"也能提醒。
      const inbox = scanInbox();
      const openName = conversationTitle(); // 当前打开对话的完整名字
      const openKey = titleKey(openName); // 它的归一化 key
      const openTid = currentThreadId(); // 数字ID，仅用于"打开对话"深链
      if (inbox.length) {
        const map = await getThreads();
        let changed = false;
        inbox.forEach((row) => {
          // 当前正打开的那条交给第 2 步精读，这里不用列表的粗判覆盖它
          if (openKey && row.id === openKey) return;
          const prev = map[row.id] || {};
          // 列表判待回复：只在真正"未读"时算，避免把你已回/已读的也报上来。
          // "已读但没回"留给你点进对话时精读判断，不在列表瞎报。
          const inboxNeedsReply = Boolean(row.unread) && !row.lastFromMe;
          // 显示名保留更长更完整的那个
          const title =
            (row.title || "").length > (prev.title || "").length ? row.title : (prev.title || row.title || "");
          const next = {
            ...prev,
            title,
            inboxPreview: row.preview || prev.inboxPreview || "",
            lastMsgPreview: row.preview || prev.lastMsgPreview || "",
            unread: row.unread,
            needsReplyRaw: inboxNeedsReply,
            needsReplyReason: inboxNeedsReply ? "未读 · 对方发了新消息" : "",
            lastSeenAt: nowIso()
          };
          // 「第一次发现没回」锚点：从"不是待回复"变成"待回复"时盖戳
          if (inboxNeedsReply && !prev.needsReplyRaw) next.firstUnrepliedAt = nowIso();
          if (!inboxNeedsReply) next.firstUnrepliedAt = null;
          map[row.id] = next;
          changed = true;
        });
        if (changed) await saveThreads(map);
      }

      // 2) 当前打开的对话：精读消息，判断待回复 + 触发 AI 判断
      // 名字必须能和左边列表里某一行对上（防止把消息内容误当成对话名）。
      const inboxKeys = new Set(inbox.map((r) => r.id));
      if (openTid) {
        // 滚动累积：换了对话就清空缓冲；把当前屏幕渲染出的消息累加进缓冲
        if (convBuffer.tid !== openTid) convBuffer = { tid: openTid, key: "", name: "", messages: [] };
        const fullView = readOpenConversation(500);
        if (fullView && fullView.messages.length) mergeIntoBuffer(fullView.messages);

        const conv = readOpenConversation();
        const name = openName || (conv && conv.creatorName) || "";
        const key = titleKey(name);
        // key 对不上任何列表行 → 多半是抓错了名字（抓到消息了），跳过不建脏记录
        if (conv && conv.messages.length && key && inboxKeys.has(key)) {
          const msgs = conv.messages;
          // 待回复(精读)：最后一条 creator 之后，没有我(me)的回复
          let lastCreatorIdx = -1;
          msgs.forEach((m, i) => {
            if (m.from === "creator") lastCreatorIdx = i;
          });
          const myReplyAfter =
            lastCreatorIdx >= 0 &&
            msgs.slice(lastCreatorIdx + 1).some((m) => m.from === "me");
          const needsReplyRaw = lastCreatorIdx >= 0 && !myReplyAfter;
          const last = msgs[msgs.length - 1];
          // 用列表里那条更完整的名字来显示
          const inboxRow = inbox.find((r) => r.id === key);
          const displayName = (inboxRow && inboxRow.title) || name;
          // 记到累积缓冲，供"离开时自动更新合作进展"
          convBuffer.key = key;
          convBuffer.name = displayName;

          await upsertThread(
            key, // 用归一化名字当 key
            {
              threadId: openTid, // 数字ID，供"打开对话"深链
              isGroup: conv.isGroup,
              creatorName: conv.creatorName || displayName,
              title: displayName, // 完整名字用于显示
              lastMsgFrom: last.from,
              lastMsgPreview: last.text.slice(0, 120),
              needsReplyRaw,
              needsReplyReason: needsReplyRaw ? "对方最后发的，你还没回" : "",
              unread: false // 打开了就不算未读
            },
            msgs
          );

          // 若已有判断结果，刷新会话内 DDL 提示
          const map2 = await getThreads();
          if (map2[key] && map2[key].judge) maybeRenderDeadlineHint(key, map2[key].judge);
        }
      } else {
        removeHint();
      }
    } catch (e) {
      log("扫描出错", e);
    }
  }

  // —— 触发时机：搭便车，不主动滚 ——————————————————————

  let scanTimer;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 600);
  }

  // 离开对话时，把这次聊的内容自动并进"合作进展"（增量更新，不丢旧的）
  const lastSummarizedSig = {};
  async function autoUpdateSummaryOnLeave(buf) {
    try {
      if (!buf || !buf.messages || buf.messages.length < 2) return;
      // 用对话的固定 ID 存（取不到再退回名字），名字识别有出入也不会丢匹配
      const sk = buf.tid || buf.key;
      if (!sk) return;
      const sig = buf.messages.length + "|" + msgSig(buf.messages[buf.messages.length - 1]);
      if (lastSummarizedSig[sk] === sig) return; // 没新内容，别重复花钱
      lastSummarizedSig[sk] = sig;
      const store = await chrome.storage.local.get("kolSummaries");
      const all = store.kolSummaries || {};
      const prevRec = all[sk] || (buf.key ? all[buf.key] : null);
      const previousSummary = prevRec ? prevRec.text : "";
      const res = await chrome.runtime.sendMessage({
        type: "KOL_SUMMARY",
        payload: { messages: buf.messages, previousSummary, creatorName: buf.name }
      });
      if (res && res.summary) {
        all[sk] = { text: res.summary, name: buf.name, tid: buf.tid || "", key: buf.key || "", updatedAt: new Date().toISOString() };
        await chrome.storage.local.set({ kolSummaries: all });
      }
    } catch (e) {
      /* 后台更新失败就算了，不打扰用户 */
    }
  }

  let lastPath = location.pathname;
  function watchUrl() {
    if (location.pathname !== lastPath) {
      // 离开了一个对话 → 自动更新它的合作进展
      const left = convBuffer;
      if (left && (left.tid || left.key) && left.messages.length) {
        autoUpdateSummaryOnLeave({ tid: left.tid, key: left.key, name: left.name, messages: left.messages.slice() });
      }
      lastPath = location.pathname;
      removeHint();
      scheduleScan();
    }
  }

  scheduleScan();
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("scroll", scheduleScan, true);
  window.addEventListener("focus", scheduleScan);
  setInterval(watchUrl, 800); // IG 是单页应用，靠轮询察觉换会话

  // 供侧边栏"合作情况总结"取当前打开对话的消息（读屏，不碰 IG 接口）
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "KOL_GET_CONVERSATION") return;
    try {
      const tid = currentThreadId();
      const conv = readOpenConversation(80);
      const currentView = readOpenConversation(500); // 当前屏幕渲染出的（给逐段抓取用）
      const name = conversationTitle() || (conv && conv.creatorName) || "";
      // 优先返回"滚动累积"的完整缓冲(你往上滚攒下的全部)；缓冲对不上才用当前屏
      const accumulated =
        tid && convBuffer.tid === tid && convBuffer.messages.length
          ? convBuffer.messages
          : (conv ? conv.messages : []);
      sendResponse({
        tid: tid || "",
        key: titleKey(name),
        name,
        isGroup: conv ? conv.isGroup : false,
        messages: accumulated,
        currentMessages: currentView ? currentView.messages : []
      });
    } catch (e) {
      sendResponse({ key: "", name: "", messages: [] });
    }
    return true;
  });
})();
