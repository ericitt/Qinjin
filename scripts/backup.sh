#!/bin/sh
# 数据库备份。自建之后这件事没人替你做了，务必配上定时任务。
#
# 手动跑：  sh scripts/backup.sh
# 每天自动：crontab -e 加一行
#   30 2 * * * cd /opt/qijin && sh scripts/backup.sh >> backups/backup.log 2>&1
#
# 备份文件放在 ./backups/，默认保留 30 天。
# 重要：备份别只存在这台机器上 —— 硬盘坏了备份跟着一起没。
# 定期往 NAS 或网盘同步一份。

set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/backups"
KEEP_DAYS=30
STAMP=$(date +%Y%m%d-%H%M%S)
FILE="$OUT/qijin-$STAMP.sql.gz"

mkdir -p "$OUT"

# 在 db 容器里执行 pg_dump，压缩后写到宿主机挂载的 backups 目录
docker compose exec -T db pg_dump -U qijin -d qijin --clean --if-exists | gzip > "$FILE"

SIZE=$(du -h "$FILE" | cut -f1)
echo "[$(date '+%F %T')] 备份完成 $FILE ($SIZE)"

# 太小说明多半失败了（正常应该有几百 KB）
BYTES=$(wc -c < "$FILE")
if [ "$BYTES" -lt 10000 ]; then
  echo "[$(date '+%F %T')] 警告：备份文件只有 $BYTES 字节，可能没成功，请检查！"
  exit 1
fi

# 清理过期备份
find "$OUT" -name 'qijin-*.sql.gz' -mtime +$KEEP_DAYS -delete 2>/dev/null || true
echo "[$(date '+%F %T')] 当前保留 $(ls -1 "$OUT"/qijin-*.sql.gz 2>/dev/null | wc -l) 份备份"
