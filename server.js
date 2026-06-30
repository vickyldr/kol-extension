const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ——— 轻量缓存：省 token + 省响应时间 ———
function hashKey(obj) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return crypto.createHash("sha1").update(s).digest("hex");
}
class TTLCache {
  constructor(max, ttlMs) {
    this.max = max;
    this.ttl = ttlMs;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) { this.misses += 1; return undefined; }
    if (Date.now() > e.exp) { this.map.delete(key); this.misses += 1; return undefined; }
    this.map.delete(key);
    this.map.set(key, e); // 触达即刷新到队尾（LRU）
    this.hits += 1;
    return e.value;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, exp: Date.now() + this.ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}
// 翻译是确定性的（temperature 0），可长缓存；判断稍易变，缓存 1 小时。
// 两个缓存对【全团队共享】：一个人翻过的常用话术，其他同事直接命中。
const translateCache = new TTLCache(20000, 24 * 3600 * 1000);
const judgeCache = new TTLCache(3000, 3600 * 1000);
// 同句并发去重：多个同事同一时刻翻同一条新消息时，只发一次 API、共享同一个结果，
// 避免人多时对同一句话重复调用、互相拖慢。
const translateInflight = new Map();

const HOST = process.env.KOL_ASSISTANT_HOST || "0.0.0.0";
const PORT = Number(process.env.KOL_ASSISTANT_PORT || 3210);
const MODEL = process.env.DASHSCOPE_MODEL || "qwen-flash";
// 分流原则：你要"等结果"的全用快模型；只有后台默默跑、你不等的，才用慢但聪明的。
// 全部用 flash（最便宜），免费额度用完后省钱。
const MODEL_FAST = process.env.DASHSCOPE_MODEL_FAST || MODEL;
const MODEL_SMART = process.env.DASHSCOPE_MODEL_SMART || "qwen-flash";
// 团队口令：部署到 VPS 给团队用时设置，未设置则为本机单人模式（不校验）。
const AUTH_TOKEN = process.env.KOL_ASSISTANT_TOKEN || "";
// 管理员口令：设置后，只有带正确管理员口令的请求才能编辑/删除已有话术。
const ADMIN_TOKEN = process.env.KOL_ASSISTANT_ADMIN_TOKEN || "";
const ROOT = __dirname;
// 用户数据目录（话术库、产品、知识库覆盖）：部署时指向独立目录（VPS 上的 ~/kol-data），
// 更新代码不会覆盖它。未设置时回退到代码自带的 data/，保持本机单人模式不变。
const DATA_DIR = process.env.KOL_DATA_DIR || path.join(ROOT, "data");
const SEED_DIR = path.join(ROOT, "data");
// 边界规则（重要）：
// - 代码自带 data/ = 出厂种子，跟着代码走（拆仓库/装插件时带的默认话术）。
// - KOL_DATA_DIR（VPS 上的持久目录）= 运行数据，永不进 git。
// 下面这个解析：同名文件若在 KOL_DATA_DIR 里存在，就用线上那份（覆盖种子）；
// 不存在才回退到代码种子。所以你想单独维护/多项目的知识库，放 KOL_DATA_DIR 即可，
// 不会污染代码仓库，也不会在更新代码时被覆盖。
function seedOrLive(name) {
  const live = path.join(DATA_DIR, name);
  if (DATA_DIR !== SEED_DIR && fs.existsSync(live)) return live;
  return path.join(SEED_DIR, name);
}
// 内置资料（出厂种子，可被 KOL_DATA_DIR 同名文件覆盖）：知识库、快捷模板、话术脚本。
// 知识库读取：每次动态判断「线上优先、否则种子」（首次导入后线上文件出现，同进程内即切到线上）。
const knowledgeReadPath = () => seedOrLive("knowledge-base.json");
// 知识库写入：永远写线上目录（DATA_DIR），绝不回写种子，避免污染代码仓库 / 被代码更新覆盖。
const KNOWLEDGE_LIVE_PATH = path.join(DATA_DIR, "knowledge-base.json");
const QUICK_TEMPLATES_PATH = seedOrLive("quick-templates.json");
const PLAYBOOK_PATH = seedOrLive("playbook.json");
// 用户数据：产品资料、话术存档（放持久目录，由团队在用中增改）。
const PRODUCTS_PATH = path.join(DATA_DIR, "products.json");
const ARCHIVE_PATH = path.join(DATA_DIR, "scenario-archive.json");
// 物料库：metadata 存 assets.json，图片文件存 assets/ 子目录。
const ASSETS_PATH = path.join(DATA_DIR, "assets.json");
const ASSETS_DIR = path.join(DATA_DIR, "assets");
// 云端备份：每个员工按自己的 ins id 存一份 backups/<id>.json（合作进度/快捷回复/提醒等）。
// 浏览器缓存清了/换电脑也不丢——填同样的 ins id 就能恢复。
const BACKUP_DIR = path.join(DATA_DIR, "backups");
// ins id 清洗成安全文件名：只留字母数字和 . _ -，转小写，截断长度，避免路径穿越。
function backupFile(userId) {
  const safe = String(userId || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 80);
  if (!safe) return "";
  return path.join(BACKUP_DIR, `${safe}.json`);
}

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v"
};

// 回复风格分两层，避免「极简」和「日语礼貌」在同一段里互相打架：
//   ① 核心层 REPLY_STYLE_CORE：纯业务/内容规则，与语言无关，任何回复都生效。
//   ② 语气层：二选一、互斥。非日语用 REPLY_STYLE_DEFAULT（精简口语）；日语用 REPLY_STYLE_JA（礼貌敬语）。
// 调用处一律用 replyStyleFor(replyLanguage, sampleText) 拼出「核心层 + 对应语气层」。
const REPLY_STYLE_CORE = `对外回复通用规则（任何语言都必须遵守）：
- 【绝不复述上下文】上下文和对方说过的话只用来帮你理解，回复里绝对不要重复、引用、复述上下文或对方的原话。
- 打招呼用通用问候，不带对方名字或 ID，不要"【填写名字】""{name}"这类占位。
- 尽量不留变量：只有价格、日期、链接、数量等必须由人确认的关键信息缺失时才保留占位，其余自然写顺。
- 忠于原意：严格按运营给的中文意图或草稿写，不自行添加运营没表达的承诺、理由、数字或信息。`;

const REPLY_STYLE_DEFAULT = `回复风格（默认，适用于日语以外的语言）：
- 【极简短】像真人发私信、口头说话一样，一般 1~3 句，越短越好。能用词语或短语就别写成整句，能省的客套一律省掉。宁可短，不要长。
- 【口语自然】轻松、友好、像朋友聊天，不要书面信、不要正式腔、不堆客套、不夸张吹捧。可以用一个很短的问候（如 Hi / 你好），但不是必须；不写多余的开场白和结尾客套。
- 【直奔重点】第一句就说要点，不铺垫、不绕弯。`;

// 日语专用语气层：日本商务沟通必须礼貌客套，绝不能套用其他语言的极简直白风格。
const REPLY_STYLE_JA = `回复风格（日语专用，覆盖上面的"极简/口语"要求）：
日语必须自然、专业、礼貌，整体语气温和、谦逊——不能照搬其他语言的极简直白。
- 使用敬语（です・ます体），保持商务沟通应有的正式程度。
- 避免「〜してください」连续结句，优先更委婉的请求表达：「〜いただけますでしょうか」「〜お願いできますでしょうか」「〜いただけますと幸いです」「〜お願いいたします」。
- 适当加入缓冲表达：「恐れ入りますが」「お手数ですが」「恐縮ですが」「もし可能でしたら」。
- 多用商务中自然的表达「〜となります」「〜の予定です」「〜かと思います」，避免语气过于武断。
- 仍要忠于运营的原意，礼貌但不啰嗦，不堆砌与意图无关的客套。`;

// 判断这次回复要不要走日语礼貌层：reply_language 指明日语，或样本文本里含假名。
function isJapaneseTarget(replyLanguage, sampleText) {
  const lang = String(replyLanguage || "").toLowerCase();
  if (/日本|日语|日文|japanese|にほんご|nihongo/.test(lang) || /\bja\b/.test(lang)) return true;
  // 含平假名/片假名 → 日语（仅有汉字不算，避免和中文混淆）
  if (/[぀-ゟ゠-ヿ]/.test(String(sampleText || ""))) return true;
  return false;
}

