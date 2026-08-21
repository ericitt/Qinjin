# 数据库备份（Windows）
#
# 手动跑：  powershell -ExecutionPolicy Bypass -File scripts\backup-windows.ps1
# 每天自动：任务计划程序里新建任务，程序填 powershell.exe，参数填
#   -ExecutionPolicy Bypass -File C:\qijin\scripts\backup-windows.ps1
#
# 备份写到 backups\，默认保留 30 天。
# 重要：备份别只存在这台机器上 —— 硬盘坏了备份跟着一起没。定期往 NAS 或网盘拷一份。

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$Root = Split-Path -Parent $PSScriptRoot
$Out  = Join-Path $Root 'backups'
$Keep = 30
New-Item -ItemType Directory -Force -Path $Out | Out-Null

# 从 .env 里读数据库连接串，不用把密码写死在脚本里
$envFile = Join-Path $Root '.env'
if (-not (Test-Path $envFile)) { Write-Host "找不到 .env"; exit 1 }
$line = (Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1)
if (-not $line) { Write-Host ".env 里没有 DATABASE_URL"; exit 1 }
$url = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'")

# postgresql://用户:密码@主机:端口/库名
if ($url -notmatch '^postgres(ql)?://([^:]+):([^@]+)@([^:/]+):(\d+)/([^?]+)') {
  Write-Host "DATABASE_URL 格式看不懂：$url"; exit 1
}
$dbUser = $Matches[2]; $dbPass = $Matches[3]
$dbHost = $Matches[4]; $dbPort = $Matches[5]; $dbName = $Matches[6]

# pg_dump 不一定在 PATH 里（EDB 安装包默认不加）
$pgDump = 'pg_dump'
if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  $found = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue |
           Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $found) { Write-Host "找不到 pg_dump.exe，请确认 PostgreSQL 已安装"; exit 1 }
  $pgDump = $found.FullName
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$file  = Join-Path $Out "qijin-$stamp.sql"

$env:PGPASSWORD = $dbPass
& $pgDump -h $dbHost -p $dbPort -U $dbUser -d $dbName --clean --if-exists -f $file
$code = $LASTEXITCODE
$env:PGPASSWORD = ''

if ($code -ne 0) { Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 备份失败，pg_dump 返回 $code"; exit 1 }

$size = [math]::Round((Get-Item $file).Length / 1MB, 2)
Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 备份完成 $file ($size MB)"

# 清理超过保留期的旧备份
Get-ChildItem $Out -Filter 'qijin-*.sql' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$Keep) } |
  ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "已删除过期备份 $($_.Name)" }
