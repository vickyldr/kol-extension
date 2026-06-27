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
  if (/[가-힣]/.test(text) || /\b(kr|韩|韓|韩国|韓國)\b/i.test(text)) return "KR";
  if (/[぀-ヿ]/.test(text) || /\b(jp|日本|日语)\b/i.test(text)) return "JP";
  return "TW";
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
  const ownerName = (insid) => team[insid] || insid;

  const map = {}; // personKey -> person
  function ensure(key) {
    if (!map[key]) map[key] = { key, owners: {}, _profileAt: 0, _threadAt: 0, _sumAt: 0 };
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
    const ov = overrides[p.key] || {};
    const dealSrc = th.isGroup ? th.title : "";
    const deal = parseDeal(dealSrc);
    const region = detectRegion(
      `${th.title || ""} ${th.lastMsgPreview || ""} ${p.summary || ""}`
    );
    out.push({
      key: p.key,
      displayName: p.displayName || p.key,
      nickname: prof.nickname || "",
      handle: th.title && th.isGroup ? "" : th.creatorName || "",
      category: prof.category || "",
      region,
      // 合同/身份
      appid: prof.appid || "",
      legalname: prof.legalname || "",
      email: prof.email || "",
      payment: prof.payment || "",
      // 合作信息
      script: prof.script || "",
      theme: prof.theme || "",
      temperament: prof.temperament || "",
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
      // 进度/跟进
      stage: p.stageReal || "",
      summary: p.summary || "",
      threadId: th.threadId || "",
      isGroup: !!th.isGroup,
      needsReplyRaw: !!th.needsReplyRaw,
      firstUnrepliedAt: th.firstUnrepliedAt || "",
      lastFollowUpAt: th.lastFollowUpAt || "",
      lastSeenAt: th.lastSeenAt || "",
      updatedAt: prof.updatedAt || "",
      owners: Object.keys(p.owners)
    });
  }
  return out;
}

// ---------- 进度看板：从合并结果再算盯人/漏人 ----------
function buildBoard() {
  const all = buildRoster();
  const now = Date.now();
  // 只看「当前在聊」：有会话且近期 seen（30 天内），且不在黑名单
  const active = all.filter(
    (p) => p.thread !== undefined || p.threadId || p.stage || p.needsReplyRaw || p.lastFollowUpAt
  );

  const items = active.map((p) => {
    const fu = ts(p.lastFollowUpAt);
    const daysSinceFollow = fu ? Math.floor((now - fu) / DAY) : null;
    // 漏人：红人发了消息、对接人还没回；隔夜 = firstUnrepliedAt 超过 1 天。
    // 黑名单/已放弃的不算失责（红人不回 ≠ 实习生的锅）。
    const overdueMs = p.firstUnrepliedAt ? now - ts(p.firstUnrepliedAt) : 0;
    const missed = p.needsReplyRaw && !p.blacklist;
    const overnight = missed && overdueMs > DAY;
    return {
      key: p.key,
      name: p.nickname || p.displayName,
      handle: p.handle,
      region: p.region,
      category: p.category,
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

  // 今日盯人：按对接人聚合
  const byOwner = {};
  for (const it of items) {
    for (const o of it.owners.length ? it.owners : ["未分配"]) {
      byOwner[o] = byOwner[o] || { owner: o, total: 0, missed: 0, overnight: 0 };
      byOwner[o].total++;
      if (it.missed) byOwner[o].missed++;
      if (it.overnight) byOwner[o].overnight++;
    }
  }

  const overnightList = items
    .filter((i) => i.overnight)
    .sort((a, b) => (b.daysSinceFollow || 0) - (a.daysSinceFollow || 0));

  return {
    total: items.length,
    stageBuckets,
    overnight: overnightList.map((i) => ({ name: i.name, days: i.daysSinceFollow })),
    owners: Object.values(byOwner).sort((a, b) => b.overnight - a.overnight),
    items: items.sort((a, b) => (b.daysSinceFollow || 0) - (a.daysSinceFollow || 0))
  };
}

// ---------- 资源库统计 ----------
function buildLibrary() {
  const all = buildRoster();
  const stats = {
    total: all.length,
    quality: all.filter((p) => p.quality).length,
    recommend: all.filter((p) => p.recommend && !p.quality).length,
    blacklist: all.filter((p) => p.blacklist).length
  };
  return { stats, items: all };
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
