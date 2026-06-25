#!/usr/bin/env bash
# KOL 双语沟通助手 —— 腾讯云轻量 / 任意 Ubuntu VPS 一键部署脚本
# 既支持「上传 zip」模式，也支持「git clone」模式（推荐，后续可一键更新）。
set -e

# 自动定位 server.js：脚本同级（zip 包）或上一级（git 仓库的 vps/ 子目录）。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/server.js" ]; then
  APP_DIR="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../server.js" ]; then
  APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  echo "❌ 没找到 server.js。请在包含 server.js 的目录、或其 vps/ 子目录里运行本脚本。"
  exit 1
fi
cd "$APP_DIR"

echo "== 1/4 检查 Node.js =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 18 ]; then
  echo "正在安装 Node.js 20（需要几分钟）..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node 版本：$(node -v)"

echo "== 2/4 填写配置 =="
read -rp "请粘贴阿里云百炼 API Key（sk- 开头）: " DASH_KEY
read -rp "请设置【团队口令】（每个同事插件里都填这个，建议 16 位以上随机字符）: " TOKEN
read -rp "请设置【管理员口令】（只有你自己填，用来编辑/删除话术，要和团队口令不同）: " ADMIN_TOKEN
PORT="${KOL_ASSISTANT_PORT:-3210}"

if [ -z "$DASH_KEY" ] || [ -z "$TOKEN" ]; then
  echo "❌ API Key 和团队口令都不能为空。"
  exit 1
fi

echo "== 3/4 准备数据目录 + 写入开机自启服务 =="
# 话术库、产品资料放在独立目录，更新代码不会覆盖它们。
DATA_DIR="$HOME/kol-data"
mkdir -p "$DATA_DIR"
# 首次部署时把内置默认资料拷过去；已存在则保留，绝不覆盖你的数据。
if [ ! -f "$DATA_DIR/products.json" ] && [ -f "$APP_DIR/data/products.json" ]; then
  cp "$APP_DIR/data/products.json" "$DATA_DIR/"
fi
if [ ! -f "$DATA_DIR/scenario-archive.json" ]; then
  if [ -f "$APP_DIR/data/scenario-archive.json" ]; then
    cp "$APP_DIR/data/scenario-archive.json" "$DATA_DIR/"
  else
    echo "[]" > "$DATA_DIR/scenario-archive.json"
  fi
fi

SERVICE=/etc/systemd/system/kol-assistant.service
sudo tee "$SERVICE" >/dev/null <<EOF
[Unit]
Description=KOL Bilingual Assistant
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=KOL_ASSISTANT_HOST=0.0.0.0
Environment=KOL_ASSISTANT_PORT=$PORT
Environment=DASHSCOPE_API_KEY=$DASH_KEY
Environment=KOL_ASSISTANT_TOKEN=$TOKEN
Environment=KOL_ASSISTANT_ADMIN_TOKEN=$ADMIN_TOKEN
Environment=KOL_DATA_DIR=$DATA_DIR
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo chmod 600 "$SERVICE"
sudo systemctl daemon-reload
sudo systemctl enable kol-assistant >/dev/null 2>&1 || true
sudo systemctl restart kol-assistant

# 顺手放行系统自带防火墙（如果开着）。注意：腾讯云控制台的「防火墙」要单独开！
sudo ufw allow "$PORT"/tcp >/dev/null 2>&1 || true

# 如果代码是 git 克隆来的，生成一键更新脚本：以后更新只跑 bash ~/kol-update.sh
REPO_DIR="$(git -C "$APP_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$REPO_DIR" ]; then
  cat > "$HOME/kol-update.sh" <<UPD
#!/usr/bin/env bash
cd "$REPO_DIR" || exit 1
echo "拉取最新代码..."
before=\$(git rev-parse HEAD)
git pull
after=\$(git rev-parse HEAD)
if [ "\$before" = "\$after" ]; then
  echo "已是最新，无需重启。"
else
  sudo systemctl restart kol-assistant
  echo "✅ 已更新并重启。"
fi
UPD
  chmod +x "$HOME/kol-update.sh"
fi

echo "== 4/4 自检 =="
sleep 2
if curl -s "http://127.0.0.1:$PORT/health" | grep -q '"ok":true'; then
  echo "✅ 服务已在本机启动并设为开机自启。"
else
  echo "⚠️ 暂时没自检成功，过几秒后可运行：curl http://127.0.0.1:$PORT/health"
  echo "   查看日志：sudo journalctl -u kol-assistant -n 50 --no-pager"
fi

IP="$(curl -s https://api.ipify.org || echo 你的公网IP)"
echo ""
echo "下一步："
echo "1) 去腾讯云控制台 → 轻量应用服务器 → 防火墙，放行 TCP $PORT 端口。"
echo "2) 浏览器打开 http://$IP:$PORT/health 能看到 JSON 就说明外网通了。"
echo "3) 同事在插件「⚙️ 服务器设置」里填：地址 http://$IP:$PORT ，口令 = 你刚设置的团队口令。"
echo ""
echo "常用命令："
echo "  重启服务： sudo systemctl restart kol-assistant"
echo "  看日志：   sudo journalctl -u kol-assistant -f"
if [ -n "$REPO_DIR" ]; then
  echo "  以后一键更新： bash ~/kol-update.sh"
else
  echo "  改 Key/口令后重新部署： 重新 bash setup.sh"
fi