// 拼出最终风格指令：核心层 + 对应语气层（日语 or 默认），二选一互斥不冲突。
function replyStyleFor(replyLanguage, sampleText) {
  const tone = isJapaneseTarget(replyLanguage, sampleText) ? REPLY_STYLE_JA : REPLY_STYLE_DEFAULT;
  return `${REPLY_STYLE_CORE}\n\n${tone}`;
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-KOL-Token, X-KOL-Admin",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, maxBytes = 48 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error("上传内容过大（视频上限约 33MB），请压缩或改用链接。");
      error.code = "TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

// 按文件 mtime 缓存解析结果：playbook.json 等大文件不必每次请求都读盘+解析。
// 写入后 mtime 变化会自动失效重读。
const _jsonCache = new Map();
function loadJson(file, fallback) {
  try {
    const stat = fs.statSync(file);
    const hit = _jsonCache.get(file);
    if (hit && hit.mtime === stat.mtimeMs) return hit.value;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    _jsonCache.set(file, { mtime: stat.mtimeMs, value });
    return value;
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(temporary, file);
}

function compactKnowledge(records, message) {
  const words = String(message || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2);

  return records
    .map((record) => {
      const haystack = JSON.stringify(record).toLowerCase();
      const score = words.reduce(
        (sum, word) => sum + (haystack.includes(word) ? 1 : 0),
        0
      );
      return { record, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(({ record }) => record);
}

function parseJsonText(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error("AI 返回内容不完整或格式异常，请重试。");
  }
}

function findProduct(productId) {
  const products = loadJson(PRODUCTS_PATH, []);
  return (
    products.find((product) => product.id === productId) ||
    products.find((product) => product.id === "generic") ||
    null
  );
}

function sanitizeCandidates(records, product) {
  if (!product || product.id !== "generic") return records;

  return records.map((record) => ({
    source: record.source,
    stable_id: record.stable_id,
    scene: record.scene,
    note:
      "仅参考该记录的沟通流程和场景分类。禁止复用其中的品牌名、产品介绍、账号、链接、平台数量、视频时长、价格、授权期限或付款承诺。"
  }));
}

function normalizeAnalysis(value) {
  const analysis = value?.output_contract || value?.analysis || value;
  const guidance = analysis?.internal_guidance || {};

  return {
    detected_language: analysis?.detected_language || "未知",
    literal_chinese:
      analysis?.literal_chinese || analysis?.chinese_translation || "",
    implied_meaning: analysis?.implied_meaning || "无明显言外之意",
    implication_confidence: analysis?.implication_confidence || "low",
    intent: analysis?.intent || "待判断",
    stage: analysis?.stage || "待判断",
    matched_source: analysis?.matched_source || "新场景",
    match_type: ["exact", "partial", "new_scenario"].includes(
      analysis?.match_type
    )
      ? analysis.match_type
      : "new_scenario",
    reply_target: analysis?.reply_target || "",
    reply_chinese: analysis?.reply_chinese || "",
    alternative_target: analysis?.alternative_target || "",
    alternative_chinese: analysis?.alternative_chinese || "",
    required_variables:
      analysis?.required_variables || analysis?.missing_information || [],
    mentioned_items: Array.isArray(analysis?.mentioned_items)
      ? analysis.mentioned_items.map((item) => ({
          term: String(item?.term || ""),
          plain_explanation: String(item?.plain_explanation || ""),
          previous_context:
            ["yes", "no", "unknown"].includes(item?.previous_context)
              ? item.previous_context
              : "unknown",
          attention: String(item?.attention || ""),
          suggested_action: String(item?.suggested_action || "")
        }))
      : [],
    internal_guidance: {
      level: ["info", "confirm", "block"].includes(guidance.level)
        ? guidance.level
        : "confirm",
      explanation: guidance.explanation || "",
      question_for_tl: guidance.question_for_tl || "",
      temporary_reply_target: guidance.temporary_reply_target || "",
      temporary_reply_chinese: guidance.temporary_reply_chinese || "",
      operator_reminders: guidance.operator_reminders || []
    },
    risk_warning: analysis?.risk_warning || ""
  };
}

async function callQwen({ system, user, maxTokens = 1200, temperature = 0.1, model }) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    const error = new Error("尚未配置阿里云百炼 API Key。");
    error.code = "MISSING_DASHSCOPE_KEY";
    throw error;
  }

  const response = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model || MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ],
        response_format: { type: "json_object" },
        temperature,
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(55000)
    }
  );

  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      body?.error?.message || `百炼请求失败：${response.status}`
    );
  }
  return parseJsonText(body?.choices?.[0]?.message?.content);
}

// 通用多轮聊天：直接返回纯文本，不强制 JSON。
async function chatQwen(messages, { maxTokens = 1200, temperature = 0.5, model } = {}) {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) {
    const error = new Error("尚未配置阿里云百炼 API Key。");
    error.code = "MISSING_DASHSCOPE_KEY";
    throw error;
  }
  const response = await fetch(
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model || MODEL,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(55000)
    }
  );
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message || `百炼请求失败：${response.status}`);
  }
  return String(body?.choices?.[0]?.message?.content || "").trim();
}

async function chatWithQwen(payload) {
  const history = Array.isArray(payload.messages) ? payload.messages : [];
  const system = `你是中国 KOL 运营团队的 AI 助手，名字叫小助手。运营会问你各种问题：
红人消息的翻译和理解、谈判砍价思路、合作流程、某条话术怎么说、某个红人值不值得合作、
某种语言/地区的习惯、写一段外语内容等等。请像一个懂行、靠谱的同事一样用简洁中文回答；
需要外语时给出对应语言示例并附中文。
不要编造价格、日期、授权期限、付款承诺、平台数据等必须由人确认的信息；不确定就说不确定、或建议问 TL。`;
  const messages = [
    { role: "system", content: system },
    ...history
      .slice(-20)
      .map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "")
      }))
      .filter((m) => m.content)
  ];
  const answer = await chatQwen(messages, { maxTokens: 1200, temperature: 0.5, model: MODEL_FAST });
  return { answer };
}

async function analyzeWithQwen(payload) {
  const product = findProduct(payload.productId);
  const archiveRecords = loadJson(ARCHIVE_PATH, []).filter(
    (record) =>
      record.status === "active" &&
      (!record.product_id ||
        record.product_id === "generic" ||
        record.product_id === payload.productId)
  );
  const candidates = sanitizeCandidates(compactKnowledge(
    [
      ...archiveRecords.map((record) => ({
        source: "运营确认存档",
        stable_id: record.id,
        scene: record.scene_name,
        fields: {
          trigger_examples: record.trigger_examples,
          correct_understanding: record.correct_understanding,
          external_reply_target: record.external_reply_target,
          external_reply_chinese: record.external_reply_chinese,
          internal_guidance: record.internal_guidance,
          required_variables: record.required_variables
        }
      })),
      ...loadJson(knowledgeReadPath(), [])
    ],
    payload.message
  ), product);

  const systemPrompt = `你是一个服务于中国 KOL 运营团队的多语言沟通助手，主要处理 Instagram 和邮件中的海外创作者合作。

你必须严格区分两种内容：
A. 对外回复：允许直接复制给红人，只能包含自然、礼貌的沟通内容。
B. 内部处理建议：仅供运营查看，包括询问 TL、预算上限、操作步骤、教程提醒、风险和判断依据。内部内容绝不能泄漏到对外回复。

工作规则：
1. 准确翻译红人消息，同时分别说明“字面意思”和“可能的言外之意”。言外之意必须标注不确定性，不可把猜测当事实。
1a. 必须先识别句子的施事者、接收者和动作方向，明确“谁让谁做什么”。祈使句默认是说话者要求收信人执行动作。例如“请发送发票给我”绝不能翻译或理解成“我已收到你的发票”。
1b. 原文没有说“已收到、已完成、已同意、已付款”等事实时，禁止自行补成既成事实。上下文为空时，必须把消息视为突然出现的独立消息，不得虚构此前沟通。
2. 判断合作阶段和红人意图，从候选话术中匹配最合适场景。
3. 产品资料只用于当前产品；不得把其他产品的名称、账号、Brief 或规则混入回复。
4. 不得编造价格、币种、视频数量、日期、平台、授权期限、付款时间、链接或合同条件。
5. 缺少关键变量时，列入 required_variables，并生成可安全暂时发送的回复。
6. 涉及价格、广告授权、二次使用、合同、付款承诺、删帖重发、强制好评等事项时，判断是否必须问 TL。
7. internal_guidance.level 只能是 info、confirm 或 block：
   - info：操作提醒，不阻止发送；
   - confirm：建议问 TL，但可先发临时回复；
   - block：必须问 TL，禁止发送承诺性正式回复。
8. internal_guidance.question_for_tl 要写成运营可以直接复制给 TL 的中文问题。
9. 如果需要问 TL，temporary_reply_target 和 temporary_reply_chinese 提供等待确认期间可以先发给红人的安全回复。
10. 语言规则（最重要，必须严格执行）：reply_target、alternative_target、internal_guidance.temporary_reply_target 必须使用红人原消息所用的语言，也就是 detected_language。红人说泰语就用泰语，说日语就用日语，说西班牙语就用西班牙语。绝对禁止在红人没有用英语时把回复写成英语。只有当红人本人就用英语沟通时才用英语。每条外语回复都要附准确中文对照。
11. matched_source 使用人类可读场景名，不使用行号。
12. 返回的 JSON 顶层必须直接包含 detected_language、literal_chinese、intent 等字段。不得增加 output_contract、analysis、result 等外层包装。
13. 当 selected_product.id 为 generic 时，禁止出现 Recco 或候选话术中的任何具体品牌、账号、链接、视频时长、平台数量和商务条件；缺失内容必须作为变量或澄清问题。
14. 提取消息中新出现的业务事项、文件、费用、平台功能或专业术语到 mentioned_items。不要只重复翻译，要用中国运营能懂的白话解释它在当前语境可能是什么。
15. 对每个 mentioned_item 核对 conversation_context：
   - 明确在上下文出现过：previous_context=yes；
   - 上下文非空且未出现：previous_context=no；
   - 没有提供上下文或无法判断：previous_context=unknown。
   不得在没有完整历史时断言“之前没有聊过”，只能说“当前提供的上下文中未看到”或“无法判断”。
16. 专业词可能存在地区差异时必须提醒。例如 invoice / billing document / เอกสารวางบิล 可能指请款单、账单、形式发票、税务发票或付款所需资料，不能默认等同于中国增值税发票，应建议确认具体文件类型。

${replyStyleFor(payload.replyLanguage || payload.detectedLanguage || "", payload.message)}`;

  const outputContract = {
    detected_language: "语言",
    literal_chinese: "中文准确意译",
    implied_meaning: "可能的言外之意；没有则写无明显言外之意",
    implication_confidence: "high|medium|low",
    intent: "红人意图",
    stage: "合作阶段",
    matched_source: "匹配场景名",
    match_type: "exact|partial|new_scenario",
    reply_target: "正式外语回复；若 block 则使用安全临时回复",
    reply_chinese: "正式回复中文对照",
    alternative_target: "备选外语回复",
    alternative_chinese: "备选回复中文对照",
    required_variables: ["需要运营填写的变量"],
    mentioned_items: [
      {
        term: "原文提到的事项或术语",
        plain_explanation: "结合语境的白话解释，而不是简单重复中文词",
        previous_context: "yes|no|unknown",
        attention: "为什么值得注意",
        suggested_action: "建议运营下一步怎么确认"
      }
    ],
    internal_guidance: {
      level: "info|confirm|block",
      explanation: "为什么需要或不需要内部确认",
      question_for_tl: "可直接发给 TL 的中文问题；不需要则为空字符串",
      temporary_reply_target: "等待 TL 时先发给红人的外语回复；不需要则为空字符串",
      temporary_reply_chinese: "临时回复中文对照；不需要则为空字符串",
      operator_reminders: ["仅内部可见的操作提醒"]
    },
    risk_warning: "发送前风险提示"
  };

  const userPrompt = JSON.stringify({
    output_contract: outputContract,
    selected_product: product,
    channel: payload.channel || "Instagram",
    conversation_context: payload.context || "",
    creator_message: payload.message,
    operator_goal: payload.operatorGoal || "",
    knowledge_candidates: candidates
  });

  return normalizeAnalysis(
    await callQwen({
      model: MODEL_FAST,
      system: systemPrompt,
      user: userPrompt,
      maxTokens: 3000,
      temperature: 0.15
    })
  );
}

