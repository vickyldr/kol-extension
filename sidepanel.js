let API_BASE = "http://106.54.206.174:3210";
let API_TOKEN = "";
let API_ADMIN = "";
let API_INSID = ""; // 用户 ins id：云端自动备份的身份钥匙 + 提醒认人
let API_PRODUCT = ""; // 用户负责的产品：现在统一存在服务器设置里
let API_STAFF = ""; // 用户姓名（员工名）：随备份上云，管理后台显示「谁对接的」

// 给受保护的接口附带团队口令。
function authHeaders(base = {}) {
  return API_TOKEN ? { ...base, "X-KOL-Token": API_TOKEN } : base;
}

// 编辑/删除话术等管理员操作，额外附带管理员口令。
function adminHeaders(base = {}) {
  const headers = authHeaders(base);
  return API_ADMIN ? { ...headers, "X-KOL-Admin": API_ADMIN } : headers;
}

function isAdminUser() {
  return Boolean(API_ADMIN);
}

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get("kolConfig");
    if (stored.kolConfig) {
      API_BASE = stored.kolConfig.apiBase || API_BASE;
      API_TOKEN = stored.kolConfig.token || "";
      API_ADMIN = stored.kolConfig.adminToken || "";
      API_INSID = stored.kolConfig.insId || "";
      API_PRODUCT = stored.kolConfig.product || "";
      API_STAFF = stored.kolConfig.staffName || "";
    }
  } catch {
    // 读取失败时沿用默认本机地址。
  }
}

const messageInput = document.getElementById("message");
const replyIntentInput = document.getElementById("reply-intent");
const contextInput = document.getElementById("context");
const operatorGoalInput = document.getElementById("operator-goal");
const productSelect = document.getElementById("product");
const result = document.getElementById("result");
const emptyState = document.getElementById("empty-state");
const errorBox = document.getElementById("request-error");
const statusButton = document.getElementById("service-status");
const replyTargetInput = document.getElementById("reply-target");
const replyChineseInput = document.getElementById("reply-zh");
const replyLanguageSelect = document.getElementById("reply-language");
const archivePanel = document.getElementById("archive-panel");
const archiveList = document.getElementById("archive-list");
const archiveSearch = document.getElementById("archive-search");
const saveDialog = document.getElementById("save-dialog");
const panelReactive = document.getElementById("panel-reactive");

// 选话术（多语言话术库）相关元素
const playbookDialog = document.getElementById("playbook-dialog");
const playbookProduct = document.getElementById("playbook-product");
const playbookStage = document.getElementById("playbook-stage");
const playbookSearch = document.getElementById("playbook-search");
const playbookList = document.getElementById("playbook-list");
const PRODUCT_LABEL = {
  rythmix: "Rythmix",
  recco: "Recco",
  vivavideo: "VivaVideo",
  vivacut: "VivaCut",
  aicatch: "AICatch",
  通用: "通用（所有产品）"
};
const ALL_PRODUCTS = ["rythmix", "recco", "vivavideo", "vivacut", "aicatch", "通用"];
let PRODUCT_MAP = {}; // id -> 完整产品对象（含 selling_points），loadProducts 填充
// 当前选的产品有没有填卖点（generic 不算；填了就不提示）
function productNeedsSellingPoints() {
  const p = PRODUCT_MAP[productSelect && productSelect.value];
  if (!p || p.id === "generic") return false;
  return !(Array.isArray(p.selling_points) && p.selling_points.length);
}

const assetsPanel = document.getElementById("assets-panel");
const assetsProduct = document.getElementById("assets-product");
const assetForm = document.getElementById("asset-form");
const assetsList = document.getElementById("assets-list");
let assets = [];

let serviceOnline = false;
let waitTimer = null;
let lastAnalysis = null;
let archiveSearchTimer = null;
let pendingSave = null;
let playbook = [];
let playbookTarget = "reactive";

async function loadPendingMessage() {
  const stored = await chrome.storage.session.get([
    "pendingMessage",
    "selectedProduct"
  ]);
  if (stored.pendingMessage) {
    messageInput.value = stored.pendingMessage;
    await chrome.storage.session.remove("pendingMessage");
  }
  if (stored.selectedProduct) productSelect.value = stored.selectedProduct;
}

async function readSelectionFromPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return "";
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_SELECTED_TEXT"
    });
    return response?.text || "";
  } catch {
    return "";
  }
}

async function loadProducts() {
  if (!serviceOnline) return;
  try {
    const response = await fetch(`${API_BASE}/api/products`, {
      headers: authHeaders()
    });
    const products = await response.json();
    PRODUCT_MAP = {};
    const selected = productSelect.value;
    productSelect.replaceChildren();
    for (const product of products) {
      PRODUCT_MAP[product.id] = product; // 存全量(含 selling_points)，供"卖点没填"提示用
      const option = document.createElement("option");
      option.value = product.id;
      option.textContent = `${product.name}${product.status === "example" ? "（示例）" : ""}`;
      productSelect.appendChild(option);
    }
    // 优先用「服务器设置」里保存的产品（API_PRODUCT），其次沿用当前选择。
    productSelect.value = API_PRODUCT || selected || "generic";
  } catch {
    // Keep the generic local option.
  }
}

// 产品改了就持久化进 kolConfig（产品现在跟口令/ins id 一样存在服务器设置里）。
if (productSelect) {
  productSelect.addEventListener("change", async () => {
    API_PRODUCT = productSelect.value || "generic";
    const stored = (await chrome.storage.local.get("kolConfig")).kolConfig || {};
    await chrome.storage.local.set({ kolConfig: { ...stored, product: API_PRODUCT } });
    await syncReminderIdentity();
    refreshSetupBanner();
  });
}

async function checkService() {
  statusButton.textContent = "检测中";
  statusButton.className = "status";
  try {
    const response = await fetch(`${API_BASE}/health`);
    const health = await response.json();
    // 验证团队口令是否正确（/health 不校验口令，需另探一个受保护接口）。
    const probe = await fetch(`${API_BASE}/api/products`, {
      headers: authHeaders()
    });
    if (probe.status === 401) {
      serviceOnline = false;
      statusButton.textContent = "口令不正确";
      statusButton.className = "status offline";
      statusButton.title = "团队口令与服务器不一致，请在「服务器设置」里更正";
      return;
    }
    serviceOnline = response.ok && health.ok;
    statusButton.textContent = health.ai_configured ? "千问已连接" : "待配置 Key";
    statusButton.className = `status ${health.ai_configured ? "online" : "offline"}`;
    statusButton.title = `${health.provider} · ${health.model}`;
    await loadProducts();
    await loadPlaybook();
    await loadAssets();
  } catch {
    serviceOnline = false;
    statusButton.textContent = "AI 未启动";
    statusButton.className = "status offline";
    statusButton.title = "无法连接服务器，请检查「⚙️ 服务器设置」中的地址和团队口令";
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || "—";
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value || "";
}

function renderInternalGuidance(guidance = {}) {
  const card = document.getElementById("internal-guidance");
  const level = guidance.level || "info";
  card.className = `internal-card ${level}`;
  setText(
    "internal-level",
    level === "block"
      ? "必须询问 TL"
      : level === "confirm"
        ? "建议询问 TL"
        : "内部操作提醒"
  );
  setText("internal-explanation", guidance.explanation);

  const questionBox = document.getElementById("tl-question-box");
  setText("tl-question", guidance.question_for_tl);
  questionBox.classList.toggle("hidden", !guidance.question_for_tl);

  const temporaryBox = document.getElementById("temporary-reply-box");
  setText("temporary-reply-target", guidance.temporary_reply_target);
  setText("temporary-reply-chinese", guidance.temporary_reply_chinese);
  temporaryBox.classList.toggle(
    "hidden",
    !guidance.temporary_reply_target
  );

  const reminders = document.getElementById("operator-reminders");
  reminders.replaceChildren();
  for (const item of guidance.operator_reminders || []) {
    const li = document.createElement("li");
    li.textContent = item;
    reminders.appendChild(li);
  }
}

// 把一次分析渲染进顶部「🧠 AI 理解」块（阶段 / 下一步 / 风险），并兜底填双语回复。
function renderAnalysis(analysis) {
  lastAnalysis = analysis;
  const guidance = analysis.internal_guidance || {};
  const nextStep = guidance.explanation || guidance.question_for_tl || "—";
  setText("ai-u-stage", analysis.stage);
  setText("ai-u-nextstep", String(nextStep).slice(0, 200));
  setText("ai-u-risk", analysis.risk_warning);
  showAiUnderstanding();
  // 回复由快接口(/api/reply)负责并渲染到分屏；这里只在回复还空着时兜底填上。
  if (analysis.reply_target && !replyTargetInput.value) {
    setValue("reply-target", analysis.reply_target);
    setValue("reply-zh", analysis.reply_chinese);
    renderBilingualSplit(analysis.reply_target, analysis.reply_chinese);
    emptyState.classList.add("hidden");
    result.classList.remove("hidden");
  }
}

// 显示 AI 理解块（展开），并停掉转圈。
function showAiUnderstanding() {
  const block = document.getElementById("ai-understanding");
  if (!block) return;
  block.classList.remove("hidden");
  block.open = true;
  document.getElementById("ai-u-loading")?.classList.add("hidden");
}

// ===== 🧠 AI 理解：打开对话后自动跑；缓存先显示、内容变了才重算（省 token） =====
const AI_U_STORE = "kolUnderstanding";
let aiUnderstandKey = "";

function aiUSig(messages) {
  return (messages || []).slice(-8).map((m) => `${m.from}:${m.text}`).join("|");
}

function fillAiU(u) {
  setText("ai-u-stage", u.stage);
  setText("ai-u-nextstep", u.nextStep);
  setText("ai-u-risk", u.risk);
  showAiUnderstanding();
}

async function getActiveConversation() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return await chrome.tabs.sendMessage(tab.id, { type: "KOL_GET_CONVERSATION" });
  } catch {
    return null;
  }
}

// 打开对话后自动跑：先用缓存秒显示，签名变了（红人发新消息）才重新调 /api/analyze。
async function maybeRunUnderstanding() {
  const conv = await getActiveConversation();
  if (!conv) return;
  const key = conv.key || conv.tid || "";
  const msgs = (conv.messages && conv.messages.length) ? conv.messages : (conv.currentMessages || []);
  if (!key || !msgs.length) return;
  aiUnderstandKey = key;
  const sig = aiUSig(msgs);
  const store = (await chrome.storage.local.get(AI_U_STORE))[AI_U_STORE] || {};
  const cached = store[key];
  if (cached) fillAiU(cached); // 缓存先显示，零等待
  if (!serviceOnline || (cached && cached.sig === sig)) return; // 没变就不重算

  const block = document.getElementById("ai-understanding");
  if (block) block.classList.remove("hidden");
  document.getElementById("ai-u-loading")?.classList.remove("hidden");
  try {
    const convText = msgs
      .map((m) => `${m.from === "me" ? "我" : (m.name || "对方")}: ${m.text}`)
      .join("\n");
    const lastCreator = [...msgs].reverse().find((m) => m.from !== "me");
    const resp = await fetch(`${API_BASE}/api/analyze`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        message: lastCreator?.text || "",
        context: convText,
        productId: productSelect.value,
        channel: "Instagram"
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!resp.ok) return;
    const a = await resp.json();
    if (a.error) return;
    const g = a.internal_guidance || {};
    const u = {
      sig,
      stage: a.stage || "—",
      nextStep: String(g.explanation || g.question_for_tl || "—").slice(0, 200),
      risk: a.risk_warning || "—"
    };
    if (aiUnderstandKey !== key) return; // 期间又切了对话，丢弃这次结果
    store[key] = u;
    await chrome.storage.local.set({ [AI_U_STORE]: store });
    fillAiU(u);
  } catch {
    // 网络失败静默；缓存（若有）已经显示
  } finally {
    document.getElementById("ai-u-loading")?.classList.add("hidden");
  }
}

// 切换 / 刷新 IG 标签页时自动重判（防抖）。
let aiUnderstandTimer = null;
function scheduleUnderstanding(delay = 600) {
  clearTimeout(aiUnderstandTimer);
  aiUnderstandTimer = setTimeout(maybeRunUnderstanding, delay);
}
if (chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(() => scheduleUnderstanding(400));
}
if (chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (tab?.active && (info.url || info.status === "complete")) scheduleUnderstanding(900);
  });
}
window.addEventListener("focus", () => scheduleUnderstanding(300));

