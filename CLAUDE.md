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

## 0b. ⭐ 大改版进行中（开发分支 `claude/sleepy-fermat-eqatjn`，尚未发布上线）

> **新窗口先读这节**：当前 `main`（线上）还是旧界面，开发分支做了一次**整体 UI 重构**。
> 施工图全文在 **`按钮逻辑清单.md`**（每个按钮：在哪/点了干嘛/数据哪来/调不调 AI/结果显示哪）+ 界面草图 `docs/界面草图.png`。**改这块前先读那两份。**

**这次改版做了什么（已实现、已推开发分支、未合 main）：**

1. **回复页砍成一条线、删掉三 tab。** 旧的顶部三 tab（红人来消息／我主动发／问 AI）+ 整块「我主动发」(`panel-proactive`)、「问 AI」(`panel-chat`) 及其全部 JS **已删**。回复页现在从上到下固定 7 块：
   `🗂️红人档案(折叠)` → `🧠AI理解` → `⚡快捷回复` → `红人原文[这是什么意思/这怎么办]` → `我想回复(中文)[忠实翻译/润色生成]` → `✅双语回复(A·可发)` → `✍️AI改写`。
2. **🧠 AI 理解（新置顶块）**：打开对话后**自动跑** `/api/analyze`（`maybeRunUnderstanding`），输出「当前阶段／建议下一步／发送前风险」。**有缓存先显示、消息签名变了才重算**（存 `kolUnderstanding`，省 token）。触发靠**对话采集**，不是粘贴触发。删了紫色徽标、复制按钮。
3. **提醒/待办 = 独立窗口三桶**（`reminders.html`/`reminders.js`，开浏览器自动弹）：
   - 🔴 **立即回复** = `needsReplyRaw`（天然含未读 + 已读不回，**无时间阈值**，窗口实时显示）
   - 🟠 **今天跟进** = 当天到点（含过期）的待办，**纯按 dueAt 日期，无 AI 天数阈值**
   - 📅 **以后** = 用户自己选了未来日期的待办
   - **每条卡片一行中文总结**（见下「总结三级回退」）；侧边栏 🔔 面板已**简化成「加待办 + 打开完整清单按钮」**，不再有平铺列表。
4. **删除清单**：合作进展存档面板 + 手动📸抓取 + 旧 `grab()`；顶部独立「上传话术」按钮（并进话术库面板）；设置里导出/导入文件按钮；双语回复下的「识别&内部提醒」(`analysis-block`)整块 + 「保存为确认话术」(`save-scenario`)；死函数 `analyze()`/`runDeepAnalysis()`。

**提醒卡片「一行总结」的核心逻辑（用户反复强调、踩过坑，别改歪）：**
- 用户**看不懂外语**，所以总结那行**必须是中文**。**绝不贴红人外语原文**（IG 本来就显示原文，贴原文＝AI 白费）、**绝不只显示「未读」**、**绝不放无意义占位**（"还没读过点进去看"这类已被用户骂删）。
- **三级回退**（`reminders.js` `computeItems`）：① 点进去过 → `kolSummaries` 真总结（离开对话时 `autoUpdateSummaryOnLeave` 按 12 步流程生成，最完整）；② 没点进去过的待回复 → `autoSummary`（`summarizePreviewsForReply` 把收件箱预览那句外语让 AI **归纳成一句中文**，`/api/summary` 的 `mode:"preview"` 分支，qwen-flash）；③ 都没有 → **留空，不显示那行**（meta 行「未读 · 已等5分钟」承担提醒原因）。
- **「提醒原因」≠「总结」**：用户说的「不能只有未读」指 meta 那行要说清为什么提醒（未读／已读未回／今天到点），这是状态行；总结那行是「红人说到哪、该干嘛」。两行各司其职。

**这块踩过/审计抓出的坑（已修，别回退）：**
- `kolSummaries` 真总结按**数字 threadId** 存，但提醒清单按**名字 key** 取——必须**双写名字 key**（`autoUpdateSummaryOnLeave` 里 `all[buf.key]=rec`）+ `upsertThread` **别用名字 id 覆盖 patch 的数字 threadId**，否则点过的对话清单里显示不出真总结、「打开对话」深链也失效。
- `reminders.js` 的 `storage.onChanged` **必须听 `kolSummaries`**（真总结常单独写入，漏听则已开窗口不刷新）。
- `summarizePreviewsForReply` 要**去重（`previewSummarizedSig`）+ 限量（每次最多 3 条）**，否则几十个未读时 AI 请求爆发、反复花钱。
- 开机自动弹窗判定**别复用带阈值的 `computeReminders`**（那是桌面通知节流用的，5分钟/1小时阈值）——用 `hasWindowPendingItems()` 和窗口同口径（无阈值），否则刚开机"窗口本该有内容却不弹"。
- `/api/summary` 的 `mode:"preview"` prompt 里保留「不编造金额/日期/承诺」约束（红线2）。