// 把运营随口一句话解析成「事项 + 到点时间」。当前时间由客户端传入。
async function parseTodo(payload) {
  const now = String(payload.now || "");
  const result = await callQwen({
    system: `你把运营随手写的一句待办，解析成"事项 + 具体到点时间"。
当前时间是：${now}（ISO 8601，含时区）。据此把"5天后""明天下午3点""周五""下周一"等相对说法换算成具体日期。
没明说时间就默认当天 10:00。事项里去掉时间词，只留要做的事。
只返回 JSON：{"text":"事项","date":"YYYY-MM-DD","time":"HH:MM"}。`,
    user: JSON.stringify({ sentence: payload.sentence || "" }),
    maxTokens: 200,
    temperature: 0,
    model: MODEL_FAST
  });
  return {
    text: String(result.text || payload.sentence || "").trim(),
    date: String(result.date || "").trim(),
    time: String(result.time || "10:00").trim()
  };
}

// 合作情况小结：读一段对话（消息数组或粘贴的纯文本），给运营快速回顾进展。
async function summarizeConversation(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const rawText = String(payload.text || "").trim();
  const prev = String(payload.previousSummary || "").trim();
  // 预览模式：手上只有红人最新一句（收件箱预览），没点进过对话。
  // 不跑 12 步流程清单（会全是"未见"），只把这句外语翻译+归纳成一句中文：他说了啥、想要啥。
  // 给提醒卡片当「最新进度」用——运营看不懂外语，IG 原文对他没用，这里必须是中文 gist。
  if (payload.mode === "preview") {
    const previewText = (rawText || messages.map((m) => m && m.text).filter(Boolean).join(" ")).slice(0, 600);
    if (!previewText) return { summary: "" };
    const result = await callQwen({
      system: `你帮看不懂外语的中国 KOL 运营，把红人发来的最新一句消息，归纳成一句简短中文。
要点：说清红人表达了什么、想要什么或在等什么（如果能看出来）。
规则：
- 只用一句中文，不超过 30 字，不要分点、不要加引号、不要附原文。
- 忠实原意，绝不编造金额/日期/承诺等没说的信息。
- 看不出实质内容（纯寒暄/表情）就用一句话点明，例如"只是打招呼"。
只返回 JSON：{"summary":"一句中文"}。`,
      user: JSON.stringify({ creator_name: payload.creatorName || "", latest_message: previewText }),
      maxTokens: 120,
      temperature: 0.2,
      model: MODEL_FAST
    });
    return { summary: String(result.summary || "").trim() };
  }
  const systemPrompt = `你帮中国 KOL 运营整理一个红人合作的进展，输出一份"按合作流程顺序排列的清单"，每一步都标明做了没做。
固定按这个顺序逐条输出，每条开头用 ✅(已完成) / ⬜(未做或在等) / ➖(不涉及)：
1. 建联 / 触达
2. 报价确认
3. 要到账号（IG handle / 账号 ID）
4. 合同 / 收款信息
5. 合同已发 / 已签
6. brief 已发
7. 积分 / 会员充值
8. 初稿
9. 修改稿
10. 审核通过
11. 发布 + 帖子链接
12. 付款
规则：
- 每条后面跟一句话依据或细节（例：✅ 报价确认 — 300USD 已谈妥）；没依据的标 ⬜ 并写"未见"。
- 只写对话里有依据的，绝不编造。
- 清单后另起一段 "⚠️ 备注：" 写流程之外的风险/异常/红人态度/下一步建议（没有就写"无"）。
${prev ? "下面是这条对话之前的进展清单。请在它基础上，用新的对话内容更新各步状态、补充细节，【不要丢掉之前已确认的事实】，只做增量更新：\n----\n" + prev + "\n----\n" : ""}只返回 JSON：{"summary":"清单文本"}。`;
  const result = await callQwen({
    system: systemPrompt,
    user: JSON.stringify({
      creator_name: payload.creatorName || "",
      is_group: Boolean(payload.isGroup),
      recent_messages: messages.slice(-80),
      pasted_text: rawText.slice(0, 6000)
    }),
    maxTokens: 1000,
    temperature: 0.2,
    model: MODEL_FAST
  });
  return { summary: String(result.summary || "").trim() };
}

// 快出回复：只生成「外语回复 + 中文对照」，不做完整分析，追求 3-5 秒先出。
async function quickReply(payload) {
  const product = findProduct(payload.productId);
  const systemPrompt = `你是中国 KOL 运营的双语回复助手。根据红人的消息和运营的回复意图，
直接给出一条可以发出去的对外回复（红人所用语言）+ 中文对照。只出回复，不做分析、不写内部建议。
语言规则：reply_target 必须用红人原消息的语言（detected_language）；红人没用英语就别用英语。
不要编造价格、日期、授权、平台、付款时间、链接等必须由人确认的信息，缺就留占位或不提。
${replyStyleFor(payload.replyLanguage || "", payload.message)}
只返回 JSON：{"detected_language":"语言","reply_target":"外语回复","reply_chinese":"中文对照"}。`;
  const result = await callQwen({
    system: systemPrompt,
    user: JSON.stringify({
      selected_product: product ? { id: product.id, name: product.name } : null,
      creator_message: payload.message || "",
      conversation_context: payload.context || "",
      operator_goal: payload.operatorGoal || "",
      reply_language: payload.replyLanguage || ""
    }),
    maxTokens: 600,
    temperature: 0.2,
    model: MODEL_FAST
  });
  return {
    detected_language: String(result.detected_language || "").trim(),
    reply_target: String(result.reply_target || "").trim(),
    reply_chinese: String(result.reply_chinese || "").trim()
  };
}

// 主动跟进话术分级生成：红人久不回时，逐级升级；日语走「見送り」文化框架而非威胁。
const FOLLOWUP_GUIDE = {
  1: "二次跟进（轻催）：礼貌问候 + 跟进上次的事，问问对方近况、有没有什么顾虑，语气轻松不催逼。",
  2: "再跟进（稍直接）：先为多次打扰致歉，再直接确认上次事情的进展，主动问是否有不清楚的地方。",
  3: "最后跟进（礼貌收尾）：礼貌但明确——如果近期不方便，我们这次先暂停 / 把排期释放给其他合作；得体不指责、给对方台阶。"
};
const FOLLOWUP_GUIDE_JA = {
  1: "二次跟进：柔らかく状況を伺う。「お世話になっております。先日の件、その後いかがでしょうか。お手すきの際にご確認いただけますと幸いです。」のトーン。",
  2: "再跟进：度々の連絡を詫びてから確認。「度々のご連絡失礼いたします。○○の件、ご検討状況はいかがでしょうか。ご不明点があればお気軽に。」のトーン。",
  3: "最後（婉拒・見送り、絶対に威圧しない）：「もし今回はタイミングが合わないようでしたら、一旦今回のお話は見送らせていただければと存じます。ご縁がありましたら、またの機会にぜひ。」——『見送り』『またの機会に』で体面よく締める。"
};
async function followupReply(payload) {
  const level = Math.min(Math.max(Number(payload.level) || 1, 1), 3);
  const ja = isJapaneseTarget(payload.replyLanguage, payload.message || payload.context || "");
  const guide = (ja ? FOLLOWUP_GUIDE_JA : FOLLOWUP_GUIDE)[level];
  const systemPrompt = `你是中国 KOL 运营的双语跟进助手。红人在我方发消息后一直没回，现在要主动发一条「跟进」消息（红人所用语言）+ 中文对照。只出跟进话术，不做分析、不写内部建议。
本次跟进级别要求：${guide}
语言规则：用红人原消息/对话所用语言（detected_language）；红人没用英语就别用英语。${ja ? "日语：绝不用『威胁/通牒』式表达，按上面『見送り・またの機会に』文化框架收尾。" : ""}
不要编造价格、日期、授权、平台、付款、链接等必须由人确认的信息。
${replyStyleFor(payload.replyLanguage || "", payload.message || "")}
只返回 JSON：{"detected_language":"语言","reply_target":"外语跟进话术","reply_chinese":"中文对照"}。`;
  const result = await callQwen({
    system: systemPrompt,
    user: JSON.stringify({
      conversation_context: payload.context || "",
      last_creator_message: payload.message || "",
      follow_up_level: level,
      reply_language: payload.replyLanguage || ""
    }),
    maxTokens: 600,
    temperature: 0.3,
    model: MODEL_FAST
  });
  return {
    level,
    detected_language: String(result.detected_language || "").trim(),
    reply_target: String(result.reply_target || "").trim(),
    reply_chinese: String(result.reply_chinese || "").trim()
  };
}