// 把一段文字按句切分（中英标点 + 换行），用于左右分屏逐句对齐
function splitSentences(s) {
  return String(s || "")
    .split(/(?<=[。.!?！？；;\n])/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// 渲染「外语 | 中文」左右分屏。一行＝一句，悬停整行两边对应高亮；
// 外语可直接改；点「复制」只拿这一句外语；点中文把整行标记住，方便挑句。
function renderBiRows(pairs) {
  const box = document.getElementById("bi-split");
  if (!box) return;
  box.replaceChildren();
  pairs.forEach((p) => {
    const row = document.createElement("div");
    row.className = "bi-row";
    // 外语：只读（你不懂外语，不在这改）。点一下把整行标记住，方便挑句。
    const left = document.createElement("div");
    left.className = "bi-cell bi-target";
    left.textContent = p.target || "";
    left.addEventListener("click", () => {
      const on = row.classList.contains("bi-picked");
      box.querySelectorAll(".bi-row.bi-picked").forEach((r) => r.classList.remove("bi-picked"));
      if (!on) row.classList.add("bi-picked");
    });
    // 中文：可改（你要改就改这边）。改完点「按中文改写外语」让 AI 重新生成。
    const right = document.createElement("div");
    right.className = "bi-cell bi-zh";
    right.contentEditable = "true";
    right.spellcheck = false;
    right.textContent = p.chinese || "";
    right.addEventListener("input", syncChineseFromSplit);
    // 单句复制：只想用其中一句外语时，直接复制这一句
    const copy = document.createElement("button");
    copy.className = "bi-copy";
    copy.type = "button";
    copy.title = "复制这一句外语";
    copy.textContent = "复制";
    copy.addEventListener("click", async () => {
      box.querySelectorAll(".bi-row.bi-picked").forEach((r) => r.classList.remove("bi-picked"));
      row.classList.add("bi-picked");
      await navigator.clipboard.writeText(left.textContent.trim());
      copy.textContent = "已复制";
      setTimeout(() => { copy.textContent = "复制"; }, 1000);
    });
    row.append(left, right, copy);
    box.appendChild(row);
  });
}

// 中文格被编辑后，把整条中文同步回隐藏载体（供「按中文改写」用）
function syncChineseFromSplit() {
  const cells = document.querySelectorAll("#bi-split .bi-zh");
  const joined = Array.from(cells)
    .map((c) => c.textContent.trim())
    .filter(Boolean)
    .join(" ");
  replyChineseInput.value = joined;
}

// 按（你改过的）中文重新改写外语回复——是「改写」不是直译，再自动逐句对齐。
async function rewriteFromChinese() {
  syncChineseFromSplit();
  const zh = replyChineseInput.value.trim();
  if (!zh) return;
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const btn = document.getElementById("rewrite-from-zh");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "改写中…";
  errorBox.classList.add("hidden");
  const redText = messageInput.value.trim();
  // 回复语言：有原文让服务端识别；没原文先扫对话窗口/读设置，都没有就弹窗让运营选。
  const lang = await resolveReplyLanguage(redText);
  if (lang === null) { btn.disabled = false; btn.textContent = orig; return; }
  try {
    const body = await postRewrite({
      direction: "chinese_to_target",
      message: redText,
      context: redText,
      productId: productSelect.value,
      replyLanguage: lang,
      replyChinese: zh
    });
    replyTargetInput.value = body.reply_target || "";
    replyChineseInput.value = body.reply_chinese || zh;
    renderBilingualSplit(replyTargetInput.value, replyChineseInput.value);
  } catch (e) {
    errorBox.textContent = e.name === "TimeoutError" ? "超时，请重试。" : e.message;
    errorBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function renderBilingualSplit(target, chinese) {
  const box = document.getElementById("bi-split");
  if (!box) return;
  // 先用按标点的快速切分即时显示（瞬间出来），随后自动逐句对齐替换成可信版本
  const ts = splitSentences(target);
  const zs = splitSentences(chinese);
  const n = Math.max(ts.length, zs.length, 1);
  const pairs = [];
  for (let i = 0; i < n; i += 1) pairs.push({ target: ts[i] || "", chinese: zs[i] || "" });
  renderBiRows(pairs);
  autoAlignSplit(target, chinese);
}

// 自动逐句对齐：让 AI 把外语回复逐句拆开并配准确中文，保证一句对一句（不用按按钮）。
let alignSeq = 0;
async function autoAlignSplit(target, chinese) {
  if (!serviceOnline || !String(target || "").trim()) return;
  const myReq = ++alignSeq;
  try {
    const r = await fetch(`${API_BASE}/api/align`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ replyTarget: target, replyChinese: chinese }),
      signal: AbortSignal.timeout(45000)
    });
    const b = await r.json();
    if (!r.ok || myReq !== alignSeq) return; // 回复已被新生成替换 → 丢弃过期对齐
    const box = document.getElementById("bi-split");
    if (box && box.contains(document.activeElement)) return; // 用户正在改外语，别打断
    const pairs = (b.pairs || []).filter((p) => p.target);
    if (pairs.length) renderBiRows(pairs);
  } catch (e) {
    /* 对齐失败就保留快速切分版本 */
  }
}

// 外语格被编辑后，把整条外语回复同步回隐藏数据载体（供复制/保存/改写）
function syncTargetFromSplit() {
  const cells = document.querySelectorAll("#bi-split .bi-target");
  const joined = Array.from(cells)
    .map((c) => c.textContent.trim())
    .filter(Boolean)
    .join(" ");
  replyTargetInput.value = joined;
  if (lastAnalysis) lastAnalysis.reply_target = joined;
}

function renderArchive(records) {
  archiveList.replaceChildren();
  if (!records.length) {
    const empty = document.createElement("p");
    empty.className = "archive-meta";
    empty.textContent = "还没有保存过确认话术。";
    archiveList.appendChild(empty);
    return;
  }
  for (const record of records) {
    archiveList.appendChild(buildArchiveItem(record));
  }
}

function buildArchiveItem(record) {
  const item = document.createElement("article");
  item.className = "archive-item";

  const title = document.createElement("h3");
  title.textContent = record.scene_name;
  const meta = document.createElement("p");
  meta.className = "archive-meta";
  meta.textContent = `${record.product_id} · ${record.stage || "未分类"} · v${record.version}`;
  const understanding = document.createElement("p");
  understanding.textContent = record.correct_understanding || "暂无理解说明";
  const target = document.createElement("p");
  target.textContent = record.external_reply_target
    ? `外语：${record.external_reply_target}`
    : "暂无外语回复";
  const reply = document.createElement("p");
  reply.textContent = record.external_reply_chinese
    ? `中文：${record.external_reply_chinese}`
    : "暂无中文回复";
  item.append(title, meta, understanding, target, reply);

  // 只有管理员（本地填了管理员口令）才显示编辑/删除。
  if (isAdminUser()) {
    const actions = document.createElement("div");
    actions.className = "archive-item-actions";
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "secondary";
    editBtn.textContent = "编辑";
    editBtn.addEventListener("click", () => enterArchiveEdit(item, record));
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "archive-delete";
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", () => deleteArchiveRecord(record));
    actions.append(editBtn, delBtn);
    item.appendChild(actions);
  }
  return item;
}

function enterArchiveEdit(item, record) {
  item.replaceChildren();
  item.classList.add("editing");

  const mkField = (labelText, value, rows) => {
    const label = document.createElement("label");
    label.textContent = labelText;
    const field = rows
      ? document.createElement("textarea")
      : document.createElement("input");
    if (rows) field.rows = rows;
    field.value = value || "";
    item.append(label, field);
    return field;
  };

  const nameField = mkField("场景名称", record.scene_name, 0);
  const targetField = mkField("外语回复", record.external_reply_target, 4);
  const chineseField = mkField("中文回复", record.external_reply_chinese, 4);
  const notesField = mkField("运营备注", record.notes, 2);

  const actions = document.createElement("div");
  actions.className = "archive-item-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "保存修改";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () =>
    item.replaceWith(buildArchiveItem(record))
  );
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      await saveArchiveEdit(record, {
        scene_name: nameField.value.trim() || record.scene_name,
        external_reply_target: targetField.value.trim(),
        external_reply_chinese: chineseField.value.trim(),
        notes: notesField.value.trim()
      });
      await loadArchive(archiveSearch.value.trim());
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存修改";
      const tip = document.createElement("p");
      tip.className = "request-error";
      tip.textContent = error.message;
      item.appendChild(tip);
    }
  });
  actions.append(saveBtn, cancelBtn);
  item.appendChild(actions);
}

// 编辑时保留未改动的字段，带管理员口令提交（沿用同一 id 即为更新）。
async function saveArchiveEdit(record, changes) {
  const response = await fetch(`${API_BASE}/api/archive`, {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      id: record.id,
      status: record.status,
      product_id: record.product_id,
      stage: record.stage,
      trigger_examples: record.trigger_examples,
      correct_understanding: record.correct_understanding,
      internal_guidance: record.internal_guidance,
      required_variables: record.required_variables,
      ...changes
    })
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      body.code === "FORBIDDEN"
        ? "没有编辑权限，请确认管理员口令填写正确。"
        : body.error || "保存修改失败。"
    );
  }
}

