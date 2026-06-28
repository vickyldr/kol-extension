# KOL 双语沟通助手

给中国 KOL 运营团队用的 **Chrome 扩展（Manifest V3）+ 零依赖 Node 后端**：帮运营看懂红人外语消息、匹配团队话术、生成双语回复，并提醒待回复 / 待跟进的红人。优先用于 Instagram 网页版，也支持 Gmail 与 Outlook 网页版。

AI 用阿里云百炼 / 千问（qwen-flash）。API Key 只在团队后端，**不进插件**。当前版本 **0.29.2**。

> 接手改代码前请先读 **[`CLAUDE.md`](CLAUDE.md)**（核心红线、数据边界、发布流程、踩过的坑）；逐功能说明见 **[`功能说明书.md`](功能说明书.md)**。

---

## 它能干嘛

打开一个红人对话后，侧边栏回复页是**自上而下一条线**，固定 7 块：

1. **🗂️ 红人档案（折叠）** —— 按名字固定保存 App User ID、合同信息、备注；打开对话自动匹配当前 IG 对话名。
2. **🧠 AI 理解** —— 打开对话自动跑 `/api/analyze`，输出「当前阶段 / 建议下一步 / 发送前风险」。有缓存先显示，消息签名变了才重算（省 token）。
3. **⚡ 快捷回复** —— 个人私有、纯本地关键词匹配、打字秒出（不喂 AI）。
4. **红人原文** —— 配「这是什么意思」「这怎么办」两个动作。
5. **我想回复（中文）** —— 配「忠实翻译」「润色生成」：可写完整回复让 AI 忠实翻译，也可只写大概意图让 AI 生成并润色双语终稿。
6. **✅ 双语回复（A · 可发）** —— 自动逐句对齐外语与中文对照，确认无误即可发送。
7. **✍️ AI 改写** —— 对双语回复继续微调。

此外：

- **私信内联翻译**：IG 私信里的外语消息会自动在原消息下方显示中文翻译，忠实直译、不做业务推测。
- **提醒 / 待办（独立窗口）**：开浏览器自动弹的三桶清单 —— 🔴 立即回复 / 🟠 今天跟进 / 📅 以后，外加 **📤 该催对方**（我方已发、红人不回时逐级升级跟进：二次跟进 → 再跟进 → 最后通牒 → 建议终止）。每条卡片配一行中文总结（运营看不懂外语，不贴原文）。
- **话术库**：合并团队库（`/api/knowledge`，管理员用「📥 上传话术」批量导入 Word）与出厂话术脚本（`/api/playbook`）一起搜，可一键搬进个人快捷。
- **物料库**：图片 / 链接 / 备注存取。
- **云端备份**：各人浏览器里的进度 / 提醒 / 待办 / 个人快捷 / 红人档案，按 ins id 自动备份到后端，换电脑填同一个 ins id 即可恢复。
- 没连上 AI 服务时自动降级到离线话术兜底，不报错。

支持 **9 个产品资料包**：`generic`（通用兜底）/ `recco` / `rythmix` / `aicatch` / `vivavideo` / `wisemeal` / `vivacut` / `rymo` / `inspo`。

---

## 架构：三块

| 块 | 是什么 | 跑在哪 | 关键文件 |
|---|---|---|---|
| **① Chrome 插件（前端）** | 装在每个运营浏览器里的界面 | 每个人的浏览器 | `manifest.json` `sidepanel.*` `content.js` `kol-reminder.js` `reminders.*` `background.js` `react-guard.js` `knowledge.js` `docx-import.js` |
| **② Node 后端（server）** | 调 AI、存/取话术与物料的「大脑」 | 团队的 VPS（单人也可本机） | `server.js`（纯 Node，零 npm 依赖） |
| **③ 数据** | 话术 / 知识库 / 物料 / 产品资料 | 见下方「数据边界」 | `data/*.json` `data/assets/` |

插件通过 HTTP 调后端（`sidepanel.js` 里 `API_BASE`，可在「⚙️ 服务器设置」改）。后端由 **systemd 服务 `kol-assistant`（端口 3210）** 托管，开机自启、崩溃自动拉起。`react-guard.js` 在页面主世界（`world:"MAIN"`）最早注入，防止内联翻译节点打断 IG/Gmail 的 React 渲染导致整页白屏。架构与红线详见 `CLAUDE.md` §1 / §2。

> 另有 **红人资源库 + 进度看板**（`apps/roster/`，独立 `kol-roster` 服务，端口 3220）：一个只读管理端网页，读插件的云备份汇总团队进度。设计见 [`apps/roster/设计.md`](apps/roster/设计.md)。

---

## 安装（团队成员）

插件**从 Chrome 网上应用店安装**，安装后随商店自动更新 —— 普通成员不用碰任何脚本、不用配 Key。

首次使用打开侧边栏的「⚙️ 服务器设置」，填三样：

1. **服务地址**（团队后端，默认指向团队 VPS）
2. **团队口令**（如后端设了 `KOL_ASSISTANT_TOKEN`）
3. **你的 ins id** 和 **你负责的产品**（ins id 同时是提醒里「我自己的号」与云备份的 key）

---

## 发布

### 插件（前端）

1. 改了任何前端文件 → `manifest.json` 的 `version` **必须 +1**（商店要求版本号递增）；新增前端文件要登记进 `build-store-zip.sh` 的 `FILES` 白名单。
2. `bash build-store-zip.sh` → 生成 `kol-assistant-v<版本>.zip`（**不含** `server.js` 和 `data/`）。
3. Chrome 开发者后台上传新 zip 提交审核，通过后成员自动更新。

### 后端（server.js / 数据）

在 VPS 上：

```bash
cd /home/ubuntu/kol-repo
git pull origin main
sudo systemctl restart kol-assistant
curl -s localhost:3210/health      # 看到 ok:true 即成功
```

成员无感、实时生效。改话术 / 知识库可直接用插件「📥 上传话术」上传 Word，或改 VPS 上 `~/kol-data/`。

### 本地自测

```bash
node --check server.js && node --check sidepanel.js
KOL_DATA_DIR=/tmp/kol-test KOL_ASSISTANT_PORT=3399 node server.js
curl -s localhost:3399/health
```

---

## 数据边界与红线

**数据三层**：出厂种子 `data/*.json`（跟代码走，**在 git**）；线上运行数据在 VPS `~/kol-data/`（团队日常增改，**不在 git**）；各人进度 / 提醒 / 档案在浏览器 `chrome.storage.local`，按 ins id 云备份到 `~/kol-data/backups/<insid>.json`。读取时种子可被同名线上文件覆盖，**写入永远写线上目录，绝不回写代码种子**。

**核心红线**（改代码不能破坏，详见 `CLAUDE.md` §2）：

- **A / B 严格隔离**：A = 可直接发给红人的自然话术；B = 只给运营看的内部建议（问 TL、预算、操作步骤、风险）。B 绝不混进 A。
- **AI 不编造商务事实**：金额 / 报价、授权期限、付款承诺、视频时长、平台数量、账号、下载链接，没确认就不能由 AI 填。
- **翻译忠实**，不改红人原语言。
- **回复风格分层**：日语用敬语层，其他语言用极简层（`replyStyleFor()` 二选一注入）。
- **绝不因注入把 IG/Gmail 整页搞白屏**（`react-guard.js` 兜底，别删）。

---

更多细节：接手须知看 **[`CLAUDE.md`](CLAUDE.md)**，逐功能说明看 **[`功能说明书.md`](功能说明书.md)**，给非技术成员的使用说明看 **[`使用指南.md`](使用指南.md)**。