async function translateFaithfully(text) {
  const cacheKey = hashKey("translate:" + text);
  const cached = translateCache.get(cacheKey);
  if (cached) return cached;
  // 已有同一句正在翻：直接等它的结果，不再重复发请求。
  const pending = translateInflight.get(cacheKey);
  if (pending) return pending;
  const promise = translateOnce(text, cacheKey).finally(() =>
    translateInflight.delete(cacheKey)
  );
  translateInflight.set(cacheKey, promise);
  return promise;
}

async function translateOnce(text, cacheKey) {
  const result = await callQwen({
    system: `你是聊天消息翻译器。只做忠实翻译，不分析、不回复、不补充上下文。
必须准确保留主语、宾语、动作方向、时态、否定、疑问和祈使语气，特别明确“谁让谁做什么”。
原文没有说已发生的事情，不得翻译成已发生。例如“请把发票发给我”只能翻译为请求对方发送发票，不能写成“已收到发票”。
品牌名、人名、金额、日期、链接按原文保留。
如果原文已经是中文，也原样返回。
遇到专业词、地区性商务词或直译后仍难懂的词时，额外给出白话解释。例：billing document / เอกสารวางบิล 不要只写“发票”，应说明它通常泛指用于请款或付款结算的文件，具体可能是账单、请款单、形式发票或税务发票，需要向对方确认。
只返回 JSON：{"translation":"中文翻译","source_language":"语言","uncertain":false,"term_notes":[{"term":"原词或中文术语","explanation":"白话解释"}]}。`,
    user: JSON.stringify({ message: text }),
    maxTokens: 350,
    temperature: 0,
    model: MODEL_FAST
  });

  const out = {
    translation: String(result.translation || "").trim(),
    source_language: result.source_language || "未知",
    uncertain: Boolean(result.uncertain),
    term_notes: Array.isArray(result.term_notes)
      ? result.term_notes
          .map((item) => ({
            term: String(item?.term || "").trim(),
            explanation: String(item?.explanation || "").trim()
          }))
          .filter((item) => item.term && item.explanation)
      : []
  };
  if (out.translation) translateCache.set(cacheKey, out);
  return out;
}

// 提醒判断：读一段对话的最近几条消息，判断红人有没有在等我回、
// 处在哪个推进阶段、有没有口头答应却没推进、要不要跟进、有没有约 DDL。
// 一切只读对话文本（由插件搭便车采集），不碰 IG 账号。
async function judgeThread(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const cacheKey = hashKey({
    m: messages.slice(-12),
    p: payload.productId || "",
    g: Boolean(payload.isGroup)
  });
  const cached = judgeCache.get(cacheKey);
  if (cached) return cached;
  const systemPrompt = `你是中国 KOL 运营团队的 AI 助理，帮运营盯住每个红人对话有没有“该我处理却被漏掉”的情况。
你只会看到一段对话最近的几条消息。每条消息标了 from：
- "me"：运营本人发的；
- "colleague"：同一团队别的同事发的（账号通常以产品名开头，如 recco / rythmix / aicatch / vivavideo）；
- "creator"：红人（合作的创作者）发的。

关键判断规则：
1. 只有 from="me" 才算“我回过了”。同事(colleague)说话【绝不】算我处理了——一个群一般只由一个同事对接，别的同事插话通常是别的事，我照样得自己跟进。
2. 寒暄收尾要识别：如果红人最后只是“ok / thanks / 谢谢 / 👍”这类客套收尾，且没有待办，needs_my_reply 和 needs_follow_up 都为 false，is_pleasantry=true。
3. KOL 合作推进有固定节点，每个节点我都在“等红人交某样东西”。红人只是口头答应(“ok / sure / 好的”)但东西一直没给，就要跟进。节点与建议跟进时间：
   - 触达后：等红人回应是否有兴趣 —— 2 天没回提醒催回复
   - 询价后：等报价 / 档期 —— 2 天
   - 要账号后：等红人给 IG handle / 账号 ID（常见“说 ok 却一直不给”）—— 1 天
   - 要合同信息后：等收款 / 合同信息 —— 2 天
   - 约定初稿：等初稿（到约定交稿日）—— 到期当天或超 1 天
   - 发了修改意见：等修改稿 —— 2 天
   - 审核通过后：等发布 + 帖子链接 —— 2 天
4. 不完全拘泥节点表：如果你发现节点表之外、但明显会拖黄或需要运营留意的情况（如红人说要出差/旅行可能延期、反问了一个没人回答的问题、提出了新的条件），写进 ai_note 提醒运营。
5. DDL 判断：如果当前阶段本该有一个明确的交付时间（如已答应合作/已答应做视频），但整段对话里【从没约定过交稿时间】，should_ask_deadline=true，并给一句可以直接问红人的话术（用红人所用语言，附中文）。否则 should_ask_deadline=false。
6. 不要编造价格、日期、授权、付款等必须由人确认的信息。
7. 只返回 JSON，不要额外文字。`;

  const outputContract = {
    is_pleasantry: "true|false：红人最后是否只是寒暄收尾、无需动作",
    needs_my_reply: "true|false：红人是否在等我本人(me)回复",
    stage: "当前合作阶段的简短中文描述",
    waiting_for: "我正在等红人交的东西；没有则空字符串",
    needs_follow_up: "true|false：是否该跟进红人（我发了/口头答应了但没推进）",
    follow_up_after_days: "数字：从最后一条我方消息算，几天没动静就该提醒",
    has_deadline: "true|false：当前阶段是否已经约定了明确的交付/交稿时间",
    should_ask_deadline: "true|false：该不该提示运营去问红人要个 DDL",
    suggested_ask_deadline_text:
      "should_ask_deadline 为 true 时，给一句可直接发给红人问档期/约交稿的话（红人所用语言）+（中文对照）；否则空字符串",
    reminder_label: "给运营看的一句话提醒，说清楚该对谁做什么；不需要提醒则空字符串",
    ai_note: "节点表之外值得运营留意的事；没有则空字符串"
  };

  const result = await callQwen({
    system: systemPrompt,
    user: JSON.stringify({
      output_contract: outputContract,
      is_group: Boolean(payload.isGroup),
      creator_name: payload.creatorName || "",
      product_id: payload.productId || "",
      recent_messages: messages.slice(-12)
    }),
    maxTokens: 700,
    temperature: 0.1,
    model: MODEL_SMART
  });

  const toBool = (v) => v === true || v === "true";
  let days = Number(result.follow_up_after_days);
  if (!Number.isFinite(days) || days < 0) days = 2;
  const out = {
    is_pleasantry: toBool(result.is_pleasantry),
    needs_my_reply: toBool(result.needs_my_reply),
    stage: String(result.stage || "").trim(),
    waiting_for: String(result.waiting_for || "").trim(),
    needs_follow_up: toBool(result.needs_follow_up),
    follow_up_after_days: days,
    has_deadline: toBool(result.has_deadline),
    should_ask_deadline: toBool(result.should_ask_deadline),
    suggested_ask_deadline_text: String(
      result.suggested_ask_deadline_text || ""
    ).trim(),
    reminder_label: String(result.reminder_label || "").trim(),
    ai_note: String(result.ai_note || "").trim()
  };
  judgeCache.set(cacheKey, out);
  return out;
}

async function askQwen(payload) {
  const product = findProduct(payload.productId);
  const result = await callQwen({
    model: MODEL_FAST,
    system: `你是中国 KOL 运营人员的问答助手。回答用户针对当前红人消息提出的问题。
必须忠于原文，特别检查主语、宾语、动作方向、时态和祈使句，不能把“对方要求我方发送”说成“对方已经发送/我方已经收到”。
原文没有提供的上下文必须明确说不知道，不得虚构此前聊过什么。
产品资料只能作为背景，不得编造价格、日期、授权或付款条件。
用简洁中文回答；如用户要求，可给出目标语言回复。
只返回 JSON：{"answer":"回答内容"}。`,
    user: JSON.stringify({
      creator_message: payload.message || "",
      conversation_context: payload.context || "",
      selected_product: product,
      previous_analysis: payload.analysis || null,
      question: payload.question || ""
    }),
    maxTokens: 900,
    temperature: 0.15
  });
  return { answer: String(result.answer || "").trim() };
}

// 确定要翻成的外语：手选/已识别优先；都没有时，先确定性识别红人原文的语言
// （复用翻译函数的 source_language，通常命中缓存近乎零成本），把具体语言名传给生成，
// 不让弱模型自己猜——否则它会习惯性默认成英语，红人说泰语也翻成英语。
async function resolveReplyLanguage(payload) {
  const explicit =
    String(payload.replyLanguage || "").trim() ||
    String(payload.detectedLanguage || "").trim();
  if (explicit) return explicit;
  const msg = String(payload.message || "").trim();
  if (!msg) return "";
  try {
    const t = await translateFaithfully(msg);
    const src = String(t.source_language || "").trim();
    if (src && src !== "未知" && src !== "中文") return src;
  } catch (_) {}
  return "";
}