async function deleteArchiveRecord(record) {
  if (!window.confirm(`确定删除话术「${record.scene_name}」？此操作不可撤销。`)) {
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/api/archive/delete`, {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: record.id })
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(
        body.code === "FORBIDDEN"
          ? "没有删除权限，请确认管理员口令填写正确。"
          : body.error || "删除失败。"
      );
    }
    await loadArchive(archiveSearch.value.trim());
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
}

async function loadArchive(query = "") {
  if (!serviceOnline) return;
  const url = new URL(`${API_BASE}/api/archive`);
  if (query) url.searchParams.set("q", query);
  const response = await fetch(url, { headers: authHeaders() });
  const records = await response.json();
  if (!response.ok) throw new Error(records.error || "读取存档失败");
  renderArchive(records);
}

// 收集板块 A（红人来消息）当前要保存的内容。
function reactiveSaveCtx() {
  return {
    productId: productSelect.value,
    target: replyTargetInput.value.trim(),
    chinese: replyChineseInput.value.trim(),
    sceneName: lastAnalysis
      ? lastAnalysis.matched_source === "新场景"
        ? lastAnalysis.intent
        : lastAnalysis.matched_source || ""
      : "",
    stage: lastAnalysis?.stage || "",
    trigger: messageInput.value.trim(),
    understanding: lastAnalysis
      ? [lastAnalysis.literal_chinese, lastAnalysis.implied_meaning]
          .filter(Boolean)
          .join("；")
      : "",
    internal_guidance: lastAnalysis?.internal_guidance || {},
    required_variables: lastAnalysis?.required_variables || []
  };
}


function openSaveDialog(ctx) {
  if (!ctx || (!ctx.target && !ctx.chinese)) {
    errorBox.textContent = "请先生成或填写一条回复，再保存为话术。";
    errorBox.classList.remove("hidden");
    return;
  }
  pendingSave = ctx;
  document.getElementById("scene-name").value = ctx.sceneName || "";
  document.getElementById("scene-notes").value = "";
  document.getElementById("preview-target").textContent = ctx.target || "—";
  document.getElementById("preview-chinese").textContent = ctx.chinese || "—";
  saveDialog.showModal();
}

async function saveCurrentScenario() {
  if (!pendingSave) return;
  const sceneName = document.getElementById("scene-name").value.trim();
  if (!sceneName) return;

  const response = await fetch(`${API_BASE}/api/archive`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      product_id: pendingSave.productId,
      scene_name: sceneName,
      stage: pendingSave.stage,
      trigger_examples: pendingSave.trigger ? [pendingSave.trigger] : [],
      correct_understanding: pendingSave.understanding,
      external_reply_target: pendingSave.target,
      external_reply_chinese: pendingSave.chinese,
      internal_guidance: pendingSave.internal_guidance,
      required_variables: pendingSave.required_variables,
      notes: document.getElementById("scene-notes").value.trim()
    })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "保存失败");
  saveDialog.close();
  archivePanel.classList.remove("hidden");
  await loadArchive();
}

async function postRewrite(payload) {
  const response = await fetch(`${API_BASE}/api/rewrite`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(65000)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "双语回复生成失败。");
  return body;
}

// 改写/生成（合并原来的「润色生成」「让 AI 改这条」）：
// 有回复就按你写的改；还没回复就把你写的当中文意图生成双语。结果更新到上方分屏。
async function rewriteGo() {
  const box = document.getElementById("rewrite-box");
  const text = box.value.trim();
  if (!text) { box.focus(); return; }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const button = document.getElementById("rewrite-go");
  const status = document.getElementById("rewrite-status");
  const orig = button.textContent;
  button.disabled = true;
  button.textContent = "AI 处理中…";
  status.classList.add("hidden");
  status.classList.remove("error");
  try {
    const hasReply = replyTargetInput.value.trim();
    const body = await postRewrite({
      direction: hasReply ? "refine" : "chinese_to_target",
      message: messageInput.value.trim(),
      context: contextInput.value.trim(),
      operatorGoal: operatorGoalInput.value.trim(),
      productId: productSelect.value,
      detectedLanguage: lastAnalysis?.detected_language || "",
      replyLanguage: replyLanguageSelect?.value || "",
      replyTarget: replyTargetInput.value.trim(),
      replyChinese: hasReply ? replyChineseInput.value.trim() : text,
      modification: text
    });
    replyTargetInput.value = body.reply_target || replyTargetInput.value;
    replyChineseInput.value = body.reply_chinese || replyChineseInput.value;
    renderBilingualSplit(replyTargetInput.value, replyChineseInput.value);
    if (lastAnalysis) {
      lastAnalysis.reply_target = replyTargetInput.value;
      lastAnalysis.reply_chinese = replyChineseInput.value;
    }
    box.value = "";
    status.textContent = "已更新 ↑";
    status.classList.remove("hidden", "error");
  } catch (error) {
    status.textContent = error.name === "TimeoutError" ? "超时，请重试。" : error.message;
    status.classList.remove("hidden");
    status.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = orig;
  }
}

// 板块 A 的改写：中文意图→双语，或外语→中文校对。
async function rewriteReply(direction) {
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }

  const button =
    direction === "target_to_chinese"
      ? document.getElementById("translate-to-chinese")
      : direction === "faithful"
        ? document.getElementById("faithful-from-chinese")
        : document.getElementById("generate-from-chinese");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent =
    direction === "chinese_to_target" ? "正在生成双语回复…" : "正在翻译…";
  errorBox.classList.add("hidden");

  try {
    const body = await postRewrite({
      direction,
      message: messageInput.value.trim(),
      context: contextInput.value.trim(),
      operatorGoal: operatorGoalInput.value.trim(),
      productId: productSelect.value,
      detectedLanguage: lastAnalysis?.detected_language || "",
      replyLanguage: replyLanguageSelect?.value || "",
      replyTarget: replyTargetInput.value.trim(),
      replyChinese: replyChineseInput.value.trim()
    });
    replyTargetInput.value = body.reply_target || replyTargetInput.value;
    replyChineseInput.value = body.reply_chinese || replyChineseInput.value;

    if (lastAnalysis) {
      lastAnalysis.reply_target = replyTargetInput.value;
      lastAnalysis.reply_chinese = replyChineseInput.value;
    }
  } catch (error) {
    errorBox.textContent =
      error.name === "TimeoutError" ? "生成超时，请稍后重试。" : error.message;
    errorBox.classList.remove("hidden");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

// 板块 A 的“让 AI 改这条”：在当前回复基础上按修改要求迭代。
async function refineReply() {
  const refineInput = document.getElementById("refine-input");
  const modification = refineInput.value.trim();
  if (!modification) {
    refineInput.focus();
    return;
  }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const button = document.getElementById("refine-reply");
  const refineStatus = document.getElementById("refine-status");
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "正在修改…";
  refineStatus.classList.add("hidden");
  refineStatus.classList.remove("error");
  try {
    const body = await postRewrite({
      direction: "refine",
      message: messageInput.value.trim(),
      context: contextInput.value.trim(),
      productId: productSelect.value,
      detectedLanguage: lastAnalysis?.detected_language || "",
      replyLanguage: replyLanguageSelect?.value || "",
      replyTarget: replyTargetInput.value.trim(),
      replyChinese: replyChineseInput.value.trim(),
      modification
    });
    replyTargetInput.value = body.reply_target || replyTargetInput.value;
    replyChineseInput.value = body.reply_chinese || replyChineseInput.value;
    if (lastAnalysis) {
      lastAnalysis.reply_target = replyTargetInput.value;
      lastAnalysis.reply_chinese = replyChineseInput.value;
    }
    refineInput.value = "";
    refineStatus.textContent = "已按你的要求改好 ↑ 见上方「外语/中文回复」。";
    refineStatus.classList.remove("hidden", "error");
    // 把更新后的外语回复滚动到视野，避免“看不到生成”。
    replyTargetInput.scrollIntoView({ behavior: "smooth", block: "center" });
    replyTargetInput.classList.add("flash");
    setTimeout(() => replyTargetInput.classList.remove("flash"), 1200);
  } catch (error) {
    refineStatus.textContent =
      error.name === "TimeoutError" ? "修改超时，请稍后重试。" : error.message;
    refineStatus.classList.remove("hidden");
    refineStatus.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

// 逐句对照：把当前外语回复按句拆开，每句给中文对照，方便核对哪句翻错。
async function alignReplyAction() {
  const alignBtn = document.getElementById("align-reply");
  const alignList = document.getElementById("align-list");
  const target = replyTargetInput.value.trim();
  if (!target) {
    replyTargetInput.focus();
    return;
  }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const orig = alignBtn.textContent;
  alignBtn.disabled = true;
  alignBtn.textContent = "对照中…";
  try {
    const response = await fetch(`${API_BASE}/api/align`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        replyTarget: target,
        replyChinese: replyChineseInput.value.trim()
      }),
      signal: AbortSignal.timeout(65000)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "对照失败。");
    alignList.replaceChildren();
    if ((body.pairs || []).length) {
      const head = document.createElement("div");
      head.className = "align-row align-head";
      const ht = document.createElement("p");
      ht.className = "align-target";
      ht.textContent = "外语";
      const hc = document.createElement("p");
      hc.className = "align-chinese";
      hc.textContent = "中文对照";
      const hk = document.createElement("p");
      hk.className = "align-copy-head";
      hk.textContent = "单句";
      head.append(ht, hc, hk);
      alignList.appendChild(head);
    }
    for (let i = 0; i < (body.pairs || []).length; i += 1) {
      const p = body.pairs[i];
      const row = document.createElement("div");
      row.className = "align-row";
      const t = document.createElement("p");
      t.className = "align-target";
      t.textContent = `${i + 1}. ${p.target}`;
      const c = document.createElement("p");
      c.className = "align-chinese";
      c.textContent = p.chinese;
      // 单句复制：只想用其中一句时，直接复制这一句外语
      const copyBtn = document.createElement("button");
      copyBtn.className = "align-copy secondary";
      copyBtn.type = "button";
      copyBtn.textContent = "复制";
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(p.target || "");
        copyBtn.textContent = "已复制";
        setTimeout(() => { copyBtn.textContent = "复制"; }, 1000);
      });
      row.append(t, c, copyBtn);
      alignList.appendChild(row);
    }
  } catch (error) {
    alignList.replaceChildren();
    const tip = document.createElement("p");
    tip.className = "request-error";
    tip.textContent =
      error.name === "TimeoutError" ? "对照超时，请重试。" : error.message;
    alignList.appendChild(tip);
  } finally {
    alignBtn.disabled = false;
    alignBtn.textContent = orig;
  }
}

// 手动新增话术（所有成员可用）：空白表单直接填写并保存为新话术。
function openNewArchiveForm() {
  const box = document.getElementById("new-archive-form");
  box.classList.remove("hidden");
  box.replaceChildren();

  const card = document.createElement("article");
  card.className = "archive-item editing";

  const heading = document.createElement("h3");
  heading.textContent = "手动新增话术";
  card.appendChild(heading);

  const mkField = (labelText, rows, placeholder) => {
    const label = document.createElement("label");
    label.textContent = labelText;
    const field = rows
      ? document.createElement("textarea")
      : document.createElement("input");
    if (rows) field.rows = rows;
    if (placeholder) field.placeholder = placeholder;
    card.append(label, field);
    return field;
  };

  const nameField = mkField("场景名称", 0, "例如：催初稿（礼貌版）");
  const targetField = mkField("外语回复", 4, "可留空");
  const chineseField = mkField("中文回复 / 说明", 4, "");
  const notesField = mkField("运营备注", 2, "适用条件、注意事项");

  const actions = document.createElement("div");
  actions.className = "archive-item-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "保存新话术";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => {
    box.replaceChildren();
    box.classList.add("hidden");
  });
  saveBtn.addEventListener("click", async () => {
    const sceneName = nameField.value.trim();
    if (!sceneName) {
      nameField.focus();
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      const response = await fetch(`${API_BASE}/api/archive`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          product_id: productSelect.value,
          scene_name: sceneName,
          external_reply_target: targetField.value.trim(),
          external_reply_chinese: chineseField.value.trim(),
          notes: notesField.value.trim()
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "保存失败。");
      box.replaceChildren();
      box.classList.add("hidden");
      await loadArchive(archiveSearch.value.trim());
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存新话术";
      const tip = document.createElement("p");
      tip.className = "request-error";
      tip.textContent = error.message;
      card.appendChild(tip);
    }
  });
  actions.append(saveBtn, cancelBtn);
  card.appendChild(actions);
  box.appendChild(card);
}

// 导入：上传导出过的 JSON，逐条作为新话术加入（去掉 id 避免覆盖已有）。
async function handleImportFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    window.alert("这个文件不是有效的 JSON，请选择导出备份生成的文件。");
    return;
  }
  const records = Array.isArray(data) ? data : data.records || [];
  if (!records.length) {
    window.alert("文件里没有可导入的话术。");
    return;
  }
  let ok = 0;
  for (const r of records) {
    try {
      const response = await fetch(`${API_BASE}/api/archive`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          product_id: r.product_id || "generic",
          scene_name: r.scene_name || "导入话术",
          stage: r.stage || "",
          trigger_examples: r.trigger_examples || [],
          correct_understanding: r.correct_understanding || "",
          external_reply_target: r.external_reply_target || "",
          external_reply_chinese: r.external_reply_chinese || "",
          internal_guidance: r.internal_guidance || {},
          required_variables: r.required_variables || [],
          notes: r.notes || ""
        })
      });
      if (response.ok) ok += 1;
    } catch {
      // 单条失败跳过，继续导入其余。
    }
  }
  window.alert(`导入完成：成功 ${ok} / ${records.length} 条。`);
  await loadArchive(archiveSearch.value.trim());
}

async function loadPlaybook() {
  if (!serviceOnline) return;
  // 话术库 = 预置话术脚本(playbook) + 团队库(Word 导入落库的 knowledge-base)，合并成一份搜。
  let seed = [];
  let team = [];
  try {
    const r = await fetch(`${API_BASE}/api/playbook`, { headers: authHeaders() });
    const d = await r.json();
    seed = Array.isArray(d) ? d.map((e) => ({ ...e, _source: "话术脚本" })) : [];
  } catch { seed = []; }
  try {
    const r = await fetch(`${API_BASE}/api/knowledge`, { headers: authHeaders() });
    const d = await r.json();
    team = Array.isArray(d) ? d.map(knowledgeToPlaybook).filter(Boolean) : [];
  } catch { team = []; }
  playbook = [...team, ...seed];
}

// 把团队库一条记录 {scene, fields:{语言:文本}, product, region} 归一成话术库条目结构。
function knowledgeToPlaybook(rec) {
  if (!rec || typeof rec !== "object") return null;
  const fields = rec.fields && typeof rec.fields === "object" ? rec.fields : {};
  // 只保留值是「文本」的字段当多语言话术，过滤掉数组/对象等非话术字段。
  const texts = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "string" && v.trim()) texts[k] = v;
  }
  if (!Object.keys(texts).length) return null;
  return {
    name: rec.scene || "（未命名话术）",
    product: rec.product || "通用",
    stage: rec.region ? `团队库·${rec.region}` : "团队库",
    texts,
    _source: "团队库"
  };
}

function openPlaybookPicker(target) {
  playbookTarget = target;
  // 产品筛选：默认“全部产品”，避免只看到通用话术。
  const prods = [...new Set(playbook.map((e) => e.product))];
  playbookProduct.replaceChildren();
  const pAll = document.createElement("option");
  pAll.value = "";
  pAll.textContent = "全部产品";
  playbookProduct.appendChild(pAll);
  for (const p of prods) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = PRODUCT_LABEL[p] || p;
    playbookProduct.appendChild(o);
  }
  if (prods.includes(productSelect.value)) playbookProduct.value = productSelect.value;

  const stages = [...new Set(playbook.map((e) => e.stage))];
  playbookStage.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部阶段";
  playbookStage.appendChild(all);
  for (const s of stages) {
    const o = document.createElement("option");
    o.value = s;
    o.textContent = s;
    playbookStage.appendChild(o);
  }
  playbookSearch.value = "";
  renderPlaybookList();
  playbookDialog.showModal();
}

function renderPlaybookList() {
  const product = playbookProduct.value;
  const stage = playbookStage.value;
  const q = playbookSearch.value.trim().toLowerCase();
  const items = playbook.filter((e) => {
    // 选了具体产品时显示“该产品 + 通用”；选“通用”只看通用；不选则全部。
    if (product === "通用" && e.product !== "通用") return false;
    if (product && product !== "通用" && e.product !== product && e.product !== "通用") {
      return false;
    }
    if (stage && e.stage !== stage) return false;
    if (
      q &&
      !e.name.toLowerCase().includes(q) &&
      !JSON.stringify(e.texts).toLowerCase().includes(q)
    ) {
      return false;
    }
    return true;
  });
  playbookList.replaceChildren();
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "archive-meta";
    p.textContent = "没有匹配的话术。换个产品 / 阶段，或清空搜索再试。";
    playbookList.appendChild(p);
    return;
  }
  for (const e of items) playbookList.appendChild(buildPlaybookItem(e));
}

function buildPlaybookItem(entry) {
  const item = document.createElement("article");
  item.className = "archive-item";
  const h = document.createElement("h3");
  h.textContent = entry.name;
  const meta = document.createElement("p");
  meta.className = "archive-meta";
  const tag = entry._source ? `${entry._source} · ` : "";
  meta.textContent = `${tag}${entry.product} · ${entry.stage} · ${Object.keys(entry.texts).join(" / ")}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "secondary";
  btn.textContent = "选用";
  btn.addEventListener("click", () => expandPlaybookItem(item, entry));
  // 一键把这条话术搬进「我的快捷回复」（个人高频用，不喂 AI）。
  const toQuick = document.createElement("button");
  toQuick.type = "button";
  toQuick.className = "secondary";
  toQuick.textContent = "⭐ 存进快捷";
  toQuick.title = "复制到「我的快捷回复」，以后打字秒出（个人用，不喂 AI）";
  toQuick.addEventListener("click", async () => {
    const ok = await playbookEntryToQuick(entry);
    toQuick.textContent = ok ? "✓ 已进快捷" : "无可存内容";
    toQuick.disabled = true;
  });
  item.append(h, meta, btn, toQuick);
  return item;
}

// 把一条话术库条目 {name, texts:{语言:文本}} 存进个人快捷回复 kolQuickReplies。
async function playbookEntryToQuick(entry) {
  const texts = entry && entry.texts ? entry.texts : {};
  const langs = Object.keys(texts);
  if (!langs.length) return false;
  const zhKey = langs.find((l) => /中文|中$|^zh/i.test(l));
  const targetKey = langs.find((l) => l !== zhKey) || langs[0];
  const target = String(texts[targetKey] || "").trim();
  const chinese = zhKey ? String(texts[zhKey] || "").trim() : "";
  if (!target && !chinese) return false;
  const s = await chrome.storage.local.get("kolQuickReplies");
  const list = Array.isArray(s.kolQuickReplies) ? s.kolQuickReplies : [];
  list.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    trigger: entry.name || "",
    target,
    chinese,
    createdAt: new Date().toISOString()
  });
  await chrome.storage.local.set({ kolQuickReplies: list });
  return true;
}

