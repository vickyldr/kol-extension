let API_BASE = "http://106.54.206.174:3210";
let API_TOKEN = "";

// 与侧边栏共用的服务器配置（地址 + 团队口令），存在 chrome.storage.local。
chrome.storage.local.get("kolConfig").then((stored) => {
  if (stored.kolConfig) {
    API_BASE = stored.kolConfig.apiBase || API_BASE;
    API_TOKEN = stored.kolConfig.token || "";
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.kolConfig) {
    const next = changes.kolConfig.newValue || {};
    API_BASE = next.apiBase || "http://106.54.206.174:3210";
    API_TOKEN = next.token || "";
  }
});

const BUTTON_ID = "kol-assistant-floating-button";
const TRANSLATION_CLASS = "kol-inline-translation";
const translatedTexts = new Map();
const pendingTexts = new Map();

document.documentElement.dataset.kolAssistantVersion = "0.5.9";

function selectedText() {
  return window.getSelection()?.toString().trim() || "";
}

function createButton() {
  if (document.getElementById(BUTTON_ID)) return;

  const button = document.createElement("button");
  button.id = BUTTON_ID;
  button.type = "button";
  button.textContent = "析";
  button.title = "选中消息后在侧边栏分析言外之意和回复";

  button.addEventListener("click", async () => {
    const text = selectedText();
    await chrome.runtime.sendMessage({
      type: "OPEN_KOL_ASSISTANT",
      text,
      source: location.href
    });

    if (!text) {
      window.alert("自动翻译已开启。如需分析言外之意，请先选中一段消息。");
    }
  });

  document.documentElement.appendChild(button);
}

function isForeignMessage(text) {
  if (!text || text.length < 2 || text.length > 1200) return false;
  if (/^(https?:\/\/|www\.)/i.test(text)) return false;
  if (!/[\p{L}]/u.test(text)) return false;

  const chineseCount = (text.match(/[\u3400-\u9fff]/g) || []).length;
  const letterCount = (text.match(/\p{L}/gu) || []).length;
  return chineseCount / Math.max(letterCount, 1) < 0.45;
}

function isLikelyMessageElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (!element.closest("main")) return false;
  if (element.closest(`.${TRANSLATION_CLASS}`)) return false;
  if (
    element.closest(
      "button, nav, header, footer, [role='dialog'], a, [role='navigation']"
    )
  ) {
    return false;
  }

  const text = element.innerText?.trim();
  if (!isForeignMessage(text)) return false;
  const parentAuto = element.parentElement?.closest("[dir='auto']");
  if (
    parentAuto &&
    parentAuto !== element &&
    parentAuto.innerText?.trim() === text
  ) {
    return false;
  }
  if (element.children.length > 4) return false;

  // 无脑翻译：不再按宽度 / 左右 / 上下位置过滤。只要是 main 里、非按钮/导航/链接的
  // 外语文本就翻译（中文已被 isForeignMessage 过滤掉，不会误翻）。
  // 仅保留最小尺寸校验，避免抓到 0×0 的隐藏占位元素。
  const rect = element.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 6) return false;

  return true;
}

function translationAnchor(element) {
  let anchor = element;
  const originalText = element.innerText?.trim();

  for (let depth = 0; depth < 4; depth += 1) {
    const parent = anchor.parentElement;
    if (!parent || parent === document.body) break;
    const parentText = parent.innerText?.trim();
    const rect = parent.getBoundingClientRect();
    if (
      parentText !== originalText ||
      rect.width > 700 ||
      parent.closest("a, [role='navigation']")
    ) {
      break;
    }
    anchor = parent;
  }
  return anchor;
}

async function requestTranslation(text) {
  if (translatedTexts.has(text)) return translatedTexts.get(text);
  if (pendingTexts.has(text)) return pendingTexts.get(text);

  // 通过插件后台发起请求：Instagram 是 HTTPS 页面，直接请求 HTTP 的 VPS 会被
  // 浏览器“混合内容”策略拦截；后台 service worker 不受此限制。
  const promise = chrome.runtime
    .sendMessage({ type: "KOL_TRANSLATE", text })
    .then((res) => {
      if (!res || res.error) throw new Error(res?.error || "翻译失败");
      const translated = {
        translation: res.translation,
        termNotes: res.term_notes || []
      };
      translatedTexts.set(text, translated);
      return translated;
    })
    .finally(() => pendingTexts.delete(text));

  pendingTexts.set(text, promise);
  return promise;
}