async function rewriteReply(payload) {
  const product = findProduct(payload.productId);
  const direction = payload.direction;

  if (direction === "faithful") {
    const replyLanguage = await resolveReplyLanguage(payload);
    const result = await callQwen({
      model: MODEL_FAST,
      system: `你是翻译器。把运营给的中文（chinese_text）准确翻译成目标外语。
忠实原意、一字不改地传达：不增不减、不加问候语、不加结尾客套、不润色、不扩写、不改语气。
准确保留主语、宾语、动作方向、时态、否定、数字和语气。
【保留排版结构，翻译 brief/脚本这类长内容时尤其重要】
- 完整保留原文的换行、分点(1. 2. 3. / ① / • / -)、空行结构，逐行对应翻译。
- 绝不把多行或分点合并成一段；reply_target 的行数与分点数应与原文一致。
【目标语言规则，最重要】
- 如果提供了 reply_language，就翻成 reply_language。
- 如果 reply_language 为空，先判断 creator_message（红人原消息）是什么语言，再把 chinese_text 翻成那个语言；红人说泰语就用泰语、说日语就用日语，绝不无故改成英语。
- reply_target 必须是翻译后的外语，绝对不能为空，绝对不能原样照抄 chinese_text 的中文。
只返回 JSON：{"reply_target":"目标语言译文","reply_chinese":"原中文照抄"}。`,
      user: JSON.stringify({
        reply_language: replyLanguage,
        creator_message: payload.message || "",
        chinese_text: payload.replyChinese || ""
      }),
      maxTokens: 900,
      temperature: 0
    });
    return {
      reply_target: String(result.reply_target || ""),
      reply_chinese: String(result.reply_chinese || payload.replyChinese || "")
    };
  }

  if (direction === "refine") {
    const replyLanguage = await resolveReplyLanguage(payload);
    const result = await callQwen({
      model: MODEL_FAST,
      system: `你是中国 KOL 运营人员的双语回复修改助手。
运营给出当前的外语回复和一条修改要求，请在现有回复的基础上按要求改写。
没有被要求改动的部分尽量保持不变，只动需要改的地方。
如果修改要求是「删掉某个词 / 产品名 / 句子」，必须在结果里**彻底删除它，绝不能再次出现**（包括外语和中文对照都要删干净）。
**绝不在外语里加入**运营没要求、且不属于当前 selected_product 的其他产品名 / 品牌 / 团队名——即使产品资料的描述里提到过别的产品（那是内部信息）。
外语版本使用 reply_language；若为空则沿用当前回复的语言，绝不无故改成英语。
必须准确区分谁让谁做什么，不得虚构此前发生的事情，也不得编造价格、日期、授权、付款承诺、平台或链接。
reply_target 不能为空；reply_chinese 必须是 reply_target 的准确中文对照。

${replyStyleFor(replyLanguage, payload.message)}

只返回 JSON：{"reply_target":"修改后的外语回复","reply_chinese":"准确中文对照"}。`,
      user: JSON.stringify({
        creator_message: payload.message || "",
        conversation_context: payload.context || "",
        selected_product: product,
        reply_language: replyLanguage,
        current_reply_target: payload.replyTarget || "",
        current_reply_chinese: payload.replyChinese || "",
        modification_request: payload.modification || ""
      }),
      maxTokens: 1000,
      temperature: 0.25
    });
    return {
      reply_target: String(result.reply_target || ""),
      reply_chinese: String(result.reply_chinese || "")
    };
  }

  if (direction === "target_to_chinese") {
    const result = await callQwen({
      model: MODEL_FAST,
      system: `你是 KOL 商务沟通翻译校对助手。
将运营提供的外语回复忠实翻译成自然中文，供运营核对。
严格保留价格、日期、数量、平台、授权、否定和语气，不得增加原文没有的承诺。
只返回 JSON：{"reply_target":"原外语不变","reply_chinese":"中文翻译"}。`,
      user: JSON.stringify({
        reply_target: payload.replyTarget || "",
        creator_message: payload.message || ""
      }),
      maxTokens: 700,
      temperature: 0
    });
    return {
      reply_target: String(result.reply_target || payload.replyTarget || ""),
      reply_chinese: String(result.reply_chinese || "")
    };
  }

  const replyLanguage = await resolveReplyLanguage(payload);

  const result = await callQwen({
    model: MODEL_FAST,
    system: `你是中国 KOL 运营人员的双语回复编辑器。
运营会在中文框中输入两类内容之一：
1. 可以直接发送的大致中文回复；
2. 简略的写作意图，例如“对方不愿意修改，我要委婉劝他，给出几点理由”。

你必须智能判断是哪一种，并结合红人原话、上下文、产品资料和运营目标，生成自然、专业、像真人的正式回复。

【输出语言规则，最重要】
- 如果提供了 reply_language，外语版本必须使用 reply_language。
- 如果没有提供 reply_language，则使用 creator_message（红人原消息）所用的语言。
- 红人说泰语就用泰语、说日语就用日语，绝不能在红人没用英语时擅自改成英语。
- reply_target 必须是完整的外语回复，绝对不能为空，绝对不能只返回中文。
- reply_chinese 必须是 reply_target 的准确中文对照，而不是重复运营的简略指令。

必须准确区分谁让谁做什么，不得虚构此前发生的事情。
不得自行编造价格、日期、授权期限、付款承诺、平台、产品账号或链接。
信息不足时使用安全的澄清表达，不要脑补。
如果运营输入是分点 / 多行内容（如 brief、脚本），保留其换行和分点结构，不要合并成一段。

【不串其他产品 / 品牌（始终生效）】reply_target 里**绝不能出现**运营中文（chinese_draft_or_instruction）里没有写、且不属于当前 selected_product 的其他产品名、品牌名或团队名——**即使 selected_product 的 description/selling_points 里提到过别的产品**（那是给运营看的内部信息，不是要发给红人的内容）。运营中文里没提的关联产品，一律不要出现在外语里。

【凭空生成话术（creator_message 和 conversation_context 都为空时）】
说明运营是要从零写一段话术（例如触达 / 冷启动私信），不是回复某条已有消息。这时：
- 完全按 chinese_draft_or_instruction 的意图来写，产出一段自然、自包含、可直接发出的话术。
- 按「第一次联系」来写：不要假设此前已聊过、合作过、或对方问过什么；不要带"再次合作 / 老朋友 / 上次"这类暗示有过往来的措辞（除非指令明确要求）。
- 除非指令明确点名，**不要提及其他产品的名字**，也不要写"和某某同一团队"这类与意图无关的角度——只围绕当前 selected_product 和运营意图写。
- selected_product 的 description/selling_points 里若含括号备注或内部说明（如团队关系），那是给运营看的，**不要原样塞进发给红人的话术**。卖点为空就写不依赖具体卖点的通用话术，绝不编造卖点。

${replyStyleFor(replyLanguage, payload.message)}

只返回 JSON：{"reply_target":"最终外语回复（不能为空）","reply_chinese":"最终中文对照"}。`,
    user: JSON.stringify({
      creator_message: payload.message || "",
      conversation_context: payload.context || "",
      selected_product: product,
      reply_language: replyLanguage,
      current_reply_target: payload.replyTarget || "",
      chinese_draft_or_instruction: payload.replyChinese || "",
      operator_goal: payload.operatorGoal || ""
    }),
    maxTokens: 1000,
    temperature: 0.25
  });

  return {
    reply_target: String(result.reply_target || ""),
    reply_chinese: String(result.reply_chinese || "")
  };
}

async function generateQuickTemplate(payload) {
  const product = findProduct(payload.productId);
  const templates = loadJson(QUICK_TEMPLATES_PATH, []);
  const template = templates.find((item) => item.id === payload.templateId);
  if (!template) throw new Error("未找到该快捷话术。");

  const variables = payload.variables || {};
  const missingVariables = template.required_variables.filter(
    (name) => !String(variables[name] || "").trim()
  );
  const filledIntent = template.chinese_intent.replace(
    /\{\{([a-zA-Z0-9_]+)\}\}/g,
    (_, name) =>
      String(variables[name] || "").trim() || `【请填写：${name}】`
  );

  const result = await callQwen({
    model: MODEL_FAST,
    system: `你是中国 KOL 运营团队的主动话术生成器。
filled_chinese_intent 是已经把运营填写的变量替换好的中文写作意图，请严格按它来生成回复。
其中只有形如【请填写：变量名】的占位符才表示该信息缺失，必须原样保留、不能由你猜测。
凡是 variables 里已经给出的值（例如产品名、数量、日期、链接等），必须如实体现在最终回复中，绝不能遗漏或忽略。
目标语言由 target_language 指定；如果是英语则使用自然、友好、专业的英语。
不得自行编造价格、日期、数量、平台、账号、链接、授权期限或付款时间。
回复适合 Instagram 私信，除非 channel 指定 Email。

${replyStyleFor(payload.targetLanguage || "", filledIntent)}

只返回 JSON：{"reply_target":"目标语言回复","reply_chinese":"准确中文对照","required_variables":["仍需填写的变量"]}。`,
    user: JSON.stringify({
      scene_name: template.name,
      scene_category: template.category,
      filled_chinese_intent: filledIntent,
      filled_variables: variables,
      selected_product: product,
      target_language: payload.targetLanguage || "英语",
      channel: payload.channel || "Instagram",
      missing_variables: missingVariables
    }),
    maxTokens: 1000,
    temperature: 0.2
  });

  return {
    template_id: template.id,
    scene_name: template.name,
    category: template.category,
    reply_target: String(result.reply_target || ""),
    reply_chinese: String(result.reply_chinese || ""),
    required_variables: Array.isArray(result.required_variables)
      ? result.required_variables
      : missingVariables
  };
}