function expandPlaybookItem(item, entry) {
  item.replaceChildren();
  const h = document.createElement("h3");
  h.textContent = entry.name;
  item.appendChild(h);

  const langs = Object.keys(entry.texts);
  let chosenLang = langs[0];

  const preview = document.createElement("div");
  preview.className = "playbook-preview";
  preview.textContent = entry.texts[chosenLang];

  const langRow = document.createElement("div");
  langRow.className = "playbook-langs";
  const chips = [];
  for (const l of langs) {
    const c = document.createElement("button");
    c.type = "button";
    c.className = `lang-chip${l === chosenLang ? " active" : ""}`;
    c.textContent = l;
    c.addEventListener("click", () => {
      chosenLang = l;
      chips.forEach((x) => x.classList.remove("active"));
      c.classList.add("active");
      preview.textContent = entry.texts[l];
    });
    chips.push(c);
    langRow.appendChild(c);
  }
  item.appendChild(langRow);

  const varInputs = {};
  if (entry.variables.length) {
    const vbox = document.createElement("div");
    vbox.className = "playbook-vars";
    for (const v of entry.variables) {
      const lab = document.createElement("label");
      lab.textContent = v;
      const inp = document.createElement("input");
      inp.placeholder = `填写${v}`;
      varInputs[v] = inp;
      vbox.append(lab, inp);
    }
    item.appendChild(vbox);
  }

  item.appendChild(preview);

  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "primary";
  apply.textContent = "用这条（填进回复框）";
  apply.addEventListener("click", () =>
    applyPlaybook(entry, chosenLang, varInputs)
  );
  const back = document.createElement("button");
  back.type = "button";
  back.className = "secondary";
  back.textContent = "返回";
  back.addEventListener("click", () => item.replaceWith(buildPlaybookItem(entry)));
  const actions = document.createElement("div");
  actions.className = "archive-item-actions";
  actions.append(apply, back);
  item.appendChild(actions);
}

function substituteVars(text, varInputs) {
  let t = text || "";
  for (const [k, inp] of Object.entries(varInputs)) {
    const val = inp.value.trim();
    if (!val) continue;
    t = t
      .split(`{{${k}}}`).join(val)
      .split(`【${k}】`).join(val)
      .split(`{${k}}`).join(val)
      .split(`[${k}]`).join(val);
    if (k === "价格") t = t.replace(/XXXX|XXX/g, val);
  }
  return t;
}

function applyPlaybook(entry, lang, varInputs) {
  const text = substituteVars(entry.texts[lang] || "", varInputs);
  const zh = substituteVars(entry.texts["中文"] || "", varInputs);
  replyTargetInput.value = text;
  replyChineseInput.value = lang === "中文" ? "" : zh;
  emptyState.classList.add("hidden");
  result.classList.remove("hidden");
  result.scrollIntoView({ behavior: "smooth", block: "start" });
  playbookDialog.close();
}

// ===================== 物料库 =====================
async function loadAssets() {
  if (!serviceOnline) return;
  try {
    const response = await fetch(`${API_BASE}/api/assets`, {
      headers: authHeaders()
    });
    const data = await response.json();
    assets = Array.isArray(data) ? data : [];
  } catch {
    assets = [];
  }
}

async function fetchAssetBlob(id) {
  const response = await fetch(`${API_BASE}/api/assets/file/${id}`, {
    headers: authHeaders()
  });
  if (!response.ok) throw new Error("图片加载失败");
  return response.blob();
}

function renderAssetsProductFilter() {
  const prods = [...new Set(assets.map((a) => a.product))];
  assetsProduct.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "全部产品";
  assetsProduct.appendChild(all);
  for (const p of prods) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = PRODUCT_LABEL[p] || p;
    assetsProduct.appendChild(o);
  }
}

function renderAssets() {
  const product = assetsProduct.value;
  assetsList.replaceChildren();
  const items = assets.filter((a) => !product || a.product === product);
  if (!items.length) {
    const p = document.createElement("p");
    p.className = "archive-meta";
    p.textContent = isAdminUser()
      ? "还没有物料，点右上「+ 上传物料」添加。"
      : "该产品暂无物料。";
    assetsList.appendChild(p);
    return;
  }
  for (const a of items) assetsList.appendChild(buildAssetItem(a));
}

function buildAssetItem(asset) {
  const item = document.createElement("article");
  item.className = "archive-item";
  const title = document.createElement("h3");
  const icon =
    asset.type === "image"
      ? "📷 "
      : asset.type === "video"
        ? "🎬 "
        : asset.type === "link"
          ? "🔗 "
          : "📝 ";
  title.textContent = icon + asset.name;
  const meta = document.createElement("p");
  meta.className = "archive-meta";
  meta.textContent = PRODUCT_LABEL[asset.product] || asset.product;
  item.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "archive-item-actions";

  if (asset.type === "image" || asset.type === "video") {
    const isVideo = asset.type === "video";
    const mediaWrap = document.createElement("div");
    item.appendChild(mediaWrap);

    let blob = null;
    let blobUrl = "";
    let expanded = false;
    async function ensureBlob() {
      if (!blob) {
        blob = await fetchAssetBlob(asset.id);
        blobUrl = URL.createObjectURL(blob);
      }
      return blob;
    }

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "secondary";
    viewBtn.textContent = isVideo ? "👁 查看视频" : "👁 查看图片";
    viewBtn.addEventListener("click", async () => {
      if (expanded) {
        mediaWrap.replaceChildren();
        expanded = false;
        viewBtn.textContent = isVideo ? "👁 查看视频" : "👁 查看图片";
        return;
      }
      viewBtn.disabled = true;
      viewBtn.textContent = "加载中…";
      try {
        await ensureBlob();
        mediaWrap.replaceChildren();
        const media = document.createElement(isVideo ? "video" : "img");
        if (isVideo) {
          media.className = "asset-video";
          media.controls = true;
        } else {
          media.className = "asset-thumb";
          media.alt = asset.name;
        }
        media.src = blobUrl;
        mediaWrap.appendChild(media);
        expanded = true;
        viewBtn.textContent = "收起";
      } catch {
        mediaWrap.textContent = "（加载失败）";
      } finally {
        viewBtn.disabled = false;
        if (!expanded && viewBtn.textContent === "加载中…") {
          viewBtn.textContent = isVideo ? "👁 查看视频" : "👁 查看图片";
        }
      }
    });

    const dl = document.createElement("button");
    dl.type = "button";
    dl.className = "secondary";
    dl.textContent = isVideo ? "下载视频" : "下载图片";
    dl.addEventListener("click", async () => {
      dl.disabled = true;
      try {
        await ensureBlob();
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `${asset.name}.${asset.ext || (isVideo ? "mp4" : "png")}`;
        link.click();
      } catch {
        dl.textContent = "下载失败";
      } finally {
        dl.disabled = false;
      }
    });
    actions.append(viewBtn, dl);

    if (!isVideo) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "secondary";
      copy.textContent = "复制图片";
      copy.addEventListener("click", async () => {
        try {
          await ensureBlob();
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type]: blob })
          ]);
          copy.textContent = "已复制";
          setTimeout(() => (copy.textContent = "复制图片"), 1000);
        } catch {
          copy.textContent = "改用下载";
        }
      });
      actions.append(copy);
    }
  } else if (asset.type === "link") {
    const url = document.createElement("p");
    url.className = "asset-url";
    url.textContent = asset.url;
    item.appendChild(url);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "复制链接";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(asset.url);
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制链接"), 1000);
    });
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary";
    open.textContent = "打开";
    open.addEventListener("click", () => window.open(asset.url, "_blank"));
    actions.append(copy, open);
  } else {
    const text = document.createElement("p");
    text.className = "asset-note";
    text.textContent = asset.text;
    item.appendChild(text);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "secondary";
    copy.textContent = "复制文字";
    copy.addEventListener("click", async () => {
      await navigator.clipboard.writeText(asset.text);
      copy.textContent = "已复制";
      setTimeout(() => (copy.textContent = "复制文字"), 1000);
    });
    actions.append(copy);
  }

  if (isAdminUser()) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "archive-delete";
    del.textContent = "删除";
    del.addEventListener("click", () => deleteAssetRecord(asset));
    actions.appendChild(del);
  }
  item.appendChild(actions);
  return item;
}

function openNewAssetForm() {
  assetForm.classList.remove("hidden");
  assetForm.replaceChildren();
  const card = document.createElement("article");
  card.className = "archive-item editing";

  const heading = document.createElement("h3");
  heading.textContent = "上传物料";
  card.appendChild(heading);

  const typeLabel = document.createElement("label");
  typeLabel.textContent = "类型";
  const typeSel = document.createElement("select");
  for (const [v, t] of [["image", "📷 图片"], ["video", "🎬 视频"], ["link", "🔗 链接"], ["note", "📝 文字说明"]]) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = t;
    typeSel.appendChild(o);
  }
  card.append(typeLabel, typeSel);

  const prodLabel = document.createElement("label");
  prodLabel.textContent = "所属产品";
  const prodSel = document.createElement("select");
  for (const p of ALL_PRODUCTS) {
    const o = document.createElement("option");
    o.value = p;
    o.textContent = PRODUCT_LABEL[p] || p;
    prodSel.appendChild(o);
  }
  card.append(prodLabel, prodSel);

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "名称";
  const nameInput = document.createElement("input");
  nameInput.placeholder = "例如：Rythmix Logo / 如何获取 User ID";
  card.append(nameLabel, nameInput);

  // 动态字段：图片→文件；链接→URL；说明→文本
  const fieldWrap = document.createElement("div");
  card.appendChild(fieldWrap);
  function renderField() {
    fieldWrap.replaceChildren();
    const lab = document.createElement("label");
    if (typeSel.value === "image" || typeSel.value === "video") {
      const isVideo = typeSel.value === "video";
      lab.textContent = isVideo ? "选择视频文件（约 33MB 内）" : "选择图片文件";
      const f = document.createElement("input");
      f.type = "file";
      f.accept = isVideo ? "video/*" : "image/*";
      f.id = "asset-file";
      fieldWrap.append(lab, f);
      if (isVideo) {
        const tip = document.createElement("small");
        tip.className = "editor-tip";
        tip.textContent = "大视频建议改用「🔗 链接」（贴云盘/YouTube 链接），更快更稳。";
        fieldWrap.append(tip);
      }
    } else if (typeSel.value === "link") {
      lab.textContent = "链接地址";
      const u = document.createElement("input");
      u.id = "asset-url";
      u.placeholder = "https://...";
      fieldWrap.append(lab, u);
    } else {
      lab.textContent = "文字内容";
      const t = document.createElement("textarea");
      t.id = "asset-text";
      t.rows = 4;
      t.placeholder = "例如：打开 app → 设置 → 底部复制 User ID 发给我们";
      fieldWrap.append(lab, t);
    }
  }
  typeSel.addEventListener("change", renderField);
  renderField();

  const actions = document.createElement("div");
  actions.className = "archive-item-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "保存";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => {
    assetForm.replaceChildren();
    assetForm.classList.add("hidden");
  });
  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.focus();
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = "保存中…";
    try {
      await saveAsset(typeSel.value, name, prodSel.value);
      assetForm.replaceChildren();
      assetForm.classList.add("hidden");
      await loadAssets();
      renderAssetsProductFilter();
      renderAssets();
    } catch (error) {
      saveBtn.disabled = false;
      saveBtn.textContent = "保存";
      const tip = document.createElement("p");
      tip.className = "request-error";
      tip.textContent = error.message;
      card.appendChild(tip);
    }
  });
  actions.append(saveBtn, cancelBtn);
  card.appendChild(actions);
  assetForm.appendChild(card);
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function saveAsset(type, name, product) {
  const payload = { type, name, product };
  if (type === "image" || type === "video") {
    const file = document.getElementById("asset-file").files?.[0];
    if (!file) throw new Error(type === "video" ? "请选择视频文件。" : "请选择图片文件。");
    if (type === "video" && file.size > 34 * 1024 * 1024) {
      throw new Error("视频太大（约 33MB 内），请压缩或改用「🔗 链接」。");
    }
    payload.dataBase64 = await readFileAsBase64(file);
    payload.ext = (
      file.name.split(".").pop() || (type === "video" ? "mp4" : "png")
    ).toLowerCase();
  } else if (type === "link") {
    payload.url = document.getElementById("asset-url").value.trim();
    if (!payload.url) throw new Error("请填写链接。");
  } else {
    payload.text = document.getElementById("asset-text").value.trim();
    if (!payload.text) throw new Error("请填写文字内容。");
  }
  const response = await fetch(`${API_BASE}/api/assets`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "上传失败。");
}

