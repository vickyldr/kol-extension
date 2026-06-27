// 红人资源库 + 进度看板 —— 只读管理端后端（零依赖 Node）
//
// 数据源：插件推到 VPS 的各人备份 ${KOL_DATA_DIR}/backups/<insid>.json
//   每个文件含 kolProfiles / kolThreads / kolSummaries / kolUnderstanding / kolTodos 等。
// 本服务把所有人的备份合并去重（按规范化名字 key），算出：
//   - 资源库：身份/合同/脚本/主题/性格/值得合作/黑名单/价格(群名解析)/对接人/优质(领导标)
//   - 进度看板：当前阶段(kolUnderstanding) + 最近跟进(lastFollowUpAt) + 今日盯人(needsReplyRaw)
// 领导写入只落 ${KOL_DATA_DIR}/roster-overrides.json，绝不回写各人备份（见根 CLAUDE.md 红线5）。
//
// 详见 apps/roster/设计.md。

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = Number(process.env.ROSTER_PORT || 3220);
const DATA_DIR =
  process.env.KOL_DATA_DIR || path.join(os.homedir(), "kol-data");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const OVERRIDES_PATH = path.join(DATA_DIR, "roster-overrides.json");
const TEAM_PATH = path.join(DATA_DIR, "roster-team.json");
const WEB_DIR = path.join(__dirname, "web");

// 团队口令（复用插件那套）；没设 = 本机单人模式，全放行。
const TOKEN = process.env.KOL_ASSISTANT_TOKEN || "";
const ADMIN_TOKEN = process.env.KOL_ASSISTANT_ADMIN_TOKEN || "";

const STALE_DAYS = 7; // 「很久没跟进」阈值
const DAY = 86400000;