async function alignReply(payload) {
  const result = await callQwen({
    model: MODEL_FAST,
    system: `你是双语逐句对照助手。把运营给的外语回复按句子拆开，每个句子给出准确的中文对照，顺序与原文完全一致。
不要漏句、不要把多句合并、不要改写或润色原文，只做切分和对照翻译。
中文对照要忠实，准确保留主语、宾语、动作方向、时态、否定与语气。
只返回 JSON：{"pairs":[{"target":"外语句子","chinese":"该句中文对照"}]}。`,
    user: JSON.stringify({
      reply_target: payload.replyTarget || "",
      reply_chinese: payload.replyChinese || ""
    }),
    maxTokens: 2000,
    temperature: 0
  });
  return {
    pairs: Array.isArray(result.pairs)
      ? result.pairs
          .map((p) => ({
            target: String(p?.target || "").trim(),
            chinese: String(p?.chinese || "").trim()
          }))
          .filter((p) => p.target)
      : []
  };
}

function archiveRecord(payload) {
  const records = loadJson(ARCHIVE_PATH, []);
  const now = new Date().toISOString();
  const id =
    payload.id ||
    `scene_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const existingIndex = records.findIndex((record) => record.id === id);
  const previous = existingIndex >= 0 ? records[existingIndex] : null;

  const record = {
    id,
    version: (previous?.version || 0) + 1,
    status: payload.status === "inactive" ? "inactive" : "active",
    product_id: String(payload.product_id || "generic"),
    scene_name: String(payload.scene_name || "未命名场景").trim(),
    stage: String(payload.stage || "").trim(),
    trigger_examples: Array.isArray(payload.trigger_examples)
      ? payload.trigger_examples.map(String).filter(Boolean)
      : [],
    correct_understanding: String(payload.correct_understanding || "").trim(),
    external_reply_target: String(payload.external_reply_target || "").trim(),
    external_reply_chinese: String(payload.external_reply_chinese || "").trim(),
    internal_guidance: payload.internal_guidance || {},
    required_variables: Array.isArray(payload.required_variables)
      ? payload.required_variables.map(String).filter(Boolean)
      : [],
    notes: String(payload.notes || "").trim(),
    created_at: previous?.created_at || now,
    updated_at: now
  };

  if (existingIndex >= 0) records[existingIndex] = record;
  else records.unshift(record);
  saveJson(ARCHIVE_PATH, records);
  return record;
}

function archiveHasId(id) {
  return loadJson(ARCHIVE_PATH, []).some((record) => record.id === id);
}

function deleteRecord(id) {
  const records = loadJson(ARCHIVE_PATH, []);
  const next = records.filter((record) => record.id !== id);
  saveJson(ARCHIVE_PATH, next);
  return { deleted: records.length - next.length };
}

function assetRecord(payload) {
  const records = loadJson(ASSETS_PATH, []);
  const id =
    payload.id ||
    `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const index = records.findIndex((record) => record.id === id);
  const previous = index >= 0 ? records[index] : null;
  const record = {
    id,
    product: String(payload.product || "通用"),
    type: ["image", "video", "link", "note"].includes(payload.type)
      ? payload.type
      : "note",
    name: String(payload.name || "未命名物料").trim(),
    url: String(payload.url || "").trim(),
    text: String(payload.text || "").trim(),
    ext: previous?.ext || "",
    notes: String(payload.notes || "").trim(),
    created_at: previous?.created_at || new Date().toISOString()
  };
  if (
    (payload.type === "image" || payload.type === "video") &&
    payload.dataBase64
  ) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    const ext =
      String(payload.ext || (payload.type === "video" ? "mp4" : "png"))
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase() || (payload.type === "video" ? "mp4" : "png");
    fs.writeFileSync(
      path.join(ASSETS_DIR, `${id}.${ext}`),
      Buffer.from(payload.dataBase64, "base64")
    );
    record.ext = ext;
  }
  if (index >= 0) records[index] = record;
  else records.unshift(record);
  saveJson(ASSETS_PATH, records);
  return record;
}

function assetHasId(id) {
  return loadJson(ASSETS_PATH, []).some((r) => r.id === id);
}

function deleteAsset(id) {
  const records = loadJson(ASSETS_PATH, []);
  const record = records.find((r) => r.id === id);
  if (record?.ext) {
    try {
      fs.unlinkSync(path.join(ASSETS_DIR, `${id}.${record.ext}`));
    } catch {
      // 文件可能已不存在，忽略。
    }
  }
  const next = records.filter((r) => r.id !== id);
  saveJson(ASSETS_PATH, next);
  return { deleted: records.length - next.length };
}

// 没设置管理员口令时（本机单人模式）视为管理员，保持旧行为；
// 团队部署设置了 KOL_ASSISTANT_ADMIN_TOKEN 后，编辑/删除已有话术需带正确管理员口令。
function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  return req.headers["x-kol-admin"] === ADMIN_TOKEN;
}

// ===================== Word 话术导入：合并 + AI 判重/冲突 + 图片入物料库 =====================

// 一条话术内容的归一签名，用来判断「完全重复」（字段名+去空白后的值都一样）。
function knowledgeSignature(fields) {
  const obj = fields && typeof fields === "object" ? fields : {};
  const norm = Object.keys(obj)
    .sort()
    .map((k) => [k, String(obj[k] || "").replace(/\s+/g, " ").trim()])
    .filter(([, v]) => v);
  return JSON.stringify(norm);
}

// 文本归一（去空白/标点、转小写）用于相似度。
function normText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}
// 一条话术所有字段值拼起来，作为「内容指纹」原料。
function recBlob(rec) {
  const f = (rec && rec.fields) || {};
  return Object.keys(f).sort().map((k) => f[k]).join(" ");
}
// 「产品|语种|场景」键：旧文档上改回复时，场景(步骤)一般不变，靠它能跨行号位移认出同一条。
function sceneKey(rec) {
  return `${String((rec && rec.product) || "").trim()}|${String((rec && rec.region) || "").trim()}|${normText(rec && rec.scene)}`;
}
function bigrams(s) {
  const set = new Set();
  if (s.length === 1) set.add(s);
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

const SIM_THRESHOLD = 0.6; // 同产品/语种内，内容相似度 ≥ 这个值就当「可能是改的同一条」交 AI 判

// 把新导入的话术并进现有库：
//   完全相同→去重；能对上现有的某条（同 stable_id / 同「产品|语种|场景」/ 高度相似）→冲突，交 AI 判是改还是新增；
//   完全对不上→新增。这样在「旧文档上补充/修改」的工作流里，改动会被认成对旧条的修改而不是平白多一条。
function mergeKnowledge(existing, incoming) {
  const result = Array.isArray(existing) ? existing.slice() : [];
  const idIndex = new Map();
  const sceneIndex = new Map();
  const sigSet = new Set();
  const meta = []; // { index, prodReg, grams }
  result.forEach((rec, i) => {
    if (rec && rec.stable_id) idIndex.set(rec.stable_id, i);
    sigSet.add(knowledgeSignature(rec && rec.fields));
    const sk = sceneKey(rec);
    if (rec && rec.scene && !sceneIndex.has(sk)) sceneIndex.set(sk, i);
    meta.push({
      index: i,
      prodReg: `${(rec && rec.product) || ""}|${(rec && rec.region) || ""}`,
      grams: bigrams(normText(recBlob(rec)))
    });
  });

  let added = 0;
  let duplicates = 0;
  const conflicts = [];

  // 注意：匹配索引（id/场景/相似度）只用「原有库」，不把本次新增的条目纳入——
  // 同一份 Word 里每一行都是作者有意安排的独立条目，不该在一次导入内部互相合并；
  // 只有 sigSet（完全相同内容）会随新增更新，用来去掉一份 Word 里偶发的逐字重复行。

  for (const inc of incoming) {
    if (!inc || !inc.fields || !Object.keys(inc.fields).length) continue;
    const sig = knowledgeSignature(inc.fields);
    if (sigSet.has(sig)) {
      duplicates++; // 内容完全相同（无论 id 是否一样）→ 没改，跳过
      continue;
    }
    // 找它对应的现有条目
    let matchIdx = inc.stable_id != null ? idIndex.get(inc.stable_id) : undefined;
    if (matchIdx == null) {
      const sk = sceneKey(inc);
      if (inc.scene && sceneIndex.has(sk)) matchIdx = sceneIndex.get(sk);
    }
    if (matchIdx == null) {
      const pr = `${inc.product || ""}|${inc.region || ""}`;
      const g = bigrams(normText(recBlob(inc)));
      let best = -1;
      let bestScore = 0;
      for (const m of meta) {
        if (m.prodReg !== pr) continue;
        const s = jaccard(g, m.grams);
        if (s > bestScore) {
          bestScore = s;
          best = m.index;
        }
      }
      if (best >= 0 && bestScore >= SIM_THRESHOLD) matchIdx = best;
    }
    if (matchIdx != null) {
      conflicts.push({ index: matchIdx, old: result[matchIdx], incoming: inc });
    } else {
      result.push(inc);
      sigSet.add(sig); // 仅用于本次内部的逐字去重，不参与 id/场景/相似度匹配
      added++;
    }
  }

  return { result, added, duplicates, conflicts };
}

const CONFLICT_AI_CAP = 60; // 单次最多送 AI 判这么多冲突，其余默认采用新版（避免一次烧太多额度）

// 让 AI 对「能对上现有某条、但内容不一致」的每组逐一判：
//   take_new=新版是对旧条的修改，采用新版；keep_old=新版像误删/残缺，保留旧版；
//   merge=两边各有用，合并；new=其实是另一条不同的新话术（只是恰好相似），两条都留(当新增)。
// 返回与 conflicts 等长、按下标对齐的数组。没配 AI 时默认 take_new。
async function reconcileConflicts(conflicts) {
  const out = conflicts.map(() => null);
  if (!conflicts.length) return out;

  for (let i = CONFLICT_AI_CAP; i < conflicts.length; i++) {
    out[i] = { decision: "take_new", reason: "冲突过多，超出本次 AI 判别上限，默认采用新版本" };
  }
  const aiEnd = Math.min(conflicts.length, CONFLICT_AI_CAP);

  if (!process.env.DASHSCOPE_API_KEY) {
    for (let i = 0; i < aiEnd; i++) {
      out[i] = { decision: "take_new", reason: "未配置 AI，默认采用新版本（新 Word 覆盖旧条目）" };
    }
    return out;
  }

  const chunkSize = 6;
  for (let start = 0; start < aiEnd; start += chunkSize) {
    const end = Math.min(aiEnd, start + chunkSize);
    const items = [];
    for (let i = start; i < end; i++) {
      const c = conflicts[i];
      items.push({
        ref: i,
        scene: c.incoming.scene || c.old.scene || "",
        product: c.incoming.product || "",
        region: c.incoming.region || "",
        old_fields: c.old.fields,
        new_fields: c.incoming.fields
      });
    }
    try {
      const res = await callQwen({
        system:
          "你是 KOL 团队话术库的维护助手。新话术来自「在旧文档基础上补充/修改」的 Word，所以每一组是新导入版本(new)和库里已有、与之对得上的某条(old)。" +
          "请逐组判断 new 到底是「改了 old」还是「另起的一条新话术」，输出 JSON：" +
          "{\"decisions\":[{\"ref\":数字,\"decision\":\"take_new|keep_old|merge|new\",\"fields\":{合并后的字段，仅 decision=merge 时给出},\"reason\":\"一句中文理由\"}]}。" +
          "判断原则：" +
          "若 new 是对 old 同一条话术的修改/更新（同一场景、同语言、只是措辞或内容变了）→ take_new（用新版替换旧条）；" +
          "若 new 明显残缺、丢字段、像误删 → keep_old（保留旧条）；" +
          "若两版各有有用信息（如旧版多了备注、新版改了正文）→ merge，并给出合并后的 fields（保留两边都需要的字段，正文以新版为准）；" +
          "若 new 其实讲的是另一件事、只是恰好和 old 相似（不是同一条）→ new（两条都保留，把 new 当新增）。只输出 JSON。",
        user: JSON.stringify({ pairs: items }),
        maxTokens: 2000,
        temperature: 0.1,
        model: MODEL_FAST
      });
      const list = Array.isArray(res?.decisions) ? res.decisions : [];
      for (const d of list) {
        const i = d.ref;
        if (typeof i !== "number" || i < start || i >= end) continue;
        out[i] = {
          decision: ["take_new", "keep_old", "merge", "new"].includes(d.decision) ? d.decision : "take_new",
          fields: d.fields && typeof d.fields === "object" ? d.fields : undefined,
          reason: String(d.reason || "").slice(0, 120)
        };
      }
      for (let i = start; i < end; i++) {
        if (!out[i]) out[i] = { decision: "take_new", reason: "AI 未给出该条判断，默认采用新版本" };
      }
    } catch (error) {
      for (let i = start; i < end; i++) {
        out[i] = { decision: "take_new", reason: "AI 判别失败，默认采用新版本：" + (error.message || "") };
      }
    }
  }
  return out;
}

// 把话术文档里的示例截图存进物料库；同一张图（内容相同）用内容哈希做 id，重复导入不会堆积。
function importKnowledgeImages(images) {
  const savedIds = new Set(); // 按内容哈希去重：同一张图被引用多次只算一张
  let skipped = 0;
  for (const img of images || []) {
    if (!img || !img.dataBase64) {
      skipped++;
      continue;
    }
    try {
      const buf = Buffer.from(img.dataBase64, "base64");
      const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);
      const id = "asset_kb_" + hash;
      const label = `${img.region || img.product || "话术"}·${img.scene || "示例图"}`.slice(0, 80);
      assetRecord({
        id,
        type: "image",
        product: img.product || "通用",
        name: label,
        dataBase64: img.dataBase64,
        ext: img.ext || "png",
        notes: `话术文档导入｜${img.product || ""} / ${img.region || ""}`.trim()
      });
      savedIds.add(id);
    } catch {
      skipped++;
    }
  }
  return { saved: savedIds.size, skipped };
}

