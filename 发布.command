#!/bin/bash
# 勤进物料库 · 一键发布（Mac 上双击运行）
#
# 做四件事：
#   1. 静态检查     —— 抓已知的几类低级错误
#   2. 编译         —— 编不过就不该发出去
#   3. 提交并推送   —— 存一份到 GitHub
#   4. 打包 zip     —— 生成给服务器用的更新包，放到桌面
#
# 任何一步失败都会停下并把原因显示出来，不会带着半截状态继续。

cd "$(dirname "$0")" || exit 1
set -o pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; CYN=$'\033[36m'; OFF=$'\033[0m'
step() { echo ""; echo "${CYN}[$1] $2${OFF}"; }
die()  { echo ""; echo "${RED}✗ $1${OFF}"; echo ""; read -r -p "按回车关闭"; exit 1; }

echo "项目目录：$(pwd)"

step 1 "静态检查"
npm run check || die "静态检查没过，看上面的 ✗ 行"

step 2 "编译（1~3 分钟）"
npm run build || die "编译失败。把上面的报错发给 Claude"

step 3 "提交并推送到 GitHub"
if [ -z "$(git status --porcelain)" ]; then
  echo "   没有改动，跳过提交"
else
  git add -A || die "git add 失败"
  MSG="${1:-更新 $(date '+%Y-%m-%d %H:%M')}"
  git commit -q -m "$MSG" || die "git commit 失败"
  echo "   已提交：$MSG"
fi
if git remote | grep -q .; then
  git push -q || echo "   ${RED}推送失败（不影响下面打包，网络好了再跑一次就行）${OFF}"
  echo "   已推送"
else
  echo "   没有配置远程仓库，跳过推送"
fi

step 4 "打包给服务器的更新包"
OUT="$HOME/Desktop/qijin-mvp.zip"
rm -f "$OUT"
zip -qr "$OUT" . \
  -x 'node_modules/*' '.next/*' '.git/*' 'data/*' 'backups/*' \
     '*.xls' '*.xlsx' '*.csv' '.env' '发布.command' \
  || die "打包失败"

SIZE=$(du -h "$OUT" | cut -f1)
echo ""
echo "${GRN}✓ 全部完成${OFF}"
echo ""
echo "更新包：$OUT  ($SIZE)"
echo ""
echo "接下来：把这个 zip 和「更新勤进程序.ps1」一起发到微信文件传输助手，"
echo "在服务器上下载到同一个文件夹，然后以管理员身份运行 PowerShell："
echo ""
echo "  powershell -ExecutionPolicy Bypass -File \"C:\\Users\\llz20\\Desktop\\更新勤进程序.ps1\""
echo ""
read -r -p "按回车关闭"