// ---------- 小工具 ----------
function readJSON(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
// 与插件 profileKey 完全一致：trim + 折叠空格 + 小写
function profileKey(name) {
  return (name || "").trim().replace(/\s+/g, " ").toLowerCase();
}
function ts(s) {
  const t = Date.parse(s || "");
  return Number.isNaN(t) ? 0 : t;
}

// ---------- 群名解析：价格 / 平台 / 授权期限（启发式，AI 可后续增强） ----------
const PLAT_MAP = [
  [/instagram|\bins\b|\big\b/i, "Instagram"],
  [/tiktok|\btt\b|抖音/i, "TikTok"],
  [/youtube|\byt\b/i, "YouTube"],
  [/facebook|\bfb\b/i, "Facebook"],
  [/reels?/i, "Reels"]
];
function parseDeal(title) {
  const out = { price: "", platforms: [], usagePeriod: "" };
  if (!title) return out;
  // 价格：一串数字 + 币种/量词（刀/USD/$/美金/台币/韩元/w/万/k/元）
  const pm = title.match(
    /(\d[\d,\.]*)\s*(刀|usd|\$|美金|美元|台币|韩元|万|w|k|元)?/i
  );
  if (pm && /\d/.test(pm[1])) out.price = (pm[1] + (pm[2] || "")).trim();
  // 平台：扫关键词去重
  for (const [re, name] of PLAT_MAP) {
    if (re.test(title) && !out.platforms.includes(name)) out.platforms.push(name);
  }
  // 授权期限
  const um = title.match(/(\d+)\s*(个月|月|mon(?:th)?|年|year|周|week|w)\b/i);
  if (um) {
    const unit = /年|year/i.test(um[2]) ? "年" : /周|week/i.test(um[2]) ? "周" : "个月";
    out.usagePeriod = um[1] + unit;
  }
  return out;
}
// 语言地区粗判（AI 可增强）：含韩文→KR，含日文假名→JP，否则 TW
function detectRegion(text) {
  if (!text) return "";
  const t = text.toLowerCase();
  if (/[가-힣]/.test(text) || /韩|韓|krw/.test(t) || /\bkr\b/.test(t)) return "KR";
  if (/[぀-ヿ]/.test(text) || /日本|日[语語]|jpy/.test(t) || /\bjp\b/.test(t)) return "JP";
  return "TW"; // 台币/USD/默认
}

// 群名清洗：砍掉「价格/条款」那串（从第一个 价格 token 起），只留前面像名字的部分。
// 例 "AC 8earts 5wJPY(2d;link;review)ig" → "AC 8earts"
function cleanGroupName(title) {
  if (!title) return "";
  // deal 起点：① 数字+币种/量词，或 ② 独立的币种/地区词（没数字时也能砍）
  const m = title.match(
    /\d[\d,\.]*\s*(?:刀|usd|\$|美金|美元|twd|jpy|krw|台币|韩元|万|w|k)|(?:^|\s)(?:韩元|韓元|krw|jpy|twd|台币|美金)/i
  );
  let t = m && m.index > 0 ? title.slice(0, m.index) : title;
  // 去掉开头的 emoji/乱码（保留字母数字/中日韩/@）和结尾的分隔符
  t = t.replace(/^[^\w一-龥가-힣぀-ヿ@]+/, "").replace(/[\s\-_·|+]+$/, "").trim();
  return t || title;
}
// 产品缩写（写进代码文档，方便从 ins id 认产品）：
//   vivavideo=VA  aicatch=AC  rythmix=RM  vivacut=VC  recco=RC  wisemeal=WM  rymo=RY  inspo=IN
const PRODUCTS = [
  ["vivavideo", "VA"], ["aicatch", "AC"], ["rythmix", "RM"],
  ["vivacut", "VC"], ["recco", "RC"], ["wisemeal", "WM"],
  ["rymo", "RY"], ["inspo", "IN"]
];
const PRODUCT_CODES = PRODUCTS.map(([, c]) => c);
// 从 ins id 认产品（aicatch_vip2 → AC）
function productOf(insid) {
  const s = (insid || "").toLowerCase();
  for (const [name, code] of PRODUCTS) if (s.includes(name)) return code;
  return "";
}
// 砍掉群名开头的产品代码前缀（"AC 8earts" → "8earts"），得到更像 ig handle 的部分
function stripProductPrefix(name) {
  const re = new RegExp(`^(${PRODUCT_CODES.join("|")})\\s+`, "i");
  return (name || "").replace(re, "").trim();
}
// IG handle：群名清洗 + 去产品前缀；私聊用 creatorName
function pickHandle(th) {
  if (!th) return "";
  if (th.isGroup && th.title) return stripProductPrefix(cleanGroupName(th.title));
  return th.creatorName || "";
}
// 显示名优先级：档案外号 > 私聊档案名 > IG handle（清洗群名）> 兜底
function pickDisplayName(prof, th, key) {
  if (prof.nickname) return prof.nickname;
  if (prof.displayName && !th.isGroup) return prof.displayName;
  const h = pickHandle(th);
  if (h) return h;
  return prof.displayName || th.title || key;
}
// 阶段：优先用插件 AI 真阶段(kolUnderstanding)，没有就按关键词启发式推断。
const STAGES = ["洽谈中", "已报价", "制作中", "已完成", "终止"];
function computeStage(prof, th, summary, price) {
  const text = `${summary || ""} ${(th && th.lastMsgPreview) || ""} ${prof.notes || ""}`;
  if (prof.blacklist || /鸽|不回复|拉黑|放弃|终止/.test(text)) return "终止";
  if (/已发布|已发|上线|结案|完成/.test(text)) return "已完成";
  if (/脚本|拍摄|制作|初稿|修改稿|审核|brief/i.test(text)) return "制作中";
  if (/报价|报了|价格|quote|usd|twd|jpy|krw/i.test(text) || price) return "已报价";
  return "洽谈中";
}

// ---------- 合并所有备份 ----------
function loadTeamMap() {
  // { insid: 实习生名 }
  return readJSON(TEAM_PATH, {}) || {};
}
function loadOverrides() {
  // { personKey: { quality: bool, qualityBy, qualityAt } }
  return readJSON(OVERRIDES_PATH, {}) || {};
}

function loadBackups() {
  let files = [];
  try {
    files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  return files.map((f) => {
    // 备份文件是包了一层的：{ userId, data:{kolProfiles,...}, updatedAt }。
    // 真实 BACKUP_KEYS 在 .data 里；兼容万一没包的情况，回退顶层。
    const raw = readJSON(path.join(BACKUP_DIR, f), {}) || {};
    return {
      insid: f.replace(/\.json$/, ""),
      data: raw && typeof raw.data === "object" && raw.data ? raw.data : raw
    };
  });
}

// 把所有人备份合并成 { personKey: mergedPerson }
function buildRoster() {
  const team = loadTeamMap();
  const overrides = loadOverrides();
  const backups = loadBackups();
  // 员工名：优先 roster-team.json 手填，其次各备份里插件设置的「员工名字」(myStaffName)
  const staffMap = {};
  for (const { insid, data } of backups) {
    const rs = data.kolReminderSettings || {};
    if (rs.myStaffName) staffMap[insid] = rs.myStaffName;
  }
  const ownerName = (insid) => team[insid] || staffMap[insid] || "";

  const map = {}; // personKey -> person
  function ensure(key) {
    if (!map[key]) map[key] = { key, owners: {}, ownerIds: {}, _profileAt: 0, _threadAt: 0, _sumAt: 0 };
    return map[key];
  }

  for (const { insid, data } of backups) {
    const profiles = data.kolProfiles || {};
    const threads = data.kolThreads || {};
    const summaries = data.kolSummaries || {};
    const understanding = data.kolUnderstanding || {};

    // 档案（按 updatedAt 取最新一份）
    for (const [pk, prof] of Object.entries(profiles)) {
      if (!prof || typeof prof !== "object") continue;
      const key = profileKey(prof.displayName || pk);
      const p = ensure(key);
      p.owners[ownerName(insid)] = true;
      p.ownerIds[insid] = true;
      const at = ts(prof.updatedAt);
      if (at >= p._profileAt || !p.profile) {
        p._profileAt = at;
        p.profile = prof;
        p.displayName = prof.displayName || pk;
      }
    }

    // 会话状态（按 lastSeenAt 取最新）
    // 关键：用 thread 的 map key(tk) 关联——它和 kolProfiles 的 key 同样是「规范化名字」，
    // 实习生从当前对话自动建档时两边天然对齐。别用 th.title（群名带价格，对不上）。
    for (const [tk, th] of Object.entries(threads)) {
      if (!th || typeof th !== "object") continue;
      const key = profileKey(tk);
      const p = ensure(key);
      p.owners[ownerName(insid)] = true;
      p.ownerIds[insid] = true;
      const at = ts(th.lastSeenAt);
      if (at >= p._threadAt || !p.thread) {
        p._threadAt = at;
        p.thread = th;
        if (!p.displayName) p.displayName = th.title || th.creatorName || tk;
      }
    }

    // 总结（按 updatedAt 取最新）
    for (const [sk, su] of Object.entries(summaries)) {
      if (!su || typeof su !== "object" || !su.text) continue;
      const key = profileKey(su.key || su.name || sk);
      if (!map[key]) continue; // 只挂到已知的人
      const at = ts(su.updatedAt);
      if (at >= map[key]._sumAt) {
        map[key]._sumAt = at;
        map[key].summary = su.text;
      }
    }

    // 当前阶段（kolUnderstanding 按 name key 存）
    for (const [uk, u] of Object.entries(understanding)) {
      if (!u || typeof u !== "object" || !u.stage) continue;
      const key = profileKey(uk);
      if (!map[key]) continue;
      map[key].stageReal = u.stage;
    }
  }

  // 收尾：拍平成对外结构
  const out = [];
  for (const p of Object.values(map)) {
    const prof = p.profile || {};
    const th = p.thread || {};
    // 只要「群聊」= 真实合作的红人。私聊/便签/动态/UI 文字一律不进表
    // （私聊只进插件提醒，催运营自己去回复砍价）。
    if (!th.isGroup) continue;
    const ov = overrides[p.key] || {};
    const dealSrc = th.isGroup ? th.title : "";
    const deal = parseDeal(dealSrc);
    const region = detectRegion(
      `${th.title || ""} ${th.lastMsgPreview || ""} ${p.summary || ""}`
    );
    const products = [...new Set(Object.keys(p.ownerIds).map(productOf).filter(Boolean))];
    out.push({
      key: p.key,
      displayName: pickDisplayName(prof, th, p.key),
      nickname: prof.nickname || "",
      handle: pickHandle(th),
      category: prof.category || "",
      region,
      products,
      // 合同/身份
      appid: prof.appid || "",
      legalname: prof.legalname || "",
      email: prof.email || "",
      payment: prof.payment || "",
      // 合作信息
      theme: prof.theme || "",
      notes: prof.notes || "",
      recommend: !!prof.recommend,
      recommendReason: prof.recommendReason || "",
      blacklist: !!prof.blacklist,
      blacklistReason: prof.blacklistReason || "",
      // 群名解析
      price: deal.price,
      platforms: deal.platforms,
      usagePeriod: deal.usagePeriod,
      // 领导标记
      quality: !!ov.quality,
      // 进度/跟进（真阶段优先，没有就启发式推断）
      stage: p.stageReal || computeStage(prof, th, p.summary, deal.price),
      summary: p.summary || "",
      threadId: th.threadId || "",
      isGroup: !!th.isGroup,
      needsReplyRaw: !!th.needsReplyRaw,
      firstUnrepliedAt: th.firstUnrepliedAt || "",
      lastFollowUpAt: th.lastFollowUpAt || "",
      lastSeenAt: th.lastSeenAt || "",
      updatedAt: prof.updatedAt || "",
      // 对接：ig账号 + 员工名（防换人/换号；员工名来自插件设置或 team 表，没填则空）
      owners: Object.keys(p.ownerIds).map((id) => ({ account: id, name: team[id] || staffMap[id] || "" })),
      aliases: [], noId: false, collabCount: 0, qualityCount: 0,
      sources: ["群聊"] // 来自当前群聊扫描（实时）
    });
  }
  // 追加历史导入。注意：这里返回「未合并」的原始记录（每个群聊/每条历史一行）。
  // 资源库按 handle 合并成一人一行；看板要按群聊粒度，所以合并只在 buildLibrary 做。
  appendImport(out);
  return out;
}

// handle → 统一外号/别名（给看板每行补外号显示，但不合并行）
function nickIndex(list) {
  const idx = {};
  for (const p of list) {
    const h = profileKey(p.handle || "");
    if (!h) continue;
    const e = idx[h] || (idx[h] = { nickname: "", aliases: [] });
    for (const a of [p.nickname, ...(p.aliases || [])]) {
      if (!a) continue;
      if (!e.nickname) e.nickname = a;
      else if (a !== e.nickname && !e.aliases.includes(a)) e.aliases.push(a);
    }
  }
  return idx;
}

// 历史导入：读 live 覆盖或仓库种子
function loadImport() {
  const live = path.join(DATA_DIR, "roster-import.json");
  const seed = path.join(__dirname, "seed", "roster-import.json");
  return readJSON(fs.existsSync(live) ? live : seed, []) || [];
}
// 把历史导入记录都转成 person 记录追加进列表（不在这里匹配，交给 mergeByHandle 统一按 handle 合并）
function appendImport(out) {
  for (const r of loadImport()) {
    const plats = (r.platforms || "").split(" / ").map((s) => s.trim()).filter(Boolean);
    out.push({
      key: "import:" + profileKey(r.handle || r.nickname || ""),
      displayName: r.nickname || r.handle || "", nickname: r.nickname || "", handle: r.handle || "",
      aliases: r.aliases || [], noId: !!r.noId,
      category: r.category || "", region: r.region || "", products: r.product ? [r.product] : [],
      appid: "", legalname: "", email: "", payment: "",
      theme: r.theme || "", notes: r.notes || "",
      recommend: false, recommendReason: "",
      blacklist: r.blacklist === "1", blacklistReason: r.blacklistReason || "",
      price: r.price || "", platforms: plats, usagePeriod: "",
      quality: r.quality === "1",
      collabCount: r.collabCount || 0, qualityCount: r.qualityCount || 0,
      stage: r.stage || "已完成", summary: "",
      threadId: "", isGroup: true, needsReplyRaw: false, firstUnrepliedAt: "", lastFollowUpAt: "", lastSeenAt: "", updatedAt: "",
      owners: r.owner ? [{ account: "", name: r.owner }] : [],
      sources: ["历史"]
    });
  }
}
// 唯一身份 = IG handle。同 handle → 合并成一条（不同外号收进 aliases、跨产品/对接人/来源并集）。
// 没 handle 的不合并（标 noId 待人工核对）。绝不用外号判同一性（避免撞名误并）。
function mergeByHandle(list) {
  const groups = {};
  const out = [];
  for (const p of list) {
    const h = profileKey(p.handle || "");
    if (!h) { out.push(buildMergedPerson([p])); continue; } // 无 handle 各自一行
    (groups[h] = groups[h] || []).push(p);
  }
  for (const recs of Object.values(groups)) out.push(buildMergedPerson(recs));
  return out;
}
// 把同一 handle 的多条记录合成一人，但「主观评价」（值得/黑名单/备注）按来源分别保留进 evaluations，
// 不抹平——同一人在不同对接人/产品手里表现可能不同。
function buildMergedPerson(recs) {
  const t = recs[0];
  t.aliases = t.aliases || [];
  t.evaluations = [];
  const pushEval = (r) => {
    const has = r.recommend || r.blacklist || (r.recommendReason || "").trim() || (r.blacklistReason || "").trim() || (r.notes || "").trim();
    if (!has) return;
    t.evaluations.push({
      by: (r.owners || []).map((o) => o.name || o.account).filter(Boolean).join("、") || (r.sources || []).join("/"),
      products: r.products || [],
      recommend: !!r.recommend, recommendReason: r.recommendReason || "",
      blacklist: !!r.blacklist, blacklistReason: r.blacklistReason || "",
      notes: (r.notes || "").trim()
    });
  };
  pushEval(recs[0]);
  for (let i = 1; i < recs.length; i++) { mergePerson(t, recs[i]); pushEval(recs[i]); }
  t.aliases = t.aliases.filter((a) => a && a !== t.nickname);
  // 评价分歧：既有人说值得、又有人拉黑
  t.conflict = t.evaluations.some((e) => e.recommend) && t.evaluations.some((e) => e.blacklist);
  return t;
}
function mergePerson(t, p) {
  t.aliases = t.aliases || [];
  for (const a of [p.nickname, ...(p.aliases || [])])
    if (a && a !== t.nickname && !t.aliases.includes(a)) t.aliases.push(a);
  const fill = (k) => { if (!t[k] && p[k]) t[k] = p[k]; };
  ["nickname", "displayName", "category", "theme", "price", "usagePeriod", "notes",
    "appid", "legalname", "email", "payment", "recommendReason", "blacklistReason", "summary", "stage"].forEach(fill);
  // 地区：历史导入(手填表)是权威，优先用它
  if (p.region && ((p.sources || []).includes("历史") || !t.region)) t.region = p.region;
  t.quality = t.quality || p.quality;
  t.recommend = t.recommend || p.recommend;
  // 合作/优质视频数：跨产品累加（有人几个产品都合作/优质）
  t.collabCount = (t.collabCount || 0) + (p.collabCount || 0);
  t.qualityCount = (t.qualityCount || 0) + (p.qualityCount || 0);
  if (p.blacklist) { t.blacklist = true; if (!t.blacklistReason) t.blacklistReason = p.blacklistReason || ""; }
  // 实时字段：群聊的更权威
  if (!t.threadId && p.threadId) { t.threadId = p.threadId; t.isGroup = p.isGroup; }
  if (p.needsReplyRaw) t.needsReplyRaw = true;
  if (p.lastFollowUpAt && (!t.lastFollowUpAt || p.lastFollowUpAt > t.lastFollowUpAt)) t.lastFollowUpAt = p.lastFollowUpAt;
  if (p.firstUnrepliedAt && !t.firstUnrepliedAt) t.firstUnrepliedAt = p.firstUnrepliedAt;
  t.platforms = [...new Set([...(t.platforms || []), ...(p.platforms || [])])];
  t.products = [...new Set([...(t.products || []), ...(p.products || [])])];
  const seen = new Set((t.owners || []).map((o) => o.account + "|" + o.name));
  for (const o of p.owners || []) { const k = o.account + "|" + o.name; if (!seen.has(k)) { t.owners.push(o); seen.add(k); } }
  t.sources = [...new Set([...(t.sources || []), ...(p.sources || [])])];
}

// ---------- 进度看板：从合并结果再算盯人/漏人 ----------
function buildBoard() {
  const all = buildRoster();
  const now = Date.now();
  const nidx = nickIndex(all); // 借 handle 给每行补统一外号（不合并行）
  // 跟进看板只看「当前群聊」（实时）。历史导入的红人不进看板，只进资源库。
  // 按群聊粒度：同一人在 2 个群 = 2 行待办（不同产品/对接人各自处理）。
  const active = all.filter((p) => (p.sources || []).includes("群聊"));

  const items = active.map((p) => {
    const ni = nidx[profileKey(p.handle || "")] || {};
    const fu = ts(p.lastFollowUpAt);
    const daysSinceFollow = fu ? Math.floor((now - fu) / DAY) : null;
    // 漏人：红人发了消息、对接人还没回；隔夜 = firstUnrepliedAt 超过 1 天。
    // 黑名单/已放弃的不算失责（红人不回 ≠ 实习生的锅）。
    const overdueMs = p.firstUnrepliedAt ? now - ts(p.firstUnrepliedAt) : 0;
    const missed = p.needsReplyRaw && !p.blacklist;
    const overnight = missed && overdueMs > DAY;
    return {
      key: p.key,
      name: ni.nickname || p.nickname || p.displayName,
      handle: p.handle,
      region: p.region,
      category: p.category,
      products: p.products,
      price: p.price,
      platforms: p.platforms,
      theme: p.theme,
      stage: p.stage,
      summary: p.summary,
      threadId: p.threadId,
      owners: p.owners,
      missed,
      overnight,
      daysSinceFollow,
      lastFollowUpAt: p.lastFollowUpAt
    };
  });

  // 阶段分布（漏斗，无「已完成」）
  const stageBuckets = {};
  for (const it of items) {
    const s = it.stage || "未判断";
    stageBuckets[s] = (stageBuckets[s] || 0) + 1;
  }

  // 今日盯人：按对接人(账号)聚合
  const byOwner = {};
  for (const it of items) {
    const list = it.owners.length ? it.owners : [{ account: "未分配", name: "" }];
    for (const o of list) {
      const k = o.account;
      byOwner[k] = byOwner[k] || { owner: o.name || o.account, total: 0, missed: 0, overnight: 0 };
      byOwner[k].total++;
      if (it.missed) byOwner[k].missed++;
      if (it.overnight) byOwner[k].overnight++;
    }
  }

  const overnightList = items
    .filter((i) => i.overnight)
    .sort((a, b) => (b.daysSinceFollow || 0) - (a.daysSinceFollow || 0));

  return {
    total: items.length,
    products: productsIn(items),
    stageBuckets,
    overnight: overnightList.map((i) => ({ name: i.name, days: i.daysSinceFollow })),
    owners: Object.values(byOwner).sort((a, b) => b.overnight - a.overnight),
    items: items.sort((a, b) => (b.daysSinceFollow || 0) - (a.daysSinceFollow || 0))
  };
}

// 收集出现过的产品（按 PRODUCT_CODES 固定顺序）
function productsIn(items) {
  const set = new Set(items.flatMap((i) => i.products || []));
  return PRODUCT_CODES.filter((c) => set.has(c));
}

// ---------- 资源库统计 ----------
function buildLibrary() {
  // 资源库：按 handle 合并成一人一行（看板不合并，见 buildBoard）
  const all = mergeByHandle(buildRoster());
  const stats = {
    total: all.length,
    quality: all.filter((p) => p.quality).length,
    recommend: all.filter((p) => p.recommend && !p.quality).length,
    blacklist: all.filter((p) => p.blacklist).length
  };
  return { stats, products: productsIn(all), items: all };
}

// ---------- HTTP ----------
function send(res, code, body, type) {
  res.writeHead(code, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-KOL-Token, X-KOL-Admin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}
function authOK(req, url) {
  if (!TOKEN) return true;
  const t = req.headers["x-kol-token"] || url.searchParams.get("token") || "";
  return t === TOKEN;
}
function adminOK(req) {
  if (!ADMIN_TOKEN) return true;
  return (req.headers["x-kol-admin"] || "") === ADMIN_TOKEN;
}
function serveFile(res, file) {
  const ext = path.extname(file);
  const type =
    ext === ".html" ? "text/html; charset=utf-8" :
    ext === ".css" ? "text/css; charset=utf-8" :
    ext === ".js" ? "application/javascript; charset=utf-8" : "text/plain";
  try {
    send(res, 200, fs.readFileSync(file, "utf8"), type);
  } catch {
    send(res, 404, "not found", "text/plain");
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === "OPTIONS") return send(res, 204, "");

  // 健康检查（放行）
  if (p === "/health") {
    return send(res, 200, { ok: true, dataDir: DATA_DIR, backups: loadBackups().length });
  }

  // 页面
  if (p === "/" ) return serveFile(res, path.join(WEB_DIR, "library.html"));
  if (p === "/board") return serveFile(res, path.join(WEB_DIR, "board.html"));
  if (p.startsWith("/web/")) return serveFile(res, path.join(WEB_DIR, p.slice(5)));

  // API（需口令）
  if (p.startsWith("/api/")) {
    if (!authOK(req, url)) return send(res, 401, { error: "需要团队口令" });

    if (p === "/api/roster" && req.method === "GET") {
      return send(res, 200, buildLibrary());
    }
    if (p === "/api/board" && req.method === "GET") {
      return send(res, 200, buildBoard());
    }
    if (p === "/api/team") {
      if (req.method === "GET") return send(res, 200, loadTeamMap());
      if (req.method === "POST") {
        if (!adminOK(req)) return send(res, 403, { error: "需要管理员口令" });
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const obj = readBody(body);
          if (!obj) return send(res, 400, { error: "格式错误" });
          writeJSON(TEAM_PATH, obj);
          send(res, 200, { ok: true });
        });
        return;
      }
    }
    // 领导写「优质」标记
    const lm = p.match(/^\/api\/roster\/(.+)\/leader$/);
    if (lm && req.method === "POST") {
      if (!adminOK(req)) return send(res, 403, { error: "需要管理员口令" });
      const key = decodeURIComponent(lm[1]);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const obj = readBody(body) || {};
        const ov = loadOverrides();
        ov[key] = {
          quality: !!obj.quality,
          qualityBy: obj.by || "",
          qualityAt: new Date().toISOString()
        };
        writeJSON(OVERRIDES_PATH, ov);
        send(res, 200, { ok: true, key, quality: ov[key].quality });
      });
      return;
    }
    return send(res, 404, { error: "未知接口" });
  }

  send(res, 404, "not found", "text/plain");
});

function readBody(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

server.listen(PORT, () => {
  console.log(`[roster] 监听 :${PORT}  数据目录 ${DATA_DIR}  备份 ${loadBackups().length} 份`);
});
