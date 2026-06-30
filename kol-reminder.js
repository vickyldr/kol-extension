// KOL 提醒 · 采集脚本（搭便车读屏，绝不碰 IG 账号）
// 只在你自己打开的 Instagram 私信/群聊页面上，读已经渲染出来的对话，
// 记进本地记账本（chrome.storage.local）。不发任何 IG 请求、不替你点/滚/发。
(function () {
  if (!location.hostname.includes("instagram.com")) return;

  const THREADS_KEY = "kolThreads"; // 记账本：每个对话一条
  const SETTINGS_KEY = "kolReminderSettings"; // 身份设置：我的产品 / 产品清单 / 我的号
  const DEFAULT_PREFIXES = ["recco", "rythmix", "aicatch", "vivavideo", "vivacut", "wisemeal", "rymo", "inspo"];
  // 产品别名：标准全名 → 可能写法（全名 + 两字代码）。只用来认「我方自己的号」属于哪个产品，
  // 因为只作用在我自己的号上，两字代码再短也不怕误伤红人名字（红人不会用我们的命名规范）。
  const PRODUCT_ALIASES = [
    ["vivavideo", ["vivavideo", "va"]],
    ["aicatch", ["aicatch", "aictach", "ac"]],
    ["rythmix", ["rythmix", "rm"]],
    ["vivacut", ["vivacut", "vc"]],
    ["recco", ["recco", "rc"]],
    ["wisemeal", ["wisemeal", "wm"]],
    ["rymo", ["rymo", "ry"]],
    ["inspo", ["inspo", "in"]]
  ];
  // 从「我方号」认产品：全名直接 includes；两字代码要后接分隔符/数字/结尾（防 "ryan" 命中 "ry"）。
  function productFromHandle(handle) {
    const h = String(handle || "").toLowerCase().replace(/^@/, "").trim();
    if (!h) return "";
    for (const [name, aliases] of PRODUCT_ALIASES) {
      for (const a of aliases) {
        const hit = a.length > 2 ? h.includes(a) : new RegExp("^" + a + "([_.\\-\\s\\d]|$)").test(h);
        if (hit) return name;
      }
    }
    return "";
  }
  // 把 href 解析成纯 ig handle（单段、非 IG 保留词）。/xiaoli/ → xiaoli；/direct/ → ""
  const IG_RESERVED = new Set(["direct", "explore", "reels", "p", "stories", "accounts", "about", "instagram", "tv", "channel"]);
  function bareHandleFromHref(href) {
    const m = String(href || "").match(/^\/([a-z0-9._]+)\/?$/i);
    if (!m) return "";
    return IG_RESERVED.has(m[1].toLowerCase()) ? "" : m[1];
  }

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

  // 一次性清理：
  //  v3：旧版按"数字对话ID"存的记账本 → 全清。
  //  v4：把状态徽标("New messages"/"在线"/时间戳)误当成红人名字的脏记录 → 定点删除（不全清，保留正常档）。
  chrome.storage.local.get(["kolThreadsSchema", "kolThreads"]).then((s) => {
    const ver = s.kolThreadsSchema;
    if (ver === 4) return;
    let map = ver === 3 ? (s.kolThreads || {}) : {}; // 不到 v3 的全清，v3→v4 只清脏的
    Object.keys(map).forEach((k) => {
      if (isStatusLine(k) || isStatusLine(map[k] && map[k].title)) delete map[k];
    });
    chrome.storage.local.set({ kolThreads: map, kolThreadsSchema: 4 });
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

  // 收件箱行里这些是"状态徽标 / 时间戳 / 系统文案"，不是红人名字——挑名字时要跳过。
  // 之前直接拿 lines[0] 当名字，结果行首是"New messages"徽标时，整条提醒就叫"New messages"了。
  function isStatusLine(s) {
    const t = String(s || "").trim();
    if (!t) return true;
    return (
      /new\s*messages?|新消息|条新消息|未读/i.test(t) ||
      /^(在线|online|active\s*now|active\s*\d|正在输入|typing\.{0,3})$/i.test(t) ||
      /active\s*now/i.test(t) ||
      // 时间戳/时长：必须整行就是它（加 $ 锚定），否则像"5 min crafts""20:00 Club"
      // 这类含数字的真名字会被误判成状态行而丢掉。
      /^\d+\s*(分钟|小时|天|周|秒|分|min|mins?|hr?|hrs?|d|w)(前|ago)?$/i.test(t) ||
      /^(昨天|今天|刚刚|just\s*now)$/i.test(t) ||
      /^\d{1,2}[:：]\d{2}$/.test(t) ||
      /便签|分享一件|^note$/i.test(t)
    );
  }

  // 从一行对话的多行文本里挑出"红人名字 / 群聊名"：取第一条不是状态徽标的文本。
  function pickInboxTitle(lines) {
    for (const l of (lines || [])) {
      const t = (l || "").trim();
      if (t.length >= 2 && !isStatusLine(t)) return t.slice(0, 80);
    }
    return "";
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
  // 自动认出「我方号」+ 产品。每次 scan 都会再调一次：
  //  - 已有号：只补一次产品（旧版只存了号没认产品时补救），然后早退。
  //  - 没有号：从左侧导航栏「我的头像链接」抠 handle。导航栏才是登录账号入口，
  //    比全局扫 img[alt*=头像] 稳得多（后者会扫到对话里红人的头像 → 认错号）。
  function maybeAutodetectHandle() {
    if (settings.myHandle) {
      if (!settings.myProduct) {
        const product = productFromHandle(settings.myHandle);
        if (product) {
          const next = { ...settings, myProduct: product };
          settings = next;
          chrome.storage.local.set({ [SETTINGS_KEY]: next });
          log("补认产品:", product);
        }
      }
      return;
    }
    try {
      let handle = "";
      // 优先：导航栏里带头像 img 的个人主页链接（href="/<我的号>/"）
      const navLinks = document.querySelectorAll('nav a[href^="/"], [role="navigation"] a[href^="/"]');
      for (const a of navLinks) {
        const h = bareHandleFromHref(a.getAttribute("href"));
        if (h && a.querySelector("img")) { handle = h; break; }
      }
      // 兜底：老选择器（个人头像 alt），但用 bareHandleFromHref 过滤掉 /direct/ 这类
      if (!handle) {
        const link = document.querySelector('a[href^="/"][role="link"] img[alt*="头像"], a[href^="/"] img[alt*="profile picture"], a[href^="/"] img[alt*="个人资料照片"]');
        const a = link && link.closest('a[href^="/"]');
        if (a) handle = bareHandleFromHref(a.getAttribute("href"));
      }
      if (handle && handle.length < 40) {
        const product = productFromHandle(handle);
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
      // 我给对方这条消息点了表情（reaction）→ 视作已回应，后面判待回复时不再提醒。
      // 1:1 私信里，挂在「对方气泡」上的表情就是我点的；只对 creator 消息检测。
      const reacted = from === "creator" ? bubbleHasMyReaction(el) : false;
      messages.push({ from, name, text, reacted });
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

  // 判断「对方这条消息上是否挂着我点的表情(reaction)」。
  // IG 1:1 私信里，对方气泡上出现的表情徽标就是我点的；据此把「点表情」当成已回应。
  // 依赖 IG 页面结构，故用两路兜底：① 无障碍标签含「回应/react」；② 气泡上挂着的纯表情小徽标。
  const REACTION_EMOJI_RE = /[❤\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{1F004}\u{1F0CF}]/u;
  function bubbleHasMyReaction(el) {
    // 往上找到这条消息的「行/气泡容器」
    let row = el;
    for (let i = 0; i < 6 && row && row.parentElement; i += 1) row = row.parentElement;
    if (!row || !row.querySelectorAll) return false;
    // ① 无障碍标签：很多版本 reaction 带 aria-label，如「你回应了 ❤️」/「reacted」
    for (const n of row.querySelectorAll("[aria-label]")) {
      const lab = n.getAttribute("aria-label") || "";
      if (/回应|reacted|reaction|你用.*回应/i.test(lab)) return true;
    }
    // ② 挂在气泡上的表情小徽标：短文本/alt 只含 1~2 个 emoji，且不是消息正文本身
    for (const n of row.querySelectorAll("img[alt], span, div")) {
      if (n === el || n.contains(el) || el.contains(n)) continue;
      const alt = n.getAttribute && n.getAttribute("alt");
      if (alt && alt.length <= 4 && REACTION_EMOJI_RE.test(alt)) return true;
      const t = (n.innerText || "").trim();
      if (t && t.length <= 3 && REACTION_EMOJI_RE.test(t)) return true;
    }
    return false;
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
      // 挑名字：跳过"New messages/在线/时间戳"等徽标，取第一条像名字的文本
      const title = pickInboxTitle(lines);
      if (!title || title.length < 2) return;
      const key = titleKey(title);
      if (!key || seen.has(key)) return;
      seen.add(key);
      // 预览：去掉名字行和所有状态徽标，剩下的当最后一条消息预览
      const preview = lines.filter((l) => l !== title && !isStatusLine(l)).join(" ").slice(0, 120);
      // 未读：只认真正的未读信号（"N new messages" / 蓝色未读圆点）。
      // 不再用字重(isBold)——IG 名字几乎都是粗体，会把所有行误判成未读。
      const unread =
        /(\d+\s*new message|new messages|条新消息|未读)/i.test(text) ||
        hasUnreadDot(row);
      // 最后一条是不是我发的：兼容"你: …""你发送了…""You: …""You sent…"
      const lastFromMe = /^\s*(you|您|你|me)\s*[:：]/i.test(preview) ||
        /^\s*你(发送了|已发送)/.test(preview) ||
        /^\s*you\s+sent/i.test(preview);
      // 尽量抓出这一行对应的对话数字 ID（IG 部分版本会把整行包成 <a href="/direct/t/xxx/">）。
      // 抓到了「打开对话」就能直达；抓不到照旧（用名字当 key、退回收件箱首页）。
      let tid = "";
      const anchor =
        (row.closest && row.closest("a[href*='/direct/t/']")) ||
        (row.querySelector && row.querySelector("a[href*='/direct/t/']"));
      if (anchor) {
        const m = (anchor.getAttribute("href") || "").match(/\/direct\/t\/([^/?#]+)/);
        if (m) tid = m[1];
      }
      // 在线状态：IG 对话行里有绿点或"在线/online/active now"文字
      const isOnline = /(在线|online\s*·|active\s*now)/i.test(text) ||
        !!row.querySelector?.("[aria-label*='active'],[aria-label*='在线'],[aria-label*='online']");
      // 头像图：这一行的头像 img 地址（红人/群聊真实头像），用于提醒卡片和桌面通知
      const avatarUrl = img.currentSrc || img.getAttribute("src") || "";
      // 用名字归一化前缀当 key（id 字段沿用，后续代码不必大改）
      rows.push({ id: key, title, preview, unread, lastFromMe, tid, isOnline, avatarUrl });
    });
    return rows;
  }

  // 在左边收件箱列表里，按归一化名字找到那一行的可点元素（供"打开对话"直接点开）。
  // 不依赖 IG 把行做成链接——找到行后真实地派发点击，让 IG 自己导航过去。
  function findInboxRowEl(targetKey) {
    if (!targetKey) return null;
    const imgs = document.querySelectorAll("img");
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      if (r.left > 460 || r.top < 60) continue; // 只看左侧列表区
      if (r.width < 18 || r.width > 84) continue; // 头像大小
      let row = img.parentElement;
      for (let hops = 0; row && hops < 9; hops += 1) {
        const t = row.innerText || "";
        if (
          t && t.length < 240 &&
          /(分钟|小时|天前|周前|昨天|今天|刚刚|秒前|new message|新消息|在线|online|active)/i.test(t)
        ) break;
        row = row.parentElement;
      }
      if (!row) continue;
      const lines = (row.innerText || "").trim().split("\n").map((s) => s.trim()).filter(Boolean);
      const title = pickInboxTitle(lines);
      if (title && titleKey(title) === targetKey) return row;
    }
    return null;
  }

  // 真实点击一个元素（IG 是 React，单纯 .click() 不一定触发，派发冒泡的鼠标事件最稳）
  function realClick(el) {
    if (!el) return false;
    // 优先点行内可点的链接/按钮/头像，点不到再点行本身
    const target =
      el.querySelector("a[href*='/direct/t/']") ||
      el.querySelector("[role='button']") ||
      el.querySelector("img") ||
      el;
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      target.dispatchEvent(new MouseEvent("pointerdown", opts));
      target.dispatchEvent(new MouseEvent("mousedown", opts));
      target.dispatchEvent(new MouseEvent("mouseup", opts));
      target.dispatchEvent(new MouseEvent("click", opts));
      return true;
    } catch (e) {
      try { target.click(); return true; } catch (_) { return false; }
    }
  }

  // 按名字打开对话：先在当前可见列表里找；找不到就滚动列表多试几次（懒加载的行）
  // 返回 {ok, tid}：点开后把 URL 里的对话数字 ID 抓回来（学到了就回传，提醒侧存上→下次深链直达）
  async function openThreadByName(targetKey) {
    if (!targetKey) return { ok: false };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const row = findInboxRowEl(targetKey);
      if (row) {
        realClick(row);
        // 等 IG 跳转、URL 变成 /direct/t/<id>/，把这个 id 抓回来
        for (let i = 0; i < 12; i += 1) {
          const tid = currentThreadId();
          if (tid) return { ok: true, tid };
          await new Promise((res) => setTimeout(res, 200));
        }
        return { ok: true, tid: "" };
      }
      // 没找到：把收件箱列表往下滚一屏再试（找装着多行头像的可滚动容器）
      const firstImg = document.querySelector("img");
      let scroller = firstImg ? firstImg.parentElement : null;
      for (let i = 0; scroller && i < 12; i += 1) {
        if (scroller.scrollHeight > scroller.clientHeight + 40 &&
            scroller.getBoundingClientRect().left < 460) break;
        scroller = scroller.parentElement;
      }
      if (scroller) scroller.scrollTop += scroller.clientHeight * 0.8;
      await new Promise((res) => setTimeout(res, 300));
    }
    return { ok: false };
  }

  // 「我发过的」发件箱：把我发的实质消息(够长、含字/数字、去重)记到本地，供侧边栏搜索复用，
  // 不用再去群里翻历史。只存文本+红人名+时间+我方号，纯本地、随云备份，不喂 AI。
  const SENT_KEY = "kolSentHistory";
  async function captureSentHistory(messages, name) {
    try {
      const mine = (messages || [])
        .filter((m) => m && m.from === "me" && typeof m.text === "string")
        .map((m) => m.text.trim())
        .filter((t) => t.length >= 12 && /[\p{L}\p{N}]/u.test(t)); // 够长 + 含字母/数字（滤掉纯表情/"好的"这类）
      if (!mine.length) return;
      const s = await chrome.storage.local.get(SENT_KEY);
      const list = Array.isArray(s[SENT_KEY]) ? s[SENT_KEY] : [];
      const seen = new Set(list.map((x) => x && x.text));
      const add = [];
      for (const text of mine) {
        if (seen.has(text)) continue;
        seen.add(text);
        add.push({ text, name: name || "", at: nowIso(), account: settings.myHandle || "" });
      }
      if (!add.length) return; // 没有新内容就不写，避免每轮 scan 都落盘
      const next = add.concat(list).slice(0, 200); // 新的在前，留最近 200 条
      await chrome.storage.local.set({ [SENT_KEY]: next });
    } catch (_) { /* 记不上就算了，不影响主流程 */ }
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
    // id 是"归一化名字 key"；threadId 要保留 patch 传来的数字对话 ID（openTid），
    // 别用名字 key 覆盖它——否则"打开对话"深链失效、按数字 threadId 找真总结也对不上。
    const rec = { ...prev, ...patch, threadId: patch.threadId || prev.threadId || "", account: (settings.myHandle || prev.account || "").replace(/^@/, ""), lastSeenAt: nowIso() };
    // 头像没新值时别让 undefined 把旧头像冲掉
    if (rec.avatarUrl === undefined) rec.avatarUrl = prev.avatarUrl || "";

    // 「第一次发现没回」的锚点：从「不是待回复」变成「待回复」时盖戳
    if (patch.needsReplyRaw && !prev.needsReplyRaw) {
      rec.firstUnrepliedAt = nowIso();
    }
    if (!patch.needsReplyRaw) {
      rec.firstUnrepliedAt = null;
    }

    // 「主动跟进」升级状态机：我方已发、红人不回时，逐级升级
    //   followUpLevel = 我方已主动跟进的次数（不含首次回复）：0→还没催，1→二次跟进过，2→再跟进过，3→通牒过
    //   lastFollowUpAt = 上次触达对方的时间（回复或主动跟进都算）；给看板「最近跟进」+ 提醒升级计时用。
    // 只加字段，绝不改 needsReplyRaw 判定本身（见 CLAUDE.md §9.14）。
    if (patch.needsReplyRaw) {
      // 红人发了新消息、轮到我回 → 跟进链清零（这不是我在等对方）
      rec.followUpLevel = 0;
    } else if ("needsReplyRaw" in patch) {
      if (prev.needsReplyRaw) {
        // 刚从「该我回」翻成「我回了」= 回复了对方 → level 0，开始等对方，盖触达时间
        rec.followUpLevel = 0;
        rec.lastFollowUpAt = nowIso();
      } else if (
        prev.lastMsgPreview &&
        patch.lastMsgFrom === "me" &&
        patch.lastMsgPreview &&
        patch.lastMsgPreview !== prev.lastMsgPreview
      ) {
        // 已经在等对方时，我方又发了一条 = 一次主动跟进 → 升级 + 盖触达时间
        rec.followUpLevel = (prev.followUpLevel || 0) + 1;
        rec.lastFollowUpAt = nowIso();
      }
      // 否则保持 prev（rec 已从 prev 复制）
    }

    // 精确计时：记录「最新一条红人消息」的到达时间，用于5分钟提醒倒计时。
    // 每次有新红人消息（preview 变了且还是待回复状态）就重置，避免"第三分钟又来一条却在第五分钟提醒"。
    if (patch.needsReplyRaw) {
      if (!prev.needsReplyRaw) {
        // 首次进入待回复：开始计时
        rec.lastCreatorMessageAt = nowIso();
        rec.replyReminderSent = false;
      } else if (patch.lastMsgPreview !== prev.lastMsgPreview) {
        // 还在待回复但红人又发了新消息：重置计时和提醒标记
        rec.lastCreatorMessageAt = nowIso();
        rec.replyReminderSent = false;
      }
    } else {
      rec.lastCreatorMessageAt = null;
      rec.replyReminderSent = false;
    }

    // 未读计时：第一次出现未读时盖戳，消除未读时清空
    if (patch.unread && !prev.unread) {
      rec.unreadSince = nowIso();
      rec.unreadReminderSent = false;
    } else if (!patch.unread) {
      rec.unreadSince = null;
      rec.unreadReminderSent = false;
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
    maybeAutodetectHandle(); // 没认出号/产品时每轮重试（首次页面没渲染好会漏，这里补）
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
          // 最后一条是我发的（"你: …"）→ 就算列表显示"未读"角标也清掉，
          // 群聊里你回完别人又发了新消息前、IG 角标还没消时会误报——用 lastFromMe 提前消除。
          const myLastMsg = Boolean(row.lastFromMe);
          const inboxNeedsReply = Boolean(row.unread) && !myLastMsg;
          // 显示名保留更长更完整的那个
          const title =
            (row.title || "").length > (prev.title || "").length ? row.title : (prev.title || row.title || "");
          const next = {
            ...prev,
            title,
            // 列表里抓到对话 ID 就补上（供"打开对话"深链）；抓不到保留原值
            threadId: row.tid || prev.threadId || "",
            inboxPreview: row.preview || prev.inboxPreview || "",
            lastMsgPreview: row.preview || prev.lastMsgPreview || "",
            // 最后一条是我发的 → 强制视为"已回/已读"，清除 unread 和 needsReply
            unread: myLastMsg ? false : row.unread,
            isOnline: row.isOnline || false,
            avatarUrl: row.avatarUrl || prev.avatarUrl || "",
            // 记下这条对话属于哪个登录号（我方 handle）。多账号时「打开对话」据此挑对应账号的标签页，
            // 否则深链开到另一个账号的标签上会显示空白收件箱。
            account: (settings.myHandle || prev.account || "").replace(/^@/, ""),
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
        // 对"没点进去过的待回复"行，把红人最新预览交给 AI 归纳成一句中文，存进 autoSummary。
        // 运营看不懂外语，提醒卡片要的是中文 gist，不是原文。去重靠 previewSummarizedSig。
        await summarizePreviewsForReply(map);
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
          // 我给对方最后一条消息点了表情，也算已回应（不再当待回复提醒）
          const reactedLast = lastCreatorIdx >= 0 && msgs[lastCreatorIdx].reacted === true;
          const last = msgs[msgs.length - 1];
          // 用列表里那条更完整的名字来显示
          const inboxRow = inbox.find((r) => r.id === key);
          // 兜底：群聊里气泡左右/颜色判断不稳，我发的消息可能没被认成 "me"，
          // 导致已回复却仍报"待回复"。只要整段精读到的最后一条是我发的，就视为已回复。
          // 注意：这里只信"精读到的最后一条"(last)，不再用收件箱列表预览的 lastFromMe——
          // 列表预览有延迟，红人刚发新消息但列表还显示"你: …"时，会误把真待回复也压掉。
          // 列表那条的判断已在第 1 步(myLastMsg)处理，这里以精读为准。
          const lastIsMine = last && last.from === "me";
          const needsReplyRaw =
            lastCreatorIdx >= 0 && !myReplyAfter && !reactedLast && !lastIsMine;
          const displayName = (inboxRow && inboxRow.title) || name;
          // 记到累积缓冲，供"离开时自动更新合作进展"
          convBuffer.key = key;
          convBuffer.name = displayName;
          // 顺手把"我发过的实质消息"记进发件箱，供侧边栏搜索复用（去重，没新内容不落盘）
          captureSentHistory(conv.messages, displayName);

          await upsertThread(
            key, // 用归一化名字当 key
            {
              threadId: openTid, // 数字ID，供"打开对话"深链
              isGroup: conv.isGroup,
              creatorName: conv.creatorName || displayName,
              title: displayName, // 完整名字用于显示
              lastMsgFrom: last.from,
              lastMsgPreview: last.text.slice(0, 120),
              avatarUrl: (inboxRow && inboxRow.avatarUrl) || undefined,
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

  // 没点进去过的待回复对话：用 AI 把红人最新预览归纳成一句中文，写进 autoSummary。
  // - 只对 needsReplyRaw 且没有 kolSummaries（点进去过会生成更完整的真总结）的行做；
  // - 预览没变就跳过（previewSummarizedSig 去重，别重复花钱）；
  // - 一次扫描最多处理 3 条，避免几十个未读时一次性爆发请求。
  async function summarizePreviewsForReply(map) {
    try {
      const store = await chrome.storage.local.get("kolSummaries");
      const summaries = store.kolSummaries || {};
      const candidates = [];
      Object.entries(map || {}).forEach(([key, rec]) => {
        if (!rec || rec.muted || !rec.needsReplyRaw) return;
        const preview = String(rec.inboxPreview || rec.lastMsgPreview || "").trim();
        if (!preview) return;
        // 点进去过、已有真总结的，不用预览总结
        const hasReal = summaries[key] || (rec.threadId && summaries[rec.threadId]);
        if (hasReal) return;
        const sig = preview.slice(0, 60);
        if (rec.previewSummarizedSig === sig) return; // 预览没变
        candidates.push({ key, rec, preview, sig });
      });
      if (!candidates.length) return;
      let updated = false;
      for (const c of candidates.slice(0, 3)) {
        const res = await chrome.runtime.sendMessage({
          type: "KOL_SUMMARY",
          payload: { mode: "preview", text: c.preview, creatorName: c.rec.title || c.rec.creatorName || "" }
        });
        // 写回最新的 map（期间可能被其它扫描改过，重新取一次）
        const latest = await getThreads();
        if (!latest[c.key]) continue;
        latest[c.key].previewSummarizedSig = c.sig; // 不管成不成功都记，避免反复重试同一条
        if (res && res.summary) latest[c.key].autoSummary = String(res.summary).trim();
        await saveThreads(latest);
        map[c.key] = latest[c.key];
        updated = true;
      }
      return updated;
    } catch (e) {
      /* 预览总结失败不影响提醒本身 */
    }
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
        const rec = { text: res.summary, name: buf.name, tid: buf.tid || "", key: buf.key || "", updatedAt: new Date().toISOString() };
        all[sk] = rec;
        // 双写一份按"归一化名字 key"——提醒清单(reminders.js)的 thread key 是名字，
        // 抓不到数字 threadId 时只能按名字找总结；不双写会导致点过的对话清单里仍显示不出真总结。
        if (buf.key && buf.key !== sk) all[buf.key] = rec;
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
    // 按名字在收件箱里找到那条对话并点开（提醒"打开对话"在拿不到深链 ID 时用）
    if (message?.type === "KOL_OPEN_THREAD_BY_NAME") {
      (async () => {
        try {
          const r = await openThreadByName(message.key || "");
          sendResponse(r && typeof r === "object" ? r : { ok: !!r });
        } catch (e) {
          sendResponse({ ok: false });
        }
      })();
      return true;
    }
    // 这个标签页当前登录的是哪个号（供提醒窗口多账号时挑对的标签开对话）
    if (message?.type === "KOL_GET_MY_HANDLE") {
      sendResponse({ handle: String(settings.myHandle || "").replace(/^@/, "").toLowerCase() });
      return true;
    }
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