async function addTranslation(element) {
  if (element.dataset.kolTranslationState) return;
  const text = element.innerText?.trim();
  if (!isForeignMessage(text)) return;

  element.dataset.kolTranslationState = "loading";
  const anchor = translationAnchor(element);
  const row = anchor.parentElement;
  if (!row) return;
  row.classList.add("kol-message-row");

  const translation = document.createElement("div");
  translation.className = `${TRANSLATION_CLASS} loading`;
  translation.textContent = "正在翻译…";
  const wrapper = document.createElement("div");
  wrapper.className = "kol-translation-row";
  // 用「真正的文字气泡」自身的位置来缩进译文，把译文钉在原文气泡的正下方：
  // 对方消息靠左 → 译文靠左；我方消息靠右 → 译文也靠右。
  // （之前用外层容器算，我方那行容器是满宽、左边在最左，算出缩进≈0，译文就跑到左边去了。）
  const bubbleRect = element.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const indent = Math.max(
    0,
    Math.min(bubbleRect.left - rowRect.left, Math.max(0, rowRect.width - 80))
  );
  wrapper.style.setProperty("--kol-translation-indent", `${Math.round(indent)}px`);
  wrapper.style.setProperty(
    "--kol-translation-width",
    `${Math.min(Math.max(bubbleRect.width, 180), 520)}px`
  );
  wrapper.appendChild(translation);
  anchor.insertAdjacentElement("afterend", wrapper);

  try {
    const result = await requestTranslation(text);
    if (!result?.translation || result.translation.trim() === text) {
      wrapper.remove();
      element.dataset.kolTranslationState = "same";
      return;
    }
    const mainTranslation = document.createElement("div");
    mainTranslation.textContent = result.translation;
    translation.replaceChildren(mainTranslation);

    if (result.termNotes?.length) {
      const notes = document.createElement("details");
      notes.className = "kol-term-notes";
      const summary = document.createElement("summary");
      summary.textContent = "查看术语说明";
      notes.appendChild(summary);
      for (const note of result.termNotes.slice(0, 2)) {
        const line = document.createElement("div");
        line.textContent = `注意「${note.term}」：${note.explanation}`;
        notes.appendChild(line);
      }
      translation.appendChild(notes);
    }
    translation.classList.remove("loading");
    element.dataset.kolTranslationState = "done";
  } catch {
    translation.textContent = "翻译暂不可用";
    translation.classList.remove("loading");
    translation.classList.add("error");
    element.dataset.kolTranslationState = "error";
  }
}

function scanMessages(root = document) {
  if (!location.hostname.includes("instagram.com")) return;

  const candidates = root.querySelectorAll
    ? root.querySelectorAll(
        "main [dir='auto'], main span[dir='auto'], main div[role='button'] span"
      )
    : [];

  let translated = 0;
  for (const element of candidates) {
    // 一次扫描放宽到 30 条：全屏消息一次性都翻译出来，不用滚动慢慢补。
    if (translated >= 30) break;
    if (isLikelyMessageElement(element)) {
      addTranslation(element);
      translated += 1;
    }
  }

  const button = document.getElementById(BUTTON_ID);
  if (button) {
    button.dataset.scanActive = "true";
    button.title = `自动翻译运行中 · 最近扫描 ${new Date().toLocaleTimeString()}`;
  }
}

let scanTimer;
let firstDirtyAt = 0;
function scheduleScan() {
  const now = Date.now();
  if (!firstDirtyAt) firstDirtyAt = now;
  clearTimeout(scanTimer);
  // 普通防抖 300ms；但若 DOM 已经连续抖动超过 900ms，就强制立刻扫一次。
  // IG 频繁重渲染（在线人数/时间戳/发送状态）会不停重置防抖、把扫描一直往后推，
  // 导致译文迟迟不出——你方刚发的消息尤其明显。封顶后最多等 900ms 必出。
  const wait = now - firstDirtyAt > 900 ? 0 : 300;
  scanTimer = setTimeout(() => {
    firstDirtyAt = 0;
    scanMessages();
  }, wait);
}

createButton();
scheduleScan();
// 进页面后消息常常是延迟渲染的：补几次扫描，避免「要手动触发（开侧边栏/滚动）才翻译」。
[800, 1600, 3000, 5000].forEach((ms) => setTimeout(() => scanMessages(), ms));

// IG 是单页应用，切换会话只改 URL 不刷新页面：监听 URL 变化后重扫。
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    scheduleScan();
    [600, 1400].forEach((ms) => setTimeout(() => scanMessages(), ms));
  }
}, 700);

const observer = new MutationObserver(scheduleScan);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true
});

document.addEventListener("scroll", scheduleScan, true);
window.addEventListener("focus", scheduleScan);
window.addEventListener("resize", scheduleScan);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleScan();
});

setInterval(() => scanMessages(), 1800);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_SELECTED_TEXT") {
    sendResponse({ text: selectedText() });
  }
  if (message?.type === "KOL_GET_CONVERSATION_TITLE") {
    const h1 = document.querySelector("main h1, header h1, [role='main'] h1");
    const title = h1?.innerText?.trim() || document.title.replace(/\s*[·|·].*$/, "").replace(/\s*- Instagram.*$/i, "").trim() || "";
    sendResponse({ title });
  }
});
