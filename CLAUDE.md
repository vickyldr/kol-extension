# CLAUDE.md —— 接手须知（任何新窗口动代码前，先读完这一页）

> 这份文件是给「没有上下文的 AI 窗口 / 新来的技术」准备的。
> 目标：**一上来就知道这是什么、哪些是绝不能动的核心红线、改完怎么验证、怎么发布。**
> 改任何东西前，先把 §1 §2 §3 读完。

---

## 0. 一句话

这是 **「KOL 双语沟通助手」** —— 一个给中国 KOL 运营团队用的 **Chrome 扩展 + 轻量 Node 后端**：
帮运营**看懂红人外语消息、匹配团队话术、生成双语回复、提醒待回复/待跟进**。后端还兼做**团队话术库 / 物料库**的存取和 AI 代理。

⚠️ 本仓库**只**是这个插件项目。和「KOL 付款审批核对」（Python、飞书、财务逻辑）是**两个不相干的项目**，已拆开，别混。

---

## 1. 架构：三块，别搞混在哪运行

| 块 | 是什么 | 跑在哪 | 关键文件 |
|---|---|---|---|
| **① Chrome 插件（前端）** | 装在每个运营 Chrome 里的界面 | 每个人的浏览器 | `manifest.json` `sidepanel.*` `content.js` `background.js` `kol-reminder.js` `reminders.*` `knowledge.js` `docx-import.js` |
| **② Node 后端（server）** | 调 AI、存/取话术与物料的"大脑" | 团队的 VPS（单人也可本机） | `server.js`（**纯 Node，零 npm 依赖**，只用 `node:http/fs/path/crypto`） |
| **③ 数据** | 话术 / 知识库 / 物料 / 产品资料 | 见 §3 的三层边界 | `data/*.json` `data/assets/` |

- 插件通过 HTTP 调后端（`sidepanel.js` 顶部 `API_BASE` 默认指向 VPS IP，可在「服务器设置」里改）。
- 后端 AI 用 **阿里云百炼 / Qwen**（`DASHSCOPE_API_KEY`）。模型：`MODEL`=`qwen-flash`（快，用户面前的都用它）、`MODEL_SMART`=`qwen-plus`（只给后台提醒判断用）。
- **打包给商店的 zip 不含 `server.js` 和 `data/`**（见 `build-store-zip.sh` 的 FILES 白名单）——同事的插件不携带任何话术，运行时才从服务器取。

---

## 2. 🚫 核心红线（改代码绝不能破坏这些 —— 破了等于产品坏了）

1. **对外回复(A) 与 内部建议(B) 严格隔离。**
   AI 输出分两类：A=可直接发给红人的自然话术；B=只给运营看的（问 TL、预算上限、操作步骤、风险）。
   **B 绝不能混进 A。** 这是 `server.js` 系统提示词里反复强调的第一规则，UI 里内部建议是紫色、标注"别发给红人"。
2. **不许 AI 编造商务事实。** 金额/报价、授权期限、付款承诺、视频时长、发布平台数量、社媒账号、下载链接——**没确认就不能由 AI 填**。算术（如金额）尤其不能让 AI 估。
3. **产品资料未录入时用 `generic`**，只生成通用回复，不编品牌名/账号/链接（见 `products.json` 的 `generic` 和 `forbidden_claims`）。
4. **翻译要忠实，不改红人原语言**（别把对方的西语回复"顺手"翻成英语再发）。
5. **写数据永远写线上目录（`KOL_DATA_DIR`），绝不回写代码种子 `data/`。**
   见 §3。这条踩过坑：`KNOWLEDGE_PATH` 若在启动时一次性解析、线上文件还没生成时会指向种子，导入会覆盖仓库种子。**读用 `knowledgeReadPath()`（每次动态判断），写用 `KNOWLEDGE_LIVE_PATH`（永远 `DATA_DIR`）。** 新增任何"可写"的数据文件都照此办。

> 改动若触碰以上任何一条，必须在 PR/说明里点名，并保留原有保护逻辑。

---

## 3. 数据边界（拆仓库 / 换电脑 / 分享代码前必看）

三层，靠 `server.js` 的 `seedOrLive()` 自动区分：

1. **出厂种子**：仓库里的 `data/*.json`（`knowledge-base/playbook/quick-templates/products`）。跟着代码走，装插件/拆仓库时带的默认内容。**在 git 里。**
2. **线上运行数据**：VPS 上 `KOL_DATA_DIR`（一般 `~/kol-data/`）里的同名文件。**不在 git**，团队日常增改都落这里。
3. **规则**：读取时 `seedOrLive("x.json")` —— **`KOL_DATA_DIR` 里有同名文件就用线上那份（覆盖种子），没有才用种子**。**写入永远写 `KOL_DATA_DIR`。**

数据文件清单：
| 文件 | 是什么 | schema 要点 |
|---|---|---|
| `knowledge-base.json` | 团队话术库（AI 检索用） | `{source, stable_id, scene, fields:{语言/列名:文本}}`，可带 `product/region` |
| `playbook.json` | 话术脚本 | `{product, stage, name, texts:{语言:文本}, notes, id}` |
| `quick-templates.json` | 快捷生成模板 | `{id, category, name, chinese_intent, required_variables}` |
| `products.json` | 产品资料 | 有 `generic` 兜底 + `forbidden_claims` |
| `scenario-archive.json` | 用户存的话术存档 | 用户数据，放 `KOL_DATA_DIR` |
| `assets.json` + `assets/` | 物料库（图片/链接/备注） | 图片文件存 `assets/<id>.<ext>` |

