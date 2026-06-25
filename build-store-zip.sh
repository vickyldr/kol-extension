#!/usr/bin/env bash
# 打包 Chrome 商店上传用的 zip：只放插件本身需要的文件，
# 绝不包含后端 server.js、data/、部署脚本等（那些跑在 VPS 上）。
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -e "console.log(require('./manifest.json').version)")
OUT="kol-assistant-v${VERSION}.zip"
STAGE=".store-stage"

# 插件运行真正需要的文件（与 manifest 引用一致）
FILES=(
  manifest.json
  background.js
  content.js
  content.css
  kol-reminder.js
  kol-reminder.css
  sidepanel.html
  sidepanel.css
  sidepanel.js
  reminders.html
  reminders.js
  knowledge.js
  docx-import.js
  icon16.png
  icon48.png
  icon128.png
)

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"
for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then echo "缺文件: $f" >&2; exit 1; fi
  cp "$f" "$STAGE/"
done

( cd "$STAGE" && zip -qr "../$OUT" . )
rm -rf "$STAGE"
echo "已生成: $OUT"
unzip -l "$OUT"