async function deleteAssetRecord(asset) {
  if (!window.confirm(`确定删除物料「${asset.name}」？`)) return;
  try {
    const response = await fetch(`${API_BASE}/api/assets/delete`, {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ id: asset.id })
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || "删除失败。");
    await loadAssets();
    renderAssetsProductFilter();
    renderAssets();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
}

async function exportArchive() {
  const response = await fetch(`${API_BASE}/api/archive/export`, {
    method: "POST",
    headers: authHeaders()
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "导出失败");
  const blob = new Blob([JSON.stringify(body, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `kol-scenario-archive-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function renderMentionedItems(items) {
  const card = document.getElementById("mentioned-items-card");
  const container = document.getElementById("mentioned-items");
  container.replaceChildren();

  for (const item of items) {
    const wrapper = document.createElement("div");
    wrapper.className = "mentioned-item";

    const title = document.createElement("h3");
    title.textContent = item.term || "未命名事项";
    wrapper.appendChild(title);

    const explanation = document.createElement("p");
    explanation.textContent = item.plain_explanation || "";
    wrapper.appendChild(explanation);

    const contextStatus = document.createElement("p");
    contextStatus.className = "context-status";
    contextStatus.textContent =
      item.previous_context === "yes"
        ? "当前提供的上下文中已经提到过。"
        : item.previous_context === "no"
          ? "当前提供的上下文中没有看到此前提及。"
          : "未提供完整历史，暂时无法判断此前是否聊过。";
    wrapper.appendChild(contextStatus);

    if (item.attention) {
      const attention = document.createElement("p");
      attention.textContent = `注意：${item.attention}`;
      wrapper.appendChild(attention);
    }
    if (item.suggested_action) {
      const action = document.createElement("p");
      action.textContent = `建议：${item.suggested_action}`;
      wrapper.appendChild(action);
    }
    container.appendChild(wrapper);
  }

  card.classList.toggle("hidden", !items.length);
}

function localFallback(text) {
  const scenario = KOLKnowledge.matchScenario(text);
  return {
    detected_language: KOLKnowledge.detectLanguage(text),
    literal_chinese: scenario
      ? scenario.interpretation
      : "离线模式无法可靠翻译这条消息，请先启动千问服务。",
    implied_meaning: "离线模式不进行潜台词判断",
    implication_confidence: "low",
    stage: scenario?.stage || "新场景",
    intent: scenario?.intent || "现有离线话术尚未覆盖",
    match_type: scenario ? "partial" : "new_scenario",
    matched_source: scenario ? "本地离线话术" : "离线保守回复",
    reply_target:
      scenario?.replyEn ||
      "Thanks for your message! Let me confirm the details with my team, and I’ll get back to you shortly.",
    reply_chinese:
      scenario?.replyZh || "谢谢你的消息！我先和团队确认一下具体情况，稍后回复你。",
    alternative_target: "",
    alternative_chinese: "",
    required_variables: [],
    internal_guidance: {
      level: "confirm",
      explanation: "AI 服务未启动，无法可靠判断红人的言外之意。",
      question_for_tl: "",
      temporary_reply_target: "",
      temporary_reply_chinese: "",
      operator_reminders: ["启动千问服务后重新分析"]
    },
    risk_warning: scenario?.risk || "当前为离线占位回复。"
  };
}

// 从当前打开对话里取最近一条对方消息文本（用于无原文时识别目标语言）
async function detectConversationLanguage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return "";
    const conv = await chrome.tabs.sendMessage(tab.id, { type: "KOL_GET_CONVERSATION" });
    if (!conv || !conv.messages || !conv.messages.length) return "";
    // 取最近一条"对方"消息作为语言探针
    const theirMsgs = conv.messages.filter((m) => m.from !== "me" && m.from !== "colleague");
    const probe = theirMsgs.length ? theirMsgs[theirMsgs.length - 1].text : "";
    if (!probe || probe.length < 2) return "";
    // 请求后端翻译接口识别语言（走缓存，不额外计费）
    const res = await fetch(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ text: probe })
    });
    if (!res.ok) return "";
    const data = await res.json();
    const src = String(data.source_language || "").trim();
    return (src && src !== "未知" && src !== "中文") ? src : "";
  } catch (_) {
    return "";
  }
}

// 没有任何语言线索（红人只发了图片/视频、屏幕上没文字）时，弹窗让运营选回复语言，
// 避免 AI 默认编成英文。返回选中的语言名，或 null（用户取消）。
function pickReplyLanguage() {
  return new Promise((resolve) => {
    const langs = ["英语", "日语", "韩语", "繁体中文", "土耳其语", "西班牙语", "葡萄牙语", "意大利语", "德语", "法语", "俄语", "阿拉伯语", "泰语"];
    const overlay = document.createElement("div");
    overlay.className = "kol-lang-overlay";
    const box = document.createElement("div");
    box.className = "kol-lang-box";
    const title = document.createElement("div");
    title.className = "kol-lang-title";
    title.textContent = "这条没有红人文字（只有图片/视频），用哪种语言回复？";
    box.appendChild(title);
    const grid = document.createElement("div");
    grid.className = "kol-lang-grid";
    let done = false;
    const finish = (val) => { if (done) return; done = true; overlay.remove(); resolve(val); };
    langs.forEach((l) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kol-lang-opt";
      b.textContent = l;
      b.addEventListener("click", () => finish(l));
      grid.appendChild(b);
    });
    box.appendChild(grid);
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "kol-lang-cancel";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => finish(null));
    box.appendChild(cancel);
    overlay.appendChild(box);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) finish(null); });
    document.body.appendChild(overlay);
  });
}

// 决定这次回复用什么语言（统一各处生成入口的兜底顺序）：
//   1) 有红人原文 → 返回 ""（让服务端从原文识别，最准）
//   2) 没原文 → 扫当前对话窗口识别红人语言
//   3) 都没有（只有图片/视频，毫无文字线索）→ 弹窗让运营选
// 注意：「回复语言」下拉必须始终保持「跟随红人语言」，不用作兜底。
// 返回语言名字符串；返回 null 表示弹窗里用户取消了，调用方应中止生成。
// 回复语言优先级（用户定的原则）：
//   ① 有红人原文 → 永远忠于原文、跟随红人语言（交服务端从原文识别）。
//      此时**忽略下拉框**——很多人会忘了把上次选的语言切回去，留着会误导 AI（红人明明发英语却被翻成泰语）。
//   ② 没原文 → 用下拉里明确选的语言。
//   ③ 没原文也没选 → 扫左边对话框识别（最后一步，有时会误判成英语，所以放最后）。
//   ④ 都没有 → 弹窗让用户选。
async function resolveReplyLanguage(redText) {
  if (redText) return "";
  const explicit = (replyLanguageSelect && replyLanguageSelect.value || "").trim();
  if (explicit) return explicit;
  const detected = await detectConversationLanguage();
  if (detected) return detected;
  return await pickReplyLanguage(); // 语言名 或 null（取消）
}

// 背后悄悄抓当前打开对话，当上下文（读屏；抓不到就返回空）
async function getConversationContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return "";
    const conv = await chrome.tabs.sendMessage(tab.id, { type: "KOL_GET_CONVERSATION" });
    if (!conv || !conv.messages || !conv.messages.length) return "";
    return conv.messages
      .map((m) => {
        const who = m.from === "me" ? "我" : m.from === "colleague" ? (m.name || "同事") : (m.name || "对方");
        return `${who}: ${m.text}`;
      })
      .join("\n");
  } catch (e) {
    return "";
  }
}

// 显示 AI 回答（这是什么意思 / 这怎么办 / 问 AI）
function showAskAnswer(text) {
  const box = document.getElementById("ask-answer");
  const body = document.getElementById("ask-answer-text");
  body.textContent = text || "";
  box.classList.remove("hidden");
  emptyState.classList.add("hidden");
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// 「这是什么意思」=看懂；「这怎么办」=出主意。两者都自动带上下文。
// 忠实翻译 / 润色生成：只把你写的中文翻成外语，绝不自动抓对话、不脑补
async function doReply(mode) {
  const text = replyIntentInput.value.trim();
  if (!text) { replyIntentInput.focus(); return; }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const redText = messageInput.value.trim(); // 红人原文
  // 回复语言：有原文让服务端从原文识别；没原文先扫对话窗口/读设置，
  // 都没有（红人只发图片/视频）就弹窗让运营选，避免 AI 默认编成英文。
  const fallbackLang = await resolveReplyLanguage(redText);
  if (fallbackLang === null) return; // 用户取消（此处尚未禁用按钮）
  const btn = document.getElementById(mode === "faithful" ? "do-faithful" : "do-polish");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = mode === "faithful" ? "翻译中…" : "生成中…";
  errorBox.classList.add("hidden");
  const biBox = document.getElementById("bi-split");
  if (biBox) biBox.innerHTML = '<div class="bi-loading">处理中…</div>';
  const aa = document.getElementById("ask-answer");
  if (aa) aa.classList.add("hidden");
  emptyState.classList.add("hidden");
  result.classList.remove("hidden");
  try {
    const body = await postRewrite({
      direction: mode === "faithful" ? "faithful" : "chinese_to_target",
      // 把红人原文同时作为 message + context：服务端据此识别要翻成的语言
      message: redText,
      context: redText,
      productId: productSelect.value,
      detectedLanguage: "",
      replyLanguage: fallbackLang,
      replyChinese: text
    });
    replyTargetInput.value = body.reply_target || "";
    replyChineseInput.value = body.reply_chinese || text;
    renderBilingualSplit(replyTargetInput.value, replyChineseInput.value);
  } catch (e) {
    errorBox.textContent = e.name === "TimeoutError" ? "超时，请重试。" : e.message;
    errorBox.classList.remove("hidden");
    if (biBox) biBox.innerHTML = "";
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
  // 注：AI 理解（识别/阶段/风险）已改为「打开对话时自动跑」(maybeRunUnderstanding)，
  // 这里不再用粘贴/翻译动作重复触发分析。
}

// 这是什么意思 = 纯翻译（任何外语 → 中文；红人的、你自己的、AI 给你的都行）
async function askMeaningTranslate() {
  const text = messageInput.value.trim() || replyIntentInput.value.trim();
  if (!text) { messageInput.focus(); return; }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const btn = document.getElementById("ask-meaning");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "翻译中…";
  errorBox.classList.add("hidden");
  try {
    const res = await fetch(`${API_BASE}/api/translate`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text: text.slice(0, 1200) }),
      signal: AbortSignal.timeout(30000)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "翻译失败");
    let out = body.translation || "（没有内容）";
    if (body.term_notes && body.term_notes.length) {
      out += "\n\n注：" + body.term_notes.map((n) => `「${n.term}」${n.explanation}`).join("；");
    }
    showAskAnswer(out);
  } catch (e) {
    errorBox.textContent = e.name === "TimeoutError" ? "超时，请重试。" : e.message;
    errorBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// 「这是什么意思」：永远先用扫描工具读当前对话框（最全），再结合你粘贴的原文，
// 让 AI 以信息更全的一方为准，逐句讲清 + 点出潜台词。哪怕你没贴任何东西也能用。
async function explainMeaning() {
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const btn = document.getElementById("ask-meaning");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "AI 解读中…";
  errorBox.classList.add("hidden");
  try {
    const pasted = messageInput.value.trim();          // 你手动贴的原文（可能没贴/不全）
    const scanned = await getConversationContext();      // 自动扫描当前对话框（通常最全）
    if (!pasted && !scanned) {
      errorBox.textContent = "在 IG 打开这个对话，或把外语贴进第一框，再点这里。";
      errorBox.classList.remove("hidden");
      return;
    }
    // 两份资料都给 AI，并说明：以信息更全的一方为准
    let message, context;
    if (pasted && scanned) {
      message = pasted;
      context =
        "【工具自动扫描当前对话框（通常更全）】\n" + scanned +
        "\n\n【运营手动粘贴的原文】\n" + pasted;
    } else {
      message = pasted || scanned;
      context = "";
    }
    const question =
      "请用大白话中文逐句讲清楚红人最近的消息是什么意思，并点出可能的言外之意/潜台词。" +
      "下面可能同时给你两份资料：工具自动扫描当前对话框得到的完整对话、以及运营手动粘贴的原文。" +
      "请先判断哪一份信息更全，以更全的一方为准来理解；通常自动扫描的更全，" +
      "但若手动粘贴里有扫描中没有的内容，则把两者结合、以信息更全为准。";
    const res = await fetch(`${API_BASE}/api/ask`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ question, message, context, productId: productSelect.value }),
      signal: AbortSignal.timeout(50000)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "AI 解读失败");
    showAskAnswer(body.answer || "（没有内容）");
  } catch (e) {
    errorBox.textContent = e.name === "TimeoutError" ? "AI 超时，请重试。" : e.message;
    errorBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

async function askAboutMessage(mode) {
  // 「这是什么意思」看的是红人原文（第一框优先）；「这怎么办」的疑问写在第二框
  const text = mode === "meaning"
    ? (messageInput.value.trim() || replyIntentInput.value.trim())
    : (replyIntentInput.value.trim() || messageInput.value.trim());
  if (!text) { (mode === "meaning" ? messageInput : replyIntentInput).focus(); return; }
  if (!serviceOnline) {
    errorBox.textContent = "千问服务尚未连接。";
    errorBox.classList.remove("hidden");
    return;
  }
  const btn = mode === "meaning" ? document.getElementById("ask-meaning") : document.getElementById("ask-howto");
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = "AI 思考中…";
  errorBox.classList.add("hidden");
  try {
    const autoCtx = await getConversationContext();
    const yuanwen = messageInput.value.trim();
    const context = [yuanwen ? "红人原文：" + yuanwen : "", autoCtx]
      .filter(Boolean)
      .join("\n");
    let question, msg;
    if (mode === "meaning") {
      // 看懂：text 是看不懂的那条消息
      question = "请用大白话中文逐句讲清楚这条消息是什么意思，包括可能的言外之意/潜台词。如果结合上下文有更准的理解，请据此说明。";
      msg = text;
    } else {
      // 出主意：text 是运营的疑问（这个人死活不同意怎么办）
      question = text;
      msg = "";
    }
    const res = await fetch(`${API_BASE}/api/ask`, {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ question, message: msg, context, productId: productSelect.value }),
      signal: AbortSignal.timeout(50000)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "AI 回答失败");
    showAskAnswer(body.answer || "（没有内容）");
  } catch (e) {
    errorBox.textContent = e.name === "TimeoutError" ? "AI 超时，请重试。" : e.message;
    errorBox.classList.remove("hidden");
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

// 注：旧的 analyze()（💬 生成双语回复 按钮）已随改版删除——回复改由 do-faithful/do-polish
// 走 doReply 生成；AI 理解（/api/analyze）改由「打开对话自动跑」maybeRunUnderstanding 承担。

document.getElementById("do-faithful").addEventListener("click", () => doReply("faithful"));
document.getElementById("do-polish").addEventListener("click", () => doReply("polish"));
// 红人原文框一有内容，回复语言自动跳回「自动（跟随红人语言）」——
// 防止有人忘了把上次选的语言切回去，留着会误导 AI（红人发英语却被翻成泰语）。
if (messageInput && replyLanguageSelect) {
  messageInput.addEventListener("input", () => {
    if (messageInput.value.trim() && replyLanguageSelect.value) replyLanguageSelect.value = "";
  });
}
document.getElementById("ask-meaning").addEventListener("click", explainMeaning);
document.getElementById("rewrite-from-zh").addEventListener("click", rewriteFromChinese);
document.getElementById("ask-howto").addEventListener("click", () => askAboutMessage("howto"));
document.getElementById("ask-copy").addEventListener("click", () => {
  const t = document.getElementById("ask-answer-text").textContent || "";
  if (t) navigator.clipboard.writeText(t).catch(() => {});
});
document
  .getElementById("open-playbook-reactive")
  .addEventListener("click", () => openPlaybookPicker("reactive"));
document
  .getElementById("playbook-close")
  .addEventListener("click", () => playbookDialog.close());
playbookProduct.addEventListener("change", renderPlaybookList);
playbookStage.addEventListener("change", renderPlaybookList);
playbookSearch.addEventListener("input", renderPlaybookList);
document.getElementById("rewrite-go").addEventListener("click", rewriteGo);
document
  .querySelectorAll(".save-trigger")
  .forEach((button) =>
    button.addEventListener("click", () => openSaveDialog(reactiveSaveCtx()))
  );
document.getElementById("save-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveCurrentScenario();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove("hidden");
  }
});
document.getElementById("cancel-save").addEventListener("click", () => {
  saveDialog.close();
});
document.getElementById("open-archive").addEventListener("click", async () => {
  archivePanel.classList.toggle("hidden");
  if (!archivePanel.classList.contains("hidden")) {
    archivePanel.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      await loadArchive();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove("hidden");
    }
  }
});
document.getElementById("open-assets").addEventListener("click", async () => {
  assetsPanel.classList.toggle("hidden");
  if (!assetsPanel.classList.contains("hidden")) {
    document.getElementById("new-asset").classList.remove("hidden");
    assetForm.classList.add("hidden");
    assetsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      await loadAssets();
      renderAssetsProductFilter();
      renderAssets();
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.classList.remove("hidden");
    }
  }
});
document.getElementById("new-asset").addEventListener("click", openNewAssetForm);
assetsProduct.addEventListener("change", renderAssets);
archiveSearch.addEventListener("input", () => {
  clearTimeout(archiveSearchTimer);
  archiveSearchTimer = setTimeout(() => loadArchive(archiveSearch.value.trim()), 300);
});
document.getElementById("export-archive").addEventListener("click", exportArchive);
document
  .getElementById("new-archive")
  .addEventListener("click", openNewArchiveForm);
document.getElementById("import-archive").addEventListener("click", () => {
  document.getElementById("import-file").click();
});
document.getElementById("import-file").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (file) await handleImportFile(file);
});
productSelect.addEventListener("change", () => {
  chrome.storage.session.set({ selectedProduct: productSelect.value });
});
statusButton.addEventListener("click", checkService);

// ===== 本地记录备份 / 恢复（合作进度·提醒·待办·身份设置） =====
const BACKUP_KEYS = [
  "kolSummaries", "kolThreads", "kolTodos", "kolQuickReplies",
  "kolReminderSettings", "kolProactiveLang", "kolThreadsSchema", "kolProfiles",
  "kolUnderstanding" // AI 当前阶段，供红人资源库/进度看板读
];
function showBackupStatus(msg, ok) {
  const el = document.getElementById("backup-status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok === false ? "#c0392b" : "#2e7d32";
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    await navigator.clipboard.writeText(target.textContent);
    const oldText = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = oldText;
    }, 1000);
  });
});

document.querySelectorAll("[data-copy-value]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copyValue);
    await navigator.clipboard.writeText(target.value);
    const oldText = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = oldText;
    }, 1000);
  });
});

// 服务器设置：填本机或团队 VPS 地址 + 团队口令，保存到 chrome.storage.local。
const serverAddressInput = document.getElementById("server-address");
const serverTokenInput = document.getElementById("server-token");
const serverAdminInput = document.getElementById("server-admin");
const serverInsIdInput = document.getElementById("server-insid");
const serverStaffInput = document.getElementById("server-staffname");
const saveServerButton = document.getElementById("save-server");
const serverSettingsStatus = document.getElementById("server-settings-status");

function fillServerSettings() {
  if (serverAddressInput) serverAddressInput.value = API_BASE;
  if (serverTokenInput) serverTokenInput.value = API_TOKEN;
  if (serverAdminInput) serverAdminInput.value = API_ADMIN;
  if (serverInsIdInput) serverInsIdInput.value = API_INSID;
  if (serverStaffInput) serverStaffInput.value = API_STAFF;
}

if (saveServerButton) {
  saveServerButton.addEventListener("click", async () => {
    const apiBase = serverAddressInput.value.trim().replace(/\/+$/, "");
    const token = serverTokenInput.value.trim();
    const adminToken = serverAdminInput ? serverAdminInput.value.trim() : "";
    const insId = serverInsIdInput ? serverInsIdInput.value.trim() : "";
    const staffName = serverStaffInput ? serverStaffInput.value.trim() : "";
    if (!apiBase) {
      serverAddressInput.focus();
      return;
    }
    const insIdChanged = insId && insId !== API_INSID;
    const product = (productSelect && productSelect.value) || API_PRODUCT || "generic";
    API_BASE = apiBase;
    API_TOKEN = token;
    API_ADMIN = adminToken;
    API_INSID = insId;
    API_PRODUCT = product;
    API_STAFF = staffName;
    await chrome.storage.local.set({
      kolConfig: { apiBase, token, adminToken, insId, product, staffName }
    });
    // ins id 同时是提醒里「我自己的号」、产品同时是「我负责的产品」——写进提醒身份。
    await syncReminderIdentity();
    serverSettingsStatus.textContent = "已保存，正在重新连接服务……";
    serverSettingsStatus.classList.remove("hidden");
    await checkService();
    serverSettingsStatus.textContent = serviceOnline
      ? "已连接到该服务器。"
      : "保存了，但暂时连不上，请检查地址、口令和服务器防火墙。";
    refreshSetupBanner();
    // 首次填/改了 ins id：尝试从云端拉回历史记录（本地为空才合并，不覆盖更新的本地）。
    if (insIdChanged && serviceOnline) await cloudRestore(true);
    // 之后开启自动备份（把当前本地推一份上去，确保云端有最新）。
    if (insId && serviceOnline) scheduleCloudBackup();
  });
}

// 把「服务器设置」里的 ins id / 产品 写进提醒身份(kolReminderSettings)，
// 保留前缀清单/开关等其它字段。提醒据此认「我方 vs 红人」。
async function syncReminderIdentity() {
  try {
    const cur = (await chrome.storage.local.get("kolReminderSettings")).kolReminderSettings || {};
    const next = { ...cur };
    if (API_INSID) next.myHandle = API_INSID.replace(/^@/, "");
    if (API_PRODUCT && API_PRODUCT !== "generic") next.myProduct = API_PRODUCT;
    if (API_STAFF) next.myStaffName = API_STAFF;
    if (next.enabled === undefined) next.enabled = true;
    await chrome.storage.local.set({ kolReminderSettings: next });
  } catch (_) {}
}

// 软提示横幅：没填 ins id / 产品时提醒去服务器设置（不锁死功能）。
function refreshSetupBanner() {
  const banner = document.getElementById("setup-banner");
  if (!banner) return;
  const missing = !API_INSID || !API_PRODUCT;
  banner.classList.toggle("hidden", !missing);
}
const setupBannerOpen = document.getElementById("setup-banner-open");
if (setupBannerOpen) {
  setupBannerOpen.addEventListener("click", () => {
    const box = document.querySelector(".server-settings");
    if (box) {
      box.setAttribute("open", "");
      box.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (serverInsIdInput && !API_INSID) serverInsIdInput.focus();
  });
}

// ===== 云端自动备份（按 ins id）：复用 BACKUP_KEYS，改动后自动推送，换电脑可恢复 =====
let cloudBackupTimer = null;
function setCloudStatus(msg, ok) {
  const el = document.getElementById("cloud-sync-status");
  if (!el) return;
  el.textContent = msg;
  el.style.color = ok === false ? "#c0392b" : "#2e7d32";
}
// 防抖：改动密集时只在停手 2.5s 后推一次，省请求。
function scheduleCloudBackup() {
  if (!API_INSID) return;
  clearTimeout(cloudBackupTimer);
  cloudBackupTimer = setTimeout(cloudBackupNow, 2500);
}
async function cloudBackupNow() {
  if (!API_INSID) return;
  try {
    const data = await chrome.storage.local.get(BACKUP_KEYS);
    const r = await fetch(`${API_BASE}/api/backup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ userId: API_INSID, data })
    });
    if (r.ok) setCloudStatus(`☁️ 已自动备份到云端（${API_INSID}）`, true);
  } catch (_) {
    // 网络抖动忽略，下次改动再推。
  }
}
// 从云端恢复：silent=true 时只在本地为空的项才填（避免覆盖更新的本地数据）。
async function cloudRestore(silent) {
  if (!API_INSID) {
    if (!silent) setCloudStatus("请先填写并保存你的 ins id。", false);
    return;
  }
  try {
    const r = await fetch(
      `${API_BASE}/api/backup?id=${encodeURIComponent(API_INSID)}`,
      { headers: authHeaders() }
    );
    const body = await r.json();
    const inc = body && body.data;
    if (!inc || typeof inc !== "object") {
      if (!silent) setCloudStatus("云端还没有你的备份。", false);
      return;
    }
    const cur = await chrome.storage.local.get(BACKUP_KEYS);
    const merged = {};
    // 对象型(合作进度/对话线程/待办)按 key 合并；其它(快捷/设置)云端非空才覆盖。
    ["kolSummaries", "kolThreads", "kolTodos"].forEach((k) => {
      merged[k] = { ...(inc[k] || {}), ...(cur[k] || {}) };
    });
    ["kolQuickReplies", "kolReminderSettings", "kolProactiveLang", "kolThreadsSchema"].forEach((k) => {
      const incomingHas = inc[k] !== undefined && inc[k] !== null &&
        !(Array.isArray(inc[k]) && !inc[k].length);
      const localEmpty = cur[k] === undefined || cur[k] === null ||
        (Array.isArray(cur[k]) && !cur[k].length);
      if (incomingHas && (localEmpty || !silent)) merged[k] = inc[k];
    });
    await chrome.storage.local.set(merged);
    const n = Object.keys(merged.kolSummaries || {}).length;
    setCloudStatus(`☁️ 已从云端恢复（合作进度 ${n} 条等）`, true);
  } catch (e) {
    if (!silent) setCloudStatus("从云端恢复失败：" + e.message, false);
  }
}
const cloudRestoreButton = document.getElementById("cloud-restore");
if (cloudRestoreButton) {
  cloudRestoreButton.addEventListener("click", () => cloudRestore(false));
}
// 任何本地记录变化（合作进度/快捷/提醒等）→ 自动安排一次云备份。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (BACKUP_KEYS.some((k) => k in changes)) scheduleCloudBackup();
});