// 产品 id：英文名去空格小写当 id；纯中文等无法 slug 的用内容哈希兜底（保证稳定唯一）。
function slugifyProduct(name) {
  const base = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (base) return base.slice(0, 40);
  return "prod_" + crypto.createHash("sha1").update(String(name || "")).digest("hex").slice(0, 8);
}

// 团队库上传时，自动把 Word 里出现的产品名补进产品库：库里没有的，加一条占位产品
// （卖点/账号留空，运营再补；带上 forbidden_claims 防 AI 编造）。已存在的跳过。
function ensureProductsFromImport(records, images) {
  const names = new Set();
  for (const r of records || []) {
    const p = String((r && r.product) || "").trim();
    if (p) names.add(p);
  }
  for (const im of images || []) {
    const p = String((im && im.product) || "").trim();
    if (p) names.add(p);
  }
  if (!names.size) return [];
  // 以线上产品为准；线上还没产品文件时从种子起步，避免把出厂产品冲掉。
  let products = loadJson(PRODUCTS_PATH, null);
  if (!Array.isArray(products)) products = loadJson(path.join(SEED_DIR, "products.json"), []);
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9㐀-鿿]+/g, "");
  const have = new Set();
  products.forEach((p) => { have.add(norm(p.id)); have.add(norm(p.name)); });
  const added = [];
  for (const name of names) {
    if (/^(通用|generic)$/i.test(name)) continue; // 「通用」不是产品
    const key = norm(name);
    if (!key || have.has(key)) continue;
    let id = slugifyProduct(name);
    if (products.some((p) => p.id === id)) { have.add(key); continue; }
    products.push({
      id,
      name,
      status: "active",
      description: "由团队库上传自动添加，详细卖点和账号待运营补充。",
      social_accounts: {},
      download_links: {},
      audience: "",
      selling_points: [],
      subscription_rule: "",
      default_platforms: [],
      usage_policy: "广告授权期限、二次使用平台和剪辑权限必须逐次确认，不得默认永久授权。",
      payment_policy: "完成约定交付后提交付款申请，具体到账日期由运营确认。",
      brief_links: [],
      forbidden_claims: [
        "不得自行编造产品卖点、账号或链接",
        "不得承诺未确认的广告授权期限",
        "不得承诺未确认的付款日期",
        "不得把内部预算上限发给红人"
      ]
    });
    have.add(key);
    added.push({ id, name });
  }
  if (added.length) saveJson(PRODUCTS_PATH, products);
  return added;
}