> **改版相关疑问优先查 `按钮逻辑清单.md`；那份是逐按钮的权威施工图。**

---

## 1. 架构：三块，别搞混在哪运行

| 块 | 是什么 | 跑在哪 | 关键文件 |
|---|---|---|---|
| **① Chrome 插件（前端）** | 装在每个运营 Chrome 里的界面 | 每个人的浏览器 | `manifest.json` `sidepanel.*` `content.js` `background.js` `kol-reminder.js` `reminders.*` `knowledge.js` `docx-import.js` `react-guard.js` |
| **② Node 后端（server）** | 调 AI、存/取话术与物料的"大脑" | 团队的 VPS（单人也可本机） | `server.js`（**纯 Node，零 npm 依赖**，只用 `node:http/fs/path/crypto`） |
| **③ 数据** | 话术 / 知识库 / 物料 / 产品资料 | 见 §3 的三层边界 | `data/*.json` `data/assets/` |

- 插件通过 HTTP 调后端（`sidepanel.js` 顶部 `API_BASE` 默认指向 VPS IP，可在「服务器设置」里改）。
- 后端 AI 用 **阿里云百炼 / Qwen**（`DASHSCOPE_API_KEY`）。模型：`MODEL` / `MODEL_FAST`=`qwen-flash`（用户面前的都用它）。`MODEL_SMART` 现在线上也设成 `qwen-flash`（systemd 的 `model.conf` 里 `DASHSCOPE_MODEL_SMART=qwen-flash`，省钱；`/api/judge` 那次从 qwen-plus 改过来）。`/health` 返回的 `model/model_fast/model_smart` 三个字段是实时真相，以它为准。
- **打包给商店的 zip 不含 `server.js` 和 `data/`**（见 `build-store-zip.sh` 的 FILES 白名单）——同事的插件不携带任何话术，运行时才从服务器取。
- **`react-guard.js` 必须最早、在「页面主世界」注入**（manifest `world:"MAIN"` + `run_at:"document_start"`，单独一条 content_scripts）：给 `Node.prototype.removeChild/insertBefore` 加防御，避免我们的内联翻译节点打断 IG/Gmail 的 React 渲染导致整页白屏。详见 §2 红线7 / §9.11。

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
6. **回复风格分层，日语必须礼貌，别让「极简」污染日语。**（`server.js`）
   风格 = `REPLY_STYLE_CORE`（纯业务规则，任何语言都生效）+ **互斥语气层**：非日语用 `REPLY_STYLE_DEFAULT`（极简口语），日语用 `REPLY_STYLE_JA`（敬语 です・ます体、委婉请求、缓冲表达）。
   所有生成回复的 prompt 一律用 `replyStyleFor(replyLanguage, sampleText)` 拼装——**两套语气永不同时进 prompt**（否则"简洁"和"礼貌"会互相打架）。判定日语：`reply_language` 标日语，或样本文本含假名。改回复 prompt 时务必保持这个分层，别把语气写死进 CORE。