// 新手指引：首次打开显示，点"知道了"永久收起，顶部"❓"可再调出。
const guideCard = document.getElementById("guide-card");
async function initGuide() {
  try {
    const { kolGuideDismissed } = await chrome.storage.local.get(
      "kolGuideDismissed"
    );
    guideCard.classList.toggle("hidden", Boolean(kolGuideDismissed));
  } catch {
    guideCard.classList.remove("hidden");
  }
}
document.getElementById("guide-dismiss").addEventListener("click", async () => {
  guideCard.classList.add("hidden");
  try {
    await chrome.storage.local.set({ kolGuideDismissed: true });
  } catch {
    // 忽略存储失败。
  }
});
document.getElementById("open-guide").addEventListener("click", () => {
  guideCard.classList.remove("hidden");
  guideCard.scrollIntoView({ behavior: "smooth", block: "start" });
});

loadConfig().then(async () => {
  fillServerSettings();
  loadPendingMessage();
  await checkService();
  refreshSetupBanner();
  // 启动时若已填 ins id：静默从云端补回缺失的本地记录（换电脑/清缓存后自动找回）。
  if (API_INSID && serviceOnline) cloudRestore(true);
  // 打开对话后自动跑 AI 理解（缓存先显示、变化才重算）
  scheduleUnderstanding(500);
});
initGuide();

