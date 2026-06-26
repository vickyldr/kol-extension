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

document.documentElement.dataset.kolAssistantVersion = "0.5.8";

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

  const rect = element.getBoundingClientRect();
  // 宽度上限按窗口自适应：全屏 IG 气泡也可能很宽，固定 650px 会把它们全过滤掉，
  // 导致「不开侧边栏（挤窄页面）就不翻译」。
  const maxWidth = Math.min(Math.max(window.innerWidth * 0.85, 650), 1100);
  if (rect.width < 20 || rect.height < 10 || rect.width > maxWidth) return false;
  if (rect.bottom < 0 || rect.top > window.innerHeight * 1.5) return false;
  // 不再按左右位置过滤：会话列表预览也一起翻译，避免私信里漏翻。
  if (rect.top < 70) return false;
  // 不再跳过「我方发出」的消息：外语消息无论谁发都翻译（中文消息已被
  // isForeignMessage 过滤掉，不会被误翻），方便核对自己发出去的外语话术。

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
  const anchorRect = anchor.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  wrapper.style.setProperty(
    "--kol-translation-indent",
    `${Math.max(0, anchorRect.left - rowRect.left)}px`
  );
  wrapper.style.setProperty(
    "--kol-translation-width",
    `${Math.min(Math.max(anchorRect.width, 180), 520)}px`
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
    if (translated >= 8) break;
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
function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scanMessages(), 450);
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
});