---

## 4. 改完怎么验证（没有 CI，靠这些手动门槛）

```bash
# 语法（任何 .js 改完都跑）
node --check server.js
node --check sidepanel.js
node --check docx-import.js

# 起后端本地自测（不配 KEY 时 AI 相关走兜底，不报错）
KOL_DATA_DIR=/tmp/kol-test KOL_ASSISTANT_PORT=3399 node server.js
curl -s localhost:3399/health

# docx 解析器测试：浏览器代码（用 DOMParser/DecompressionStream），必须在真 Chromium 里测，不能只在 node。
# 预装 Chromium：/opt/pw-browsers/chromium-1194/chrome-linux/chrome
# 用 --headless=new --allow-file-access-from-files --virtual-time-budget=... --dump-dom 跑一个 file:// 测试页，
# 让页面 fetch 一份 .docx → KOLDocxImport.parse() → 把结果写进 DOM 再 dump 出来读。
```

- 涉及 **knowledge-base 写入** 的改动：务必测「写进 `KOL_DATA_DIR`、种子 `data/` 纹丝不动、二次导入幂等」。
- 涉及 **A/B 隔离 / 不编造** 的改动：人工核对几条输出，别让内部建议或编造金额漏进对外回复。

---

## 5. 发布流程

### 插件（前端）
1. 改了任何 **§1 ① 列出的前端文件** → `manifest.json` 的 `version` **必须 +1**（商店要求新版本号更高）。
2. **新增了前端文件** → 一定要把它加进 `build-store-zip.sh` 的 `FILES` 白名单，否则打出来的包会缺文件、插件加载报错（`docx-import.js` 就是这么差点漏掉的）。
3. `bash build-store-zip.sh` → 生成 `kol-assistant-v<版本>.zip`（zip 已 gitignore，不进库）。
4. Chrome 开发者后台 →「软件包」→ 上传新 zip → 提交审核。审核过后**成员自动更新**（从商店装的话）。

### 后端（server.js / 数据）
- 改 `server.js`：VPS 上 `git pull` + 重启 node 服务。成员无感。
- 改话术/知识库：用插件「📥 团队库」上传 Word，或直接改 VPS `~/kol-data/`。成员无感（实时取）。

---

## 6. 约定

- **注释、提交信息、文档：中文**（团队是中文运营）。代码风格跟周边一致，零依赖优先（别随便加 npm 包，后端要在 VPS 裸跑）。
- 提交信息讲清「解决什么 + 怎么做」，别只写"fix"。
- 改了功能 → 同步更新 `功能说明书.md`（逐功能：输入/输出/解决什么/思路）。
- `host_permissions`（manifest）要覆盖后端 API 的主机（MV3 match pattern 不区分端口）。

---

## 7. 关键文件地图

```
manifest.json          插件清单（版本号、权限、入口）
sidepanel.html/js/css  主界面（翻译/回复/话术库/物料库/团队库导入/提醒）—— sidepanel.js 是最大的文件
content.js             注入 IG/Gmail/Outlook 页面，取对话上下文
kol-reminder.js        页面侧"搭便车"采集 + 提醒
background.js          service worker：判断代理、闹钟、四渠道提醒
reminders.html/js      独立提醒清单弹窗
knowledge.js           内置场景库 + 语言识别 + 关键词匹配（前端兜底）
docx-import.js         ⭐ 团队库 Word 导入：浏览器端零依赖解析 .docx（解压+XML），拆表格成话术+抽图
server.js              ⭐ 后端全部逻辑：AI 代理、话术/物料存取、/api/* 路由
data/*.json            出厂种子（见 §3）
build-store-zip.sh     打商店 zip（FILES 白名单！）
功能说明书.md           逐功能说明（实时维护，给人看）
团队使用说明-大白话.md   给非技术成员的使用说明
```

主要后端接口：`/api/reply` `/api/analyze` `/api/translate` `/api/rewrite` `/api/ask` `/api/judge` `/api/summary` `/api/parse-todo` `/api/assets` `/api/archive` `/api/playbook` `/api/knowledge/import`（团队库 Word 导入，仅管理员）。

---

## 8. 权限模型

- `KOL_ASSISTANT_TOKEN`（团队口令）：设了之后所有 `/api/*` 必须带 `X-KOL-Token`（`/health` 放行）。
- `KOL_ASSISTANT_ADMIN_TOKEN`（管理员口令）：设了之后，**编辑/删除已有话术、删物料、导入团队库**要带 `X-KOL-Admin`。没设＝本机单人模式，全放行。
- 普通成员：能用、能新增、能预览导入；不能改/删已有、不能落库导入。

---

## 9. 已知的坑（别再踩）

1. **`seedOrLive` 写入**：写数据一律写 `DATA_DIR`，别写种子（§2.5 / §3）。
2. **`build-store-zip.sh` 白名单**：新增前端文件必须登记，否则打包漏文件。
3. **docx 解析靠浏览器 API**（`DOMParser` / `DecompressionStream`），node 里没有 DOMParser，测要用真 Chromium。
4. **`sidepanel.js` 里 `API_BASE` 默认是 VPS IP**，本机调试记得在「服务器设置」里改成 `http://127.0.0.1:3210`。
5. 后端**零依赖**是有意为之（VPS 裸跑），加依赖前三思。