// ====================== KOL 提醒面板 ======================
// 面板仅保留「加待办」入口，完整清单在独立弹窗（reminders.html）里展示。
(function () {
  const SETTINGS_KEY = "kolReminderSettings";
  const panel = document.getElementById("reminder-panel");
  if (!panel) return;

  const openBtn = document.getElementById("open-reminders");
  const closeBtn = document.getElementById("reminder-close");

  function nowIso() { return new Date().toISOString(); }

  async function getLocal(keys) { return chrome.storage.local.get(keys); }
  async function setLocal(obj) { return chrome.storage.local.set(obj); }

  async function patchTodo(id, patch) {
    const store = await getLocal("kolTodos");
    const todos = store.kolTodos || [];
    const next = todos.map((t) => (t.id === id ? { ...t, ...patch } : t));
    await setLocal({ kolTodos: next });
  }

  // 名字归一化：跟采集层 kol-reminder.js 的 titleKey 完全一致，这样和 kolThreads 的 key 对得上。
  function titleKeyOf(s) {
    return String(s || "")
      .replace(/[…\.]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[^\p{L}\p{N}]+/u, "")
      .slice(0, 22)
      .trim()
      .toLowerCase();
  }
  // 拿一句红人名字 → 在 kolThreads 里反查对话(threadId)。先精确命中归一化 key，再模糊(key/群名互相包含)。
  // 只返回带 threadId 的，找不到返回 null（宁可不绑，也不给打不开的按钮）。
  async function matchThreadByName(name) {
    const q = titleKeyOf(name);
    if (!q) return null;
    const threads = (await chrome.storage.local.get("kolThreads")).kolThreads || {};
    const rec0 = threads[q];
    if (rec0 && rec0.threadId) return { threadId: rec0.threadId, title: rec0.title || name };
    const qns = q.replace(/\s+/g, ""); // 去空格版，容忍中文名里多打的空格（"小 美"↔"小美"）
    for (const [k, rec] of Object.entries(threads)) {
      if (!rec || !rec.threadId) continue;
      const cands = [k, titleKeyOf(rec.title || "")].filter((s) => s && s.length >= 2);
      const hit = cands.some((s) => {
        const sns = s.replace(/\s+/g, "");
        return s.includes(q) || (q.length >= 2 && q.includes(s)) ||
               sns.includes(qns) || (qns.length >= 2 && qns.includes(sns));
      });
      if (hit) return { threadId: rec.threadId, title: rec.title || k };
    }
    return null;
  }
  // 把某条待办补绑到一个对话
  async function linkTodoThread(todoId, threadId) {
    const store = await getLocal("kolTodos");
    const todos = (store.kolTodos || []).map((t) => (t.id === todoId ? { ...t, threadId } : t));
    await setLocal({ kolTodos: todos });
  }
  // 没自动绑上红人时，引导填名字关联（选填，不填就是普通待办，不显示打不开的按钮）
  function showTodoLinkHint(todoId) {
    const box = document.getElementById("todo-link-hint");
    if (!box) return;
    box.classList.remove("hidden");
    box.innerHTML = `<span class="tlh-tip">💡 想让这条待办能「一键打开对话」？填红人名字关联（选填）：</span>
      <span class="tlh-row"><input class="tlh-input" type="text" placeholder="红人名字 / 群聊名" />
      <button class="tlh-link" type="button">🔗 关联</button></span>
      <span class="tlh-msg"></span>`;
    const inp = box.querySelector(".tlh-input");
    const lk = box.querySelector(".tlh-link");
    const msg = box.querySelector(".tlh-msg");
    inp.focus();
    const doLink = async () => {
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      lk.disabled = true; msg.textContent = "查找中…";
      const m = await matchThreadByName(v);
      if (m) {
        await linkTodoThread(todoId, m.threadId);
        msg.textContent = `已关联「${m.title}」✓ 待办清单里就能一键打开对话了`;
        msg.className = "tlh-msg ok";
        inp.disabled = true; lk.style.display = "none";
        setTimeout(() => { box.classList.add("hidden"); box.innerHTML = ""; }, 2600);
      } else {
        msg.textContent = `没找到叫「${v}」的对话——可能还没在插件里聊过/采集过，先去 IG 打开一次再试`;
        msg.className = "tlh-msg warn";
        lk.disabled = false;
      }
    };
    lk.addEventListener("click", doLink);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") doLink(); });
  }

  // —— 加待办 ——
  document.getElementById("add-todo").addEventListener("click", async () => {
    const text = document.getElementById("todo-text").value.trim();
    const dueRaw = document.getElementById("todo-due").value;
    if (!text) return;
    let dueAt = nowIso();
    if (dueRaw) { const d = new Date(dueRaw); if (!isNaN(d)) dueAt = d.toISOString(); }
    const store = await getLocal("kolTodos");
    const todos = store.kolTodos || [];
    todos.push({ id: "t" + Date.now(), text, dueAt, done: false, dismissed: false });
    await setLocal({ kolTodos: todos });
    document.getElementById("todo-text").value = "";
    document.getElementById("todo-due").value = "";
  });

  // 智能加待办：打一句话，AI 解析出事项 + 时间
  document.getElementById("add-todo-smart").addEventListener("click", async () => {
    const input = document.getElementById("todo-smart");
    const sentence = input.value.trim();
    if (!sentence) { input.focus(); return; }
    const btn = document.getElementById("add-todo-smart");
    const orig = btn.textContent;
    btn.disabled = true; btn.textContent = "解析中…";
    try {
      const res = await fetch(`${API_BASE}/api/parse-todo`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ sentence, now: new Date().toISOString() }),
        signal: AbortSignal.timeout(20000)
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "解析失败");
      // 用解析出的本地日期时间拼 dueAt
      let dueAt = nowIso();
      if (body.date) {
        const d = new Date(`${body.date}T${(body.time || "10:00")}:00`);
        if (!isNaN(d)) dueAt = d.toISOString();
      }
      // 当前正开着某个红人对话 → 把它的 threadId 顺手绑上，这条待办之后就能「一键打开对话」。
      let threadId = "", linkedName = "";
      try {
        const conv = await getActiveConversation();
        if (conv && conv.tid) { threadId = conv.tid; linkedName = conv.name || ""; }
      } catch { /* 取不到当前对话就不绑 */ }
      const todoId = "t" + Date.now();
      const store = await getLocal("kolTodos");
      const todos = store.kolTodos || [];
      todos.push({ id: todoId, text: body.text || sentence, dueAt, threadId, done: false, dismissed: false });
      await setLocal({ kolTodos: todos });
      input.value = "";
      btn.textContent = linkedName ? `已加 ✓ 关联${linkedName}` : "已加 ✓";
      setTimeout(() => { btn.textContent = orig; }, 1400);
      const hint = document.getElementById("todo-link-hint");
      if (threadId) { if (hint) { hint.classList.add("hidden"); hint.innerHTML = ""; } }
      else showTodoLinkHint(todoId); // 没绑上 → 引导填名字关联（不误导，不填就是普通待办）
    } catch (e) {
      btn.textContent = "解析失败,改手动";
      setTimeout(() => { btn.textContent = orig; }, 1800);
    } finally {
      btn.disabled = false;
    }
  });

  // —— 开关面板 ——
  function openPanel() { panel.classList.remove("hidden"); panel.scrollIntoView({ behavior: "smooth", block: "start" }); }
  openBtn && openBtn.addEventListener("click", () => panel.classList.contains("hidden") ? openPanel() : panel.classList.add("hidden"));
  closeBtn && closeBtn.addEventListener("click", () => panel.classList.add("hidden"));

  // 「打开完整清单」按钮 → 弹出独立窗口
  const openTodoWindowBtn = document.getElementById("open-todo-window");
  openTodoWindowBtn && openTodoWindowBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "KOL_OPEN_TODO_WINDOW" }));
})();

// ===================== ⚡ 我的快捷回复（个人·本地·打字秒出）=====================
// 存在浏览器本地 kolQuickReplies，每条 {id, trigger, target, chinese, createdAt}。
// 纯本地关键词匹配，不走 AI、不走服务器：准、即时、离线可用。
(function () {
  const card = document.getElementById("quickreply-card");
  const search = document.getElementById("qr-search");
  const results = document.getElementById("qr-results");
  const addBox = document.getElementById("qr-add");
  const triggerIn = document.getElementById("qr-trigger");
  const targetIn = document.getElementById("qr-target");
  const zhIn = document.getElementById("qr-zh");
  const addSave = document.getElementById("qr-add-save");
  const addStatus = document.getElementById("qr-add-status");
  const saveAsQuick = document.getElementById("save-as-quick");
  if (!card || !search || !results) return;

  async function getQR() {
    const s = await chrome.storage.local.get("kolQuickReplies");
    return Array.isArray(s.kolQuickReplies) ? s.kolQuickReplies : [];
  }
  async function setQR(list) {
    await chrome.storage.local.set({ kolQuickReplies: list });
  }
  function newId() {
    return "qr_" + Math.random().toString(36).slice(2, 9) + (performance.now() | 0);
  }

  function fillReply(item) {
    const rt = document.getElementById("reply-target");
    const rz = document.getElementById("reply-zh");
    if (rt) rt.value = item.target || "";
    if (rz) rz.value = item.chinese || "";
    const empty = document.getElementById("empty-state");
    const result = document.getElementById("result");
    if (empty) empty.classList.add("hidden");
    if (result) result.classList.remove("hidden");
    const aa = document.getElementById("ask-answer");
    if (aa) aa.classList.add("hidden");
    renderBilingualSplit(item.target || "", item.chinese || "");
  }

  function renderResults(list, query) {
    results.replaceChildren();
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "qr-empty";
      p.textContent = query
        ? "没搜到。换个词，或在下面「＋ 手动加一条」存一条。"
        : "还没有快捷回复。生成回复后点「⭐ 存为快捷」，或在下面手动加。";
      results.appendChild(p);
      return;
    }
    list.forEach((item) => {
      const row = document.createElement("div");
      row.className = "qr-item";
      const main = document.createElement("button");
      main.type = "button";
      main.className = "qr-pick";
      const trg = document.createElement("span");
      trg.className = "qr-trigger";
      trg.textContent = item.trigger || "（无触发词）";
      const prev = document.createElement("span");
      prev.className = "qr-preview";
      prev.textContent = item.target || item.chinese || "";
      main.append(trg, prev);
      // 点一下直接复制外语（保留换行），不再跳到双语回复区让用户二次复制。
      main.title = "点一下直接复制外语，去 IG 粘贴";
      main.addEventListener("click", async () => {
        const text = item.target || item.chinese || ""; // textarea 存的，换行原样保留
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          const old = trg.textContent;
          trg.textContent = "已复制 ✓";
          row.classList.add("qr-copied");
          setTimeout(() => { trg.textContent = old; row.classList.remove("qr-copied"); }, 1200);
        } catch (_) {
          fillReply(item); card.removeAttribute("open"); // 复制失败才退回老行为
        }
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "qr-del";
      del.title = "删除这条快捷";
      del.textContent = "🗑";
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        const next = (await getQR()).filter((q) => q.id !== item.id);
        await setQR(next);
        doSearch();
      });
      row.append(main, del);
      results.appendChild(row);
    });
  }

  async function doSearch() {
    const q = search.value.trim().toLowerCase();
    const all = await getQR();
    let list;
    if (!q) {
      list = all.slice(-8).reverse(); // 没输入时显示最近 8 条
    } else {
      list = all.filter((it) =>
        [it.trigger, it.target, it.chinese].some(
          (f) => String(f || "").toLowerCase().includes(q)
        )
      );
    }
    renderResults(list, q);
  }

  async function addQuick({ trigger, target, chinese }) {
    if (!target && !chinese) return false;
    const list = await getQR();
    list.push({
      id: newId(),
      trigger: (trigger || "").trim(),
      target: (target || "").trim(),
      chinese: (chinese || "").trim(),
      createdAt: new Date().toISOString()
    });
    await setQR(list);
    return true;
  }

  search.addEventListener("input", doSearch);
  card.addEventListener("toggle", () => { if (card.open) doSearch(); });

  addSave && addSave.addEventListener("click", async () => {
    const ok = await addQuick({
      trigger: triggerIn.value,
      target: targetIn.value,
      chinese: zhIn.value
    });
    if (!ok) {
      addStatus.textContent = "至少填外语或中文其中一个。";
      addStatus.classList.remove("hidden");
      return;
    }
    triggerIn.value = ""; targetIn.value = ""; zhIn.value = "";
    addStatus.textContent = "已存进我的快捷。";
    addStatus.classList.remove("hidden");
    addBox.removeAttribute("open");
    setTimeout(() => addStatus.classList.add("hidden"), 2500);
    doSearch();
  });

  // 「⭐ 存为快捷」：把当前双语回复带进手动添加框，焦点落到触发词，填个词就存
  saveAsQuick && saveAsQuick.addEventListener("click", () => {
    const rt = document.getElementById("reply-target");
    const rz = document.getElementById("reply-zh");
    if (!rt || !rt.value.trim()) {
      const eb = document.getElementById("request-error");
      if (eb) { eb.textContent = "先生成一条回复再存为快捷。"; eb.classList.remove("hidden"); }
      return;
    }
    card.setAttribute("open", "");
    addBox.setAttribute("open", "");
    targetIn.value = rt.value.trim();
    zhIn.value = rz ? rz.value.trim() : "";
    triggerIn.focus();
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
})();