async function importKnowledge(payload) {
  const incoming = Array.isArray(payload.records) ? payload.records : [];
  const images = Array.isArray(payload.images) ? payload.images : [];
  if (!incoming.length && !images.length) {
    const error = new Error("没有可导入的内容（解析出 0 条话术、0 张图片）。");
    error.code = "EMPTY_IMPORT";
    throw error;
  }

  const existing = loadJson(knowledgeReadPath(), []);

  // 1) 先备份现有库，万一导错可回滚。
  let backup = "";
  if (Array.isArray(existing) && existing.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    backup = `knowledge-base.backup-${stamp}.json`;
    try {
      saveJson(path.join(DATA_DIR, backup), existing);
    } catch {
      backup = "";
    }
  }

  // 2) 合并 + AI 判：每条冲突是「改了旧的」还是「另起的新话术」。
  const merged = mergeKnowledge(existing, incoming);
  const decisions = await reconcileConflicts(merged.conflicts);
  const conflictReport = [];
  let modified = 0;
  let keptOld = 0;
  let addedFromConflicts = 0;
  merged.conflicts.forEach((c, i) => {
    const d = decisions[i] || { decision: "take_new", reason: "" };
    if (d.decision === "new") {
      merged.result.push(c.incoming); // AI 认定是另一条新话术 → 两条都留
      addedFromConflicts++;
    } else if (d.decision === "keep_old") {
      keptOld++;
    } else if (d.decision === "merge" && d.fields) {
      merged.result[c.index].fields = { ...c.old.fields, ...c.incoming.fields, ...d.fields };
      modified++;
    } else {
      merged.result[c.index].fields = c.incoming.fields; // take_new
      modified++;
    }
    conflictReport.push({
      scene: c.incoming.scene || c.old.scene || "",
      region: c.incoming.region || "",
      decision: d.decision,
      reason: d.reason
    });
  });

  // 3) 写回团队库：永远写线上目录（DATA_DIR），不回写种子。
  saveJson(KNOWLEDGE_LIVE_PATH, merged.result);

  // 4) 图片进物料库。
  const imageResult = importKnowledgeImages(images);

  // 5) 自动补产品库：Word 里出现、产品库还没有的产品名，加一条占位产品。
  const productsAdded = ensureProductsFromImport(incoming, images);

  return {
    ok: true,
    before: Array.isArray(existing) ? existing.length : 0,
    after: merged.result.length,
    added: merged.added + addedFromConflicts,
    modified,
    kept_old: keptOld,
    duplicates: merged.duplicates,
    conflicts: conflictReport.length,
    conflict_detail: conflictReport.slice(0, 50),
    images_saved: imageResult.saved,
    images_skipped: imageResult.skipped,
    products_added: productsAdded.length,
    products_added_detail: productsAdded,
    backup
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  // 设置了团队口令时，所有 /api/* 必须带正确口令（/health 放行用于连通性检测）。
  if (
    AUTH_TOKEN &&
    req.url.startsWith("/api/") &&
    req.headers["x-kol-token"] !== AUTH_TOKEN
  ) {
    return json(res, 401, {
      error: "团队口令不正确或缺失，请在插件「服务器设置」里填写正确的口令。",
      code: "UNAUTHORIZED"
    });
  }

  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        provider: "阿里云百炼",
        model: MODEL,
        model_fast: MODEL_FAST,
        model_smart: MODEL_SMART,
        ai_configured: Boolean(process.env.DASHSCOPE_API_KEY),
        timeout_seconds: 55,
        cache: {
          translate: { size: translateCache.map.size, hits: translateCache.hits, misses: translateCache.misses },
          judge: { size: judgeCache.map.size, hits: judgeCache.hits, misses: judgeCache.misses }
        }
      });
    }

    if (req.method === "GET" && req.url === "/api/products") {
      return json(res, 200, loadJson(PRODUCTS_PATH, []));
    }

    if (req.method === "GET" && req.url === "/api/quick-templates") {
      return json(res, 200, loadJson(QUICK_TEMPLATES_PATH, []));
    }

    if (req.method === "GET" && req.url === "/api/playbook") {
      return json(res, 200, loadJson(PLAYBOOK_PATH, []));
    }

    // 团队库（Word 导入落库的话术）：界面「话术库」直接搜这个，不再只看 playbook 种子。
    if (req.method === "GET" && req.url === "/api/knowledge") {
      return json(res, 200, loadJson(knowledgeReadPath(), []));
    }

    // 云端备份：按 ins id 存/取个人本地数据（合作进度/快捷回复/提醒等）。
    if (req.method === "GET" && req.url.startsWith("/api/backup")) {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      const file = backupFile(url.searchParams.get("id"));
      if (!file) return json(res, 400, { error: "缺少有效的 ins id。" });
      return json(res, 200, loadJson(file, { data: null, updatedAt: 0 }));
    }
    if (req.method === "POST" && req.url === "/api/backup") {
      const payload = await readBody(req);
      const file = backupFile(payload.userId);
      if (!file) return json(res, 400, { error: "缺少有效的 ins id。" });
      saveJson(file, {
        userId: String(payload.userId).trim(),
        data: payload.data ?? {},
        updatedAt: Date.now()
      });
      return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url.startsWith("/api/assets/file/")) {
      const id = decodeURIComponent(req.url.split("/api/assets/file/")[1] || "");
      const record = loadJson(ASSETS_PATH, []).find((r) => r.id === id);
      if (!record || !record.ext) {
        return json(res, 404, { error: "物料不存在。" });
      }
      const file = path.join(ASSETS_DIR, `${id}.${record.ext}`);
      if (!fs.existsSync(file)) return json(res, 404, { error: "文件不存在。" });
      res.writeHead(200, {
        "Content-Type": MIME[record.ext] || "application/octet-stream",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "max-age=3600"
      });
      // 流式发送，避免大视频一次性读进内存压垮 VPS。
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === "GET" && req.url === "/api/assets") {
      return json(res, 200, loadJson(ASSETS_PATH, []));
    }

    if (req.method === "POST" && req.url === "/api/assets") {
      const payload = await readBody(req);
      // 新增物料所有成员可做；修改已有物料需要管理员。
      if (payload.id && assetHasId(payload.id) && !isAdmin(req)) {
        return json(res, 403, {
          error: "只有管理员可以修改已有物料。",
          code: "FORBIDDEN"
        });
      }
      return json(res, 200, assetRecord(payload));
    }

    if (req.method === "POST" && req.url === "/api/assets/delete") {
      if (!isAdmin(req)) {
        return json(res, 403, {
          error: "只有管理员可以删除物料。",
          code: "FORBIDDEN"
        });
      }
      const payload = await readBody(req);
      if (!String(payload.id || "").trim()) {
        return json(res, 400, { error: "缺少要删除的物料 id。" });
      }
      return json(res, 200, deleteAsset(payload.id));
    }

    // 团队库 Word 导入：侧边栏已在浏览器解析好，这里只做合并/判冲突/落库。仅管理员可用。
    if (req.method === "POST" && req.url === "/api/knowledge/import") {
      if (!isAdmin(req)) {
        return json(res, 403, {
          error: "只有管理员可以导入团队话术库。",
          code: "FORBIDDEN"
        });
      }
      const payload = await readBody(req);
      return json(res, 200, await importKnowledge(payload));
    }

    if (req.method === "GET" && req.url.startsWith("/api/archive")) {
      const url = new URL(req.url, `http://${HOST}:${PORT}`);
      const query = String(url.searchParams.get("q") || "").toLowerCase();
      const productId = String(url.searchParams.get("product_id") || "");
      const records = loadJson(ARCHIVE_PATH, []).filter((record) => {
        if (productId && record.product_id !== productId) return false;
        if (!query) return true;
        return JSON.stringify(record).toLowerCase().includes(query);
      });
      return json(res, 200, records);
    }

    if (req.method === "POST" && req.url === "/api/archive") {
      const payload = await readBody(req);
      // 编辑已存在的话术需要管理员；新增不需要。
      if (payload.id && archiveHasId(payload.id) && !isAdmin(req)) {
        return json(res, 403, {
          error: "只有管理员可以编辑已保存的话术。",
          code: "FORBIDDEN"
        });
      }
      return json(res, 200, archiveRecord(payload));
    }

    if (req.method === "POST" && req.url === "/api/archive/delete") {
      if (!isAdmin(req)) {
        return json(res, 403, {
          error: "只有管理员可以删除话术。",
          code: "FORBIDDEN"
        });
      }
      const payload = await readBody(req);
      if (!String(payload.id || "").trim()) {
        return json(res, 400, { error: "缺少要删除的话术 id。" });
      }
      return json(res, 200, deleteRecord(payload.id));
    }

    if (req.method === "POST" && req.url === "/api/archive/export") {
      return json(res, 200, {
        exported_at: new Date().toISOString(),
        records: loadJson(ARCHIVE_PATH, [])
      });
    }

    if (req.method === "POST" && req.url === "/api/analyze") {
      const payload = await readBody(req);
      if (!String(payload.message || "").trim()) {
        return json(res, 400, { error: "请先提供红人的消息。" });
      }
      return json(res, 200, await analyzeWithQwen(payload));
    }

    if (req.method === "POST" && req.url === "/api/translate") {
      const payload = await readBody(req);
      const text = String(payload.text || "").trim();
      if (!text) return json(res, 400, { error: "缺少翻译文本。" });
      if (text.length > 1200) {
        return json(res, 400, { error: "单条消息过长。" });
      }
      return json(res, 200, await translateFaithfully(text));
    }

    if (req.method === "POST" && req.url === "/api/summary") {
      const payload = await readBody(req);
      const hasMsgs = Array.isArray(payload.messages) && payload.messages.length;
      if (!hasMsgs && !String(payload.text || "").trim()) {
        return json(res, 400, { error: "没读到对话内容。" });
      }
      return json(res, 200, await summarizeConversation(payload));
    }

    if (req.method === "POST" && req.url === "/api/parse-todo") {
      const payload = await readBody(req);
      if (!String(payload.sentence || "").trim()) {
        return json(res, 400, { error: "请输入一句话。" });
      }
      return json(res, 200, await parseTodo(payload));
    }

    if (req.method === "POST" && req.url === "/api/reply") {
      const payload = await readBody(req);
      if (!String(payload.message || "").trim() && !String(payload.operatorGoal || "").trim()) {
        return json(res, 400, { error: "请先提供红人的消息或你的回复意图。" });
      }
      return json(res, 200, await quickReply(payload));
    }

    if (req.method === "POST" && req.url === "/api/followup") {
      const payload = await readBody(req);
      return json(res, 200, await followupReply(payload));
    }

    if (req.method === "POST" && req.url === "/api/judge") {
      const payload = await readBody(req);
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        return json(res, 400, { error: "缺少对话消息。" });
      }
      return json(res, 200, await judgeThread(payload));
    }

    if (req.method === "POST" && req.url === "/api/ask") {
      const payload = await readBody(req);
      if (!String(payload.question || "").trim()) {
        return json(res, 400, { error: "请输入想问千问的问题。" });
      }
      return json(res, 200, await askQwen(payload));
    }

    if (req.method === "POST" && req.url === "/api/rewrite") {
      const payload = await readBody(req);
      if (
        payload.direction === "target_to_chinese" &&
        !String(payload.replyTarget || "").trim()
      ) {
        return json(res, 400, { error: "请先填写外语回复。" });
      }
      if (payload.direction === "refine") {
        if (!String(payload.modification || "").trim()) {
          return json(res, 400, { error: "请先写下要怎么改。" });
        }
      } else if (
        payload.direction !== "target_to_chinese" &&
        !String(payload.replyChinese || "").trim()
      ) {
        return json(res, 400, { error: "请先在中文框写下回复或大概意图。" });
      }
      return json(res, 200, await rewriteReply(payload));
    }

    if (req.method === "POST" && req.url === "/api/align") {
      const payload = await readBody(req);
      if (!String(payload.replyTarget || "").trim()) {
        return json(res, 400, { error: "请先有一条外语回复。" });
      }
      return json(res, 200, await alignReply(payload));
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      const payload = await readBody(req);
      if (!Array.isArray(payload.messages) || !payload.messages.length) {
        return json(res, 400, { error: "请先输入要问的内容。" });
      }
      return json(res, 200, await chatWithQwen(payload));
    }

    if (req.method === "POST" && req.url === "/api/generate-template") {
      const payload = await readBody(req);
      if (!String(payload.templateId || "").trim()) {
        return json(res, 400, { error: "请选择话术场景。" });
      }
      return json(res, 200, await generateQuickTemplate(payload));
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    return json(res, 500, {
      error: error.message || "服务发生错误。",
      code: error.code || "SERVER_ERROR"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`KOL Assistant is running at http://${HOST}:${PORT}`);
  console.log(`Provider: Alibaba Cloud Model Studio`);
  console.log(`Model: ${MODEL}`);
});