7. **绝不能因为我们的注入把 IG/Gmail 整页搞白屏。**
   IG/Gmail/Outlook 都是 React。内联翻译往 React 管理的 DOM 插节点，重渲染时会让 React 的 `removeChild/insertBefore` 抛 `NotFoundError` → 整棵树卸载 → 白屏。三层防御缺一不可：① 少扰动（`content.js` 的 MutationObserver 不观察 `characterData`）；② 插入前查 `isConnected` + 整段 try/catch，失败放弃这条而非连累整页；③ 兜底护栏 `react-guard.js`（§9.11）。**别删 react-guard，别恢复 characterData 观察。**

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
| `backups/<insid>.json` | 各人浏览器数据的云端备份（按 ins id） | 进度/提醒/待办/个人快捷/**红人档案(kolProfiles)**，`/api/backup` 读写，id 已清洗成安全文件名。前端 `BACKUP_KEYS` 决定备份哪些 key |

---

## 3b. 三套「话术/回复」系统别混（最容易搞混，团队也常问）

| | 话术库（= 团队库） | ⚡ 快捷回复 | 出厂话术脚本 |
|---|---|---|---|
| 存在哪 | 服务器 `knowledge-base.json`（线上） | 各人浏览器 `kolQuickReplies` | 仓库种子 `playbook.json` |
| 谁能改 | 管理员用「📥 上传话术」(Word) 批量增补 | 你自己，一条条加 | 跟代码走 |
| **喂不喂 AI** | **喂**（影响 `/api/reply` 等生成质量） | **不喂**，纯本地关键词匹配、打字秒出 | 喂 |
| 共享吗 | 团队共享 | **个人私有** | 所有人装上就带 |
| 前端入口 | 「📚 话术库」搜索（合并 `/api/playbook`+`/api/knowledge`） | 主路径搜索框 | 并进话术库一起搜 |

- **话术库前端会同时拉 `/api/playbook`（脚本）和 `/api/knowledge`（团队库 Word 落库）合并搜**——`knowledgeToPlaybook()` 把 `{scene, fields:{语言:文本}}` 归一成话术条目。以前团队库只有 AI 用得到、运营搜不到，就是因为只读了 playbook。
- 话术库每条有「⭐ 存进快捷」一键搬进个人快捷。**搬过去就脱离 AI**（个人私有），这是有意的。
- 「📥 团队库」按钮已更名「📥 上传话术」——团队库就是话术库，不是两个东西。

## 3c. 云端备份 + 设置收口（v0.24.7）

- **配置唯一入口 = 「⚙️ 服务器设置」**：服务地址 + 团队口令 + **你的 ins id** + **你负责的产品**。ins id 同时当提醒里「我自己的号」，产品同时当「我负责的产品」（保存时写进 `kolReminderSettings`，见 `syncReminderIdentity()`）。已删掉主框的产品选择条、提醒里重复的「身份设置」表单。没填 ins id/产品时顶部出橙色软提示横幅（不锁按钮）。
- **云端自动备份（按 ins id）**：进度/提醒/待办/个人快捷/红人档案（`BACKUP_KEYS`，含 `kolProfiles`）改动后防抖 2.5s 自动 POST 到 `/api/backup`，存 `~/kol-data/backups/<insid>.json`。换电脑/清缓存后填同一个 ins id → 启动静默恢复，或点「☁️ 从云端恢复」。恢复时对象按 key 合并、其余「本地为空才填」，不覆盖更新的本地数据。原「💾导出/📂导入文件」离线备份仍保留。

---

## 3d. 提醒引擎 + 红人档案（v0.25–0.26 大改，改这块前必读）

**提醒判定（`background.js` 的 `computeReminders` + `kol-reminder.js` 的 `scan`）三条并列、互不冲突，按"等最久"降序排：**
1. **已读不回**（打开过对话但没回）→ 满 **5 分钟**提醒一次。对方在线**不**提前（要给人留码字时间），在线只影响排序靠前 + 标签高亮。
2. **未读**（根本没点进去）→ 满 **1 小时**提醒一次。
3. **今日待办 + 对方在线** → 立即提醒（`dueAt` 是今天 + 该红人 `isOnline`）。待办关联红人靠 `t.threadId`，会话内"问档期/已约好"建的待办自带 threadId。
   - 计时锚点 `lastCreatorMessageAt`：红人发新消息就重置（避免"第3分钟又来一条却在第5分钟提醒"）。`replyReminderSent`/`unreadReminderSent` 防重复提醒；回写时有 `_refreshing` 再入守卫，别去掉。
   - **「已回复"不再提醒"判定**：①整段精读到的最后一条是我发的(`lastIsMine`)、或②我给红人最后一条点了表情(`reacted`)、或③有我在红人最后消息之后的回复(`myReplyAfter`)。**不要再用收件箱列表预览的 `lastFromMe` 去压制精读结果**——列表有延迟，红人刚发新消息时会误把真待回复也压掉（这是踩过的回归，见 §9.14）。列表那条的判断只在第 1 步(`myLastMsg`)里用。
   - **名字识别**：`pickInboxTitle()` + `isStatusLine()` 跳过"New messages/在线/active now/时间戳/便签"等徽标，取第一条像名字的文本。时间戳/时长正则**必须 `$` 锚定**，否则"5 min crafts""20:00 Club"这类含数字真名字会被当状态行丢掉。记账本 schema 升级（如 v4）做定点清理时只删脏的、别全清正常档案。
   - **头像**：采集每行头像 img 存进 `thread.avatarUrl`（`undefined` 别冲掉旧值），提醒卡片 + 桌面通知优先用真实头像，取不到才退回 `makeAvatarIconAsync` 首字母彩色圆。
   - **桌面通知用固定 ID `"kol-reminder"`**（覆盖旧的，别用 `Date.now()` 否则叠弹多条）。

**红人固定档案（`kolProfiles`，前端 `initKolProfile`）：** 按名字存 App User ID（Recco 充积分用）/ 合同信息（法定名称+邮箱+付款）/ 备注。
- **key 用 `profileKey()` 规范化**（trim+折叠空格+小写），`displayName` 另存展示名；"小美"/"小 美" 映射同一条。读取用 `lookupProfile()` 有兜底兼容旧 key。
- 打开档案卡自动匹配当前 IG 对话名（content.js 的 `KOL_GET_CONVERSATION_TITLE`）。**没有任何代码删 `kolProfiles`**；schema 清理删的是 `kolThreads`，两者无关。

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
2. **新增了前端文件** → 一定要把它加进 `build-store-zip.sh` 的 `FILES` 白名单，否则打出来的包会缺文件、插件加载报错（`docx-import.js`、`react-guard.js` 都差点这么漏掉）。当前白名单 17 个文件，含 `react-guard.js`。
3. `bash build-store-zip.sh` → 生成 `kol-assistant-v<版本>.zip`（zip 已 gitignore，不进库）。打包前确认 `manifest.json` **没有 `key` 字段**（§9.7）。
4. Chrome 开发者后台 →「软件包」→ 上传新 zip → 提交审核。审核过后**成员自动更新**（从商店装的话）；想快点让成员去 `chrome://extensions` 点「立即更新」或重启 Chrome。

### 后端（server.js / 数据）
- 改 `server.js`：VPS 上 `git pull origin main` + `sudo systemctl restart kol-assistant`（**不是手动 nohup**，见下方 systemd 说明）。成员无感、实时生效（含日语 prompt 这类纯后端改动）。
- 改话术/知识库：用插件「📥 上传话术」上传 Word，或直接改 VPS `~/kol-data/`。成员无感（实时取）。

#### VPS 实际目录和操作（2026-06 迁移后）
- **仓库位置**：`/home/ubuntu/kol-repo/`（注意：`bilingual-extension/` 子目录是旧结构残留，已空，别在那里操作）
- **⚠️ 服务由 systemd 托管，名字 `kol-assistant.service`（以 root 运行，会开机自启 + 崩溃自动拉起）。**
  **千万别再手动 `nohup node server.js`**——systemd 那个进程一直占着 3210，你手动起的会撞 `EADDRINUSE`，而且数据目录会跑偏。一切走 systemctl。
- **部署 / 更新代码（标准三步，记住这个）**：
  ```bash
  cd /home/ubuntu/kol-repo
  git pull origin main                  # 现在 main 是发布分支；SSH 已配，直接拉
  sudo systemctl restart kol-assistant  # systemd 重启，自动用配置的用户和数据目录
  curl -s localhost:3210/health         # 看到 ok:true 就成功
  ```
- **查状态**：`sudo systemctl status kol-assistant --no-pager`
- **看日志**：`sudo journalctl -u kol-assistant -n 50 --no-pager`（不是 `~/kol.log`，那是历史手动启动留下的）
- **服务配置**：`/etc/systemd/system/kol-assistant.service` + 覆盖目录 `kol-assistant.service.d/model.conf`（里面有 `DASHSCOPE_MODEL_SMART` 等环境变量）。改了配置要 `sudo systemctl daemon-reload` 再 restart。
- **排查端口被占 / 多个杂进程**：`sudo lsof -i :3210`；务必只留 systemd 那一个 node 进程。
- **git 用 SSH**（已配置，不用 token）：remote 是 `git@github.com:vickyldr/kol-extension.git`

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
kol-reminder.js        页面侧"搭便车"采集 + 提醒（名字/在线/头像识别、已回复判定）
react-guard.js         ⭐ 防白屏护栏：world=MAIN 注入，给 removeChild/insertBefore 加防御（§2 红线7）
background.js          service worker：判断代理、闹钟、提醒计算 computeReminders、通知头像
reminders.html/js      独立提醒清单弹窗（消息预览 + 合作进展 + 真实头像）
knowledge.js           内置场景库 + 语言识别 + 关键词匹配（前端兜底）
docx-import.js         ⭐ 团队库 Word 导入：浏览器端零依赖解析 .docx（解压+XML），拆表格成话术+抽图；单元格按段落保留换行
server.js              ⭐ 后端全部逻辑：AI 代理、话术/物料存取、/api/* 路由
data/*.json            出厂种子（见 §3）
build-store-zip.sh     打商店 zip（FILES 白名单！）
功能说明书.md           逐功能说明（实时维护，给人看）
团队使用说明-大白话.md   给非技术成员的使用说明
```

主要后端接口：`/api/reply` `/api/analyze` `/api/translate` `/api/rewrite` `/api/ask` `/api/judge` `/api/summary` `/api/parse-todo` `/api/assets` `/api/archive` `/api/playbook` `/api/knowledge`（GET：取团队库，供话术库前端合并搜索）`/api/knowledge/import`（团队库 Word 导入，仅管理员）`/api/backup`（GET 按 ins id 取 / POST 存：各人浏览器数据的云端备份）。

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
6. **VPS git pull 要在 `/home/ubuntu/kol-repo/` 下运行**，不是 `bilingual-extension/`（那个目录是旧结构残留，已空）。
7. **manifest.json 不能带 `key` 字段上传商店**，会报"key 字段值与当前内容不符"。`key` 只在本地开发时用，打商店包前确认已删除。
8. **VPS GitHub 认证用 SSH**（`~/.ssh/id_ed25519`），不用 token，`git remote` 地址必须是 `git@github.com:...` 格式，不能是 `https://` 格式。
9. **提醒「打开对话」要靠 threadId 深链**：IG 收件箱列表行这版**不一定是链接**，从列表扫出的提醒可能拿不到对话数字 ID，`threadId` 为空时「打开对话」只能退回收件箱首页（看着像打不开）。`kol-reminder.js` 的 `scanInbox()` 会尽量从行内 `<a href="/direct/t/xxx/">` 抓 ID；抓不到就退回首页。改提醒相关逻辑时注意保留这个兜底。
10. **VPS 后端是 systemd 服务 `kol-assistant`，不是手动 nohup！** 部署只用 `git pull origin main && sudo systemctl restart kol-assistant`。手动 `nohup node server.js` 会和 systemd 进程抢 3210 端口（`EADDRINUSE`）、还会用错数据目录。详见 §5。
11. **白屏（React 卸载）**：IG/Gmail 是 React，往它管理的 DOM 插节点会让 React `removeChild/insertBefore` 抛 `NotFoundError` 整页白屏。靠 `react-guard.js`（world=MAIN，document_start）兜底 + `content.js` 不观察 characterData + 插入前 `isConnected` 检查。**别删 react-guard、别恢复 characterData 观察、别把它从 build 白名单漏掉。** 见 §2 红线7。
12. **docx 导入换行**：Word 表格单元格里 1/2/3 分点是独立 `<w:p>` 段落。`collectCellText()` 按段落用 `\n` 连接、`cleanMultiline()` 保留换行（只压每行内空格）；表头/场景名才用单行 `clean()`。改导入逻辑别又把换行压扁。修复只对**之后的导入**生效，旧的压扁话术要重新「上传话术」一次（按 stable_id 幂等覆盖）。
13. **回复风格分层**：日语走礼貌敬语层、其他走极简层，靠 `replyStyleFor()` 二选一注入，别把语气写死进 `REPLY_STYLE_CORE`。见 §2 红线6。
14. **别用收件箱列表 `lastFromMe` 压精读的待回复判定**：列表预览有延迟，红人刚发新消息时会漏提醒。精读路径只信 `lastIsMine`/`reacted`/`myReplyAfter`。见 §3d。
15. **分支/发布**：开发在 `claude/sleepy-fermat-eqatjn`，**`main` 是发布 + VPS 部署分支**。合并到 main 走快进（push HEAD:main），VPS `git pull origin main`。前端发版改任何前端文件都要 `manifest.json` version +1。