// ===================== 团队库 Word 导入（管理员） =====================
(() => {
  const panel = document.getElementById("kb-import-panel");
  if (!panel) return;
  const fileInput = document.getElementById("kb-import-file");
  const statusEl = document.getElementById("kb-import-status");
  const previewEl = document.getElementById("kb-import-preview");
  const resultEl = document.getElementById("kb-import-result");
  let parsed = null; // { records, images, summary }

  function setStatus(msg, kind) {
    statusEl.textContent = msg;
    statusEl.classList.remove("hidden");
    statusEl.style.color =
      kind === "error" ? "#c0392b" : kind === "ok" ? "#2e7d32" : "#555";
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  }

  document.getElementById("open-kb-import").addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (panel.classList.contains("hidden")) return;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
    if (!isAdminUser()) {
      setStatus(
        "你不是管理员（没填管理员口令）：可以预览解析结果，但点确认导入时会被服务器拒绝。",
        "error"
      );
    } else {
      statusEl.classList.add("hidden");
    }
  });

  document
    .getElementById("kb-pick-file")
    .addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) return;
    previewEl.classList.add("hidden");
    previewEl.innerHTML = "";
    resultEl.classList.add("hidden");
    resultEl.innerHTML = "";
    if (!/\.docx$/i.test(file.name)) {
      setStatus("请选择 .docx 文件（Word）。老的 .doc 先在 Word 里另存为 .docx。", "error");
      return;
    }
    setStatus(`正在你本地解析「${file.name}」…内容多/图片多时要等几秒。`, "info");
    try {
      const buf = await file.arrayBuffer();
      parsed = await KOLDocxImport.parse(buf);
      renderPreview(parsed.summary, file.name);
    } catch (e) {
      parsed = null;
      setStatus("解析失败：" + (e && e.message ? e.message : e), "error");
    }
  });

  function renderPreview(s, fileName) {
    setStatus(`解析完成：${fileName}`, "ok");
    const products = (s.products || []).map(esc).join("、") || "（未识别到产品标题）";
    const regions = (s.regions || []).map(esc).join("、") || "（未识别到语种）";
    previewEl.innerHTML =
      '<div class="kb-preview-box">' +
      '<div class="kb-stat-row">' +
      `<span class="kb-stat"><b>${s.recordCount}</b> 条话术</span>` +
      `<span class="kb-stat"><b>${s.tableCount}</b> 张表</span>` +
      `<span class="kb-stat"><b>${s.imageCount}</b> 张示例图</span>` +
      "</div>" +
      `<p class="kb-mini"><b>产品：</b>${products}</p>` +
      `<p class="kb-mini"><b>语种/地区：</b>${regions}</p>` +
      '<div class="button-row">' +
      '<button id="kb-confirm" class="primary" type="button">✅ 确认导入团队库</button>' +
      '<button id="kb-cancel" class="secondary" type="button">取消</button>' +
      "</div>" +
      '<small style="color:#888">并进现有团队库（不是清空重来）：重复跳过、同场景内容变了由 AI 判保留哪版、示例图进物料库。旧库会自动备份。</small>' +
      "</div>";
    previewEl.classList.remove("hidden");
    document.getElementById("kb-cancel").addEventListener("click", () => {
      previewEl.classList.add("hidden");
      parsed = null;
      statusEl.classList.add("hidden");
    });
    document.getElementById("kb-confirm").addEventListener("click", confirmImport);
  }

  async function confirmImport() {
    if (!parsed) return;
    const btn = document.getElementById("kb-confirm");
    btn.disabled = true;
    setStatus(
      `正在上传并入库…${parsed.summary.imageCount} 张图片体积较大，请稍候，期间别关侧边栏。`,
      "info"
    );
    try {
      const response = await fetch(`${API_BASE}/api/knowledge/import`, {
        method: "POST",
        headers: adminHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ records: parsed.records, images: parsed.images })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `服务器返回 ${response.status}`);
      renderResult(data);
      previewEl.classList.add("hidden");
      parsed = null;
    } catch (e) {
      setStatus("导入失败：" + (e && e.message ? e.message : e), "error");
    } finally {
      btn.disabled = false;
    }
  }

  function renderResult(d) {
    setStatus("导入完成 ✅", "ok");
    const conf = (d.conflict_detail || [])
      .slice(0, 12)
      .map(
        (c) =>
          `<li>${esc(c.region)}·${esc(c.scene)} → <b>${
            c.decision === "keep_old"
              ? "保留旧版"
              : c.decision === "merge"
              ? "合并"
              : c.decision === "new"
              ? "另起新条"
              : "改旧条(采用新版)"
          }</b>${c.reason ? `<span class="kb-mini2">（${esc(c.reason)}）</span>` : ""}</li>`
      )
      .join("");
    resultEl.innerHTML =
      '<div class="kb-preview-box">' +
      '<div class="kb-stat-row">' +
      `<span class="kb-stat">新增 <b>${d.added}</b></span>` +
      `<span class="kb-stat">改旧条 <b>${d.modified || 0}</b></span>` +
      `<span class="kb-stat">保留旧版 <b>${d.kept_old || 0}</b></span>` +
      `<span class="kb-stat">重复跳过 <b>${d.duplicates}</b></span>` +
      `<span class="kb-stat">图片 <b>${d.images_saved}</b></span>` +
      (d.products_added ? `<span class="kb-stat">新产品 <b>${d.products_added}</b></span>` : "") +
      "</div>" +
      `<p class="kb-mini">团队库：${d.before} → <b>${d.after}</b> 条${
        d.backup ? `　·　已备份旧库 <code>${esc(d.backup)}</code>` : ""
      }</p>` +
      (d.products_added
        ? `<p class="kb-mini">🆕 自动加入产品库：<b>${esc((d.products_added_detail || []).map((p) => p.name).join("、"))}</b>（卖点/账号待你在 products.json 补全）</p>`
        : "") +
      (conf
        ? `<p class="kb-mini"><b>AI 对冲突的处理（前 12 条）：</b></p><ul class="kb-conflicts">${conf}</ul>`
        : "") +
      "</div>";
    resultEl.classList.remove("hidden");
  }
})();

// ===== 红人固定档案（付款/合同/App ID/备注，按名字存档，云端备份） =====
(function initKolProfile() {
  const PROFILE_KEY = "kolProfiles";
  const nameInput = document.getElementById("kol-profile-name");
  const datalist = document.getElementById("kol-profile-datalist");
  const loadBtn = document.getElementById("kol-profile-load");
  const body = document.getElementById("kol-profile-body");
  const autoHint = document.getElementById("kol-profile-auto-hint");
  const saveBtn = document.getElementById("kol-profile-save");
  const deleteBtn = document.getElementById("kol-profile-delete");
  const statusEl = document.getElementById("kol-profile-status");
  // 文本/下拉字段（值用 .value）
  const fields = {
    nickname: document.getElementById("kp-nickname"),
    category: document.getElementById("kp-category"),
    appid: document.getElementById("kp-appid"),
    legalname: document.getElementById("kp-legalname"),
    email: document.getElementById("kp-email"),
    payment: document.getElementById("kp-payment"),
    theme: document.getElementById("kp-theme"),
    recommendReason: document.getElementById("kp-recommend-reason"),
    blacklistReason: document.getElementById("kp-blacklist-reason"),
    notes: document.getElementById("kp-notes")
  };
  // 勾选字段（值用 .checked）：值得合作 / 黑名单
  const checks = {
    recommend: document.getElementById("kp-recommend"),
    blacklist: document.getElementById("kp-blacklist")
  };
  if (!nameInput) return;

  let currentName = "";

  // 规范化 key：去首尾空格、折叠内部空格、转小写。
  // "小美"/"小美 "/"小 美" 都映射同一个 key；displayName 用输入的原始名。
  function profileKey(name) {
    return (name || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  async function getProfiles() {
    const s = await chrome.storage.local.get(PROFILE_KEY);
    return s[PROFILE_KEY] || {};
  }

  async function saveProfiles(profiles) {
    await chrome.storage.local.set({ [PROFILE_KEY]: profiles });
    // 写 kolProfiles 会触发 storage.onChanged → scheduleCloudBackup（kolProfiles 在 BACKUP_KEYS 里），
    // 这里直接显式调一次，确保即时备份。
    if (typeof scheduleCloudBackup === "function") scheduleCloudBackup();
  }

  // 按规范化 key 查找（兼容旧数据：若 normalized key 找不到，回退原始 key）
  function lookupProfile(profiles, name) {
    const k = profileKey(name);
    if (profiles[k] !== undefined) return { key: k, data: profiles[k] };
    // 旧数据兼容：遍历找大小写/空格不同但 normalize 后相同的 key
    for (const [sk, sv] of Object.entries(profiles)) {
      if (profileKey(sk) === k) return { key: sk, data: sv };
    }
    return { key: k, data: null };
  }

  function showStatus(msg, ok) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = ok === false ? "#c0392b" : "#2e7d32";
    statusEl.classList.remove("hidden");
    setTimeout(() => statusEl.classList.add("hidden"), 2500);
  }

  // 填充 datalist（浏览器原生下拉提示，展示 displayName 或 key）
  async function refreshDatalist() {
    if (!datalist) return;
    const profiles = await getProfiles();
    datalist.innerHTML = Object.values(profiles).sort((a, b) => {
      const na = a?.displayName || "";
      const nb = b?.displayName || "";
      return na.localeCompare(nb);
    }).map(p => {
      const v = (p?.displayName || "").replace(/"/g, "&quot;");
      return `<option value="${v}"></option>`;
    }).join("");
  }

  function fillFields(profile) {
    for (const k in fields) fields[k].value = profile?.[k] || "";
    for (const k in checks) checks[k].checked = !!profile?.[k];
  }

  async function loadProfile(name) {
    if (!name) { body.classList.add("hidden"); return; }
    const profiles = await getProfiles();
    const { key, data } = lookupProfile(profiles, name);
    currentName = key;
    fillFields(data || {});
    body.classList.remove("hidden");
  }

  // 打开档案卡时，自动匹配当前打开的 IG 对话名字
  async function autoLoadCurrentKol() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) return;
      const resp = await chrome.tabs.sendMessage(tab.id, { type: "KOL_GET_CONVERSATION_TITLE" }).catch(() => null);
      const name = resp?.title?.trim();
      if (!name) return;
      const profiles = await getProfiles();
      const { data } = lookupProfile(profiles, name);
      if (data) {
        nameInput.value = data.displayName || name;
        loadProfile(name);
        if (autoHint) { autoHint.textContent = `已自动加载「${data.displayName || name}」的档案`; autoHint.classList.remove("hidden"); }
      } else {
        // 填入名字但不自动展开（可能还没建档）
        nameInput.value = name;
        if (autoHint) { autoHint.textContent = `当前对话：${name}（尚未建档，填写后点「💾 保存」）`; autoHint.classList.remove("hidden"); }
      }
    } catch {}
  }

  loadBtn.addEventListener("click", () => loadProfile(nameInput.value.trim()));
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") loadProfile(nameInput.value.trim()); });

  saveBtn.addEventListener("click", async () => {
    const rawName = nameInput.value.trim();
    if (!rawName) { showStatus("请先输入红人名字", false); return; }
    const k = profileKey(rawName);
    currentName = k;
    const profiles = await getProfiles();
    // 保留 displayName（第一次存时用输入的，后续更新时保留原名，除非主动改了输入框）
    const existing = profiles[k] || {};
    const rec = {
      ...existing,
      displayName: rawName, // 输入的最新名字作为展示名
      updatedAt: new Date().toISOString()
    };
    for (const fk in fields) rec[fk] = fields[fk].value.trim();
    for (const ck in checks) rec[ck] = checks[ck].checked;
    profiles[k] = rec;
    await saveProfiles(profiles);
    showStatus("已保存", true);
    refreshDatalist();
  });

  deleteBtn.addEventListener("click", async () => {
    const name = currentName || profileKey(nameInput.value.trim());
    if (!name) return;
    const profiles = await getProfiles();
    const displayName = profiles[name]?.displayName || name;
    if (!confirm(`确定删除「${displayName}」的档案？`)) return;
    delete profiles[name];
    await saveProfiles(profiles);
    fillFields({});
    body.classList.add("hidden");
    nameInput.value = "";
    currentName = "";
    showStatus("已删除", true);
    refreshDatalist();
  });

  document.getElementById("kol-profile-card")?.addEventListener("toggle", (e) => {
    if (e.target.open) { refreshDatalist(); autoLoadCurrentKol(); }
    else if (autoHint) autoHint.classList.add("hidden");
  });

  refreshDatalist();
}());

// ===== 一键清空（原文 / 我想回复） =====
document.querySelectorAll(".clear-btn[data-clear]").forEach(btn => {
  btn.addEventListener("click", () => {
    const el = document.getElementById(btn.dataset.clear);
    if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
  });
});
