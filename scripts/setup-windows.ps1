# 勤进物料库 · Windows 一键部署（不用 Docker）
# 用法：在项目文件夹里右键「使用 PowerShell 运行」，或者：
#   powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
#
# 前置：先装好 Node.js 20+ 和 PostgreSQL 17，两个都要勾「加入 PATH」。
# 这个脚本会：建数据库 → 导入数据 → 装依赖 → 构建 → 设开机自启 → 放行防火墙。
# 可以重复运行，已经做过的步骤会自动跳过。

# 注意：这里不能用 'Stop'。
# PowerShell 5.1 会把外部程序（psql/npm）写到 stderr 的任何内容当成终止性错误，
# 而 psql 探测空库时输出「关系 shipments 不存在」是预期行为，用 Stop 会直接崩掉。
# 所以统一用 Continue，靠下面每一步显式检查 $LASTEXITCODE 来判断成败。
$ErrorActionPreference = 'Continue'
$ROOT = Split-Path -Parent $PSScriptRoot
Set-Location $ROOT

function Say($m)  { Write-Host "  $m" -ForegroundColor Gray }
function OK($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!] $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "`n  [X] $m`n" -ForegroundColor Red; Read-Host "按回车退出"; exit 1 }
function Step($n, $t) { Write-Host "`n[$n] $t" -ForegroundColor Cyan }

$SCRIPT_VERSION = 'v4 (2026-08-20)'
Write-Host "`n===== 勤进物料库 Windows 部署  $SCRIPT_VERSION =====" -ForegroundColor White

# 注册开机任务和放行防火墙都需要管理员权限，先检查，别跑到一半才失败
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host ""
  Write-Host "  需要管理员权限（要注册开机自启任务、放行防火墙）" -ForegroundColor Yellow
  Write-Host "  正在尝试以管理员身份重新启动…" -ForegroundColor Yellow
  try {
    Start-Process powershell -Verb RunAs -ArgumentList @(
      '-ExecutionPolicy','Bypass','-NoExit','-File',"`"$PSCommandPath`"") | Out-Null
    exit 0
  } catch {
    Die "无法自动提权。请在开始菜单搜索 PowerShell，右键『以管理员身份运行』，然后执行：`n      cd $ROOT`n      powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1"
  }
}

# ---------- 1. 检查环境 ----------
Step 1 "检查 Node.js 和 PostgreSQL"
try { $nv = (node -v) } catch { Die "找不到 Node.js。请先安装 Node.js 20 或更高版本，安装时勾选『Add to PATH』，然后重开 PowerShell 再运行本脚本。" }
if ([int](($nv -replace '^v(\d+)\..*$','$1')) -lt 18) { Die "Node.js 版本太低（$nv），需要 20 以上。" }
OK "Node.js $nv"

# PostgreSQL 的安装程序默认不把 bin 加进 PATH，所以自己找一遍
function Find-Psql {
  try { $null = Get-Command psql -ErrorAction Stop; return $true } catch {}
  $cands = @()
  foreach ($base in @("$env:ProgramFiles\PostgreSQL", "${env:ProgramFiles(x86)}\PostgreSQL", "C:\PostgreSQL")) {
    if (Test-Path $base) {
      Get-ChildItem $base -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [int]($_.Name -replace '\D','0') } -Descending |
        ForEach-Object { $cands += (Join-Path $_.FullName 'bin') }
    }
  }
  foreach ($c in $cands) {
    if (Test-Path (Join-Path $c 'psql.exe')) {
      $env:Path = "$c;$env:Path"
      # 顺便写进系统 PATH，下次开窗口就不用再找
      try {
        $sys = [Environment]::GetEnvironmentVariable('Path','Machine')
        if ($sys -notlike "*$c*") {
          [Environment]::SetEnvironmentVariable('Path', "$sys;$c", 'Machine')
          Say "已把 $c 加入系统 PATH"
        }
      } catch { Say "（无法写入系统 PATH，本次运行仍可继续）" }
      return $true
    }
  }
  return $false
}

if (-not (Find-Psql)) {
  Die "找不到 psql。请确认已安装 PostgreSQL（安装时组件里要勾选 Command Line Tools）。`n      如果确实装了，请把它的 bin 目录（通常是 C:\Program Files\PostgreSQL\17\bin）手动加入系统 PATH 后重开 PowerShell。"
}
$pv = (psql --version)
OK "$pv"

# ---------- 2. 读取/创建 .env ----------
Step 2 "配置"
$envFile = Join-Path $ROOT '.env'
if (Test-Path $envFile) {
  OK ".env 已存在，沿用现有配置"
  $cfg = @{}
  Get-Content $envFile | Where-Object { $_ -match '^\s*[^#].*=' } | ForEach-Object {
    $k,$v = $_ -split '=',2; $cfg[$k.Trim()] = $v.Trim()
  }
  $dbPass = $cfg['DB_PASSWORD']
} else {
  Say "第一次运行，需要设置两个密码"
  $dbPass = Read-Host "  请设置『数据库密码』(自己定一个，字母数字，例如 qijin2026db)"
  if (-not $dbPass) { Die "数据库密码不能为空" }
  $accPass = Read-Host "  请设置『访问密码』(同事打开网页要输的；直接回车表示不设门禁)"
  @(
    "DB_PASSWORD=$dbPass",
    "DATABASE_URL=postgres://qijin:$dbPass@localhost:5432/qijin",
    "ACCESS_PASSWORD=$accPass",
    "SYNC_INBOX=$ROOT\data\inbox",
    "SYNC_APP_URL=http://localhost:3000",
    "SYNC_INTERVAL_MS=300000"
  ) | Set-Content -Path $envFile -Encoding UTF8
  OK ".env 已生成"
}

# ---------- 3. 建数据库 ----------
Step 3 "创建数据库"
Say "接下来会提示输入 postgres 超级用户密码（安装 PostgreSQL 时你设的那个）"
$env:PGCLIENTENCODING = 'UTF8'
$exists = (& psql -U postgres -t -A -c "SELECT 1 FROM pg_database WHERE datname='qijin'" 2>&1 |
            Where-Object { $_ -match '^\s*1\s*$' } | Select-Object -First 1)
if ($exists -eq '1') {
  OK "数据库 qijin 已存在，跳过"
} else {
  $sql = @"
DO `$`$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='qijin') THEN
    CREATE ROLE qijin LOGIN PASSWORD '$dbPass';
  END IF;
END `$`$;
"@
  $sql | psql -U postgres -v ON_ERROR_STOP=1 -q
  psql -U postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE qijin OWNER qijin ENCODING 'UTF8' TEMPLATE template0;"
  if ($LASTEXITCODE -ne 0) { Die "建库失败，请检查 postgres 密码是否输对" }
  OK "数据库 qijin 已创建"
}

# ---------- 4. 导入数据 ----------
Step 4 "导入数据"
# 先把密码放进环境变量，否则后面每条 psql 命令都会弹一次「用户 qijin 的口令」
$env:PGPASSWORD = $dbPass
$dump = Join-Path $ROOT 'qijin-dump.sql'
$rows = (& psql -U qijin -d qijin -t -A -c "SELECT count(*) FROM shipments" 2>&1 |
           Where-Object { $_ -match '^\s*\d+\s*$' } | Select-Object -First 1)
if ($rows -and [int]$rows -gt 0) {
  OK "库里已有 $rows 条出货记录，跳过导入"
} elseif (Test-Path $dump) {
  Say "正在导入 qijin-dump.sql，请稍候…"
  $env:PGPASSWORD = $dbPass
  psql -U qijin -d qijin -q -f $dump 2>&1 | Select-String -Pattern 'ERROR' | Select-Object -First 5
  $rows = (& psql -U qijin -d qijin -t -A -c "SELECT count(*) FROM shipments" 2>&1 |
           Where-Object { $_ -match '^\s*\d+\s*$' } | Select-Object -First 1)
  if ($rows -and [int]$rows -gt 0) { OK "导入完成，出货记录 $rows 条" }
  else { Die "导入后查不到数据，请把上面的报错发给 Eric" }
} else {
  Warn "没找到 qijin-dump.sql，跳过导入（可以稍后把文件放到项目根目录再运行一次本脚本）"
}

# ---------- 5. 装依赖并构建 ----------
Step 5 "安装依赖并构建"
Say "使用国内 npm 镜像加速"
npm config set registry https://registry.npmmirror.com | Out-Null
if (-not (Test-Path (Join-Path $ROOT 'node_modules'))) {
  npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Die "npm install 失败，请检查网络" }
}
OK "依赖就绪"
Say "正在构建，大约 1-3 分钟…"
npm run build
if ($LASTEXITCODE -ne 0) { Die "构建失败，请把上面的报错发给 Eric" }
OK "构建完成"

# ---------- 6. 开机自启 ----------
Step 6 "设置开机自动启动"
$nodeExe = (Get-Command node).Source
$tasks = @(
  @{ Name='勤进物料库-应用'; Args="node_modules\next\dist\bin\next start -p 3000" },
  @{ Name='勤进物料库-数据同步'; Args="scripts\watch-import.js" }
)
foreach ($t in $tasks) {
  schtasks /Query /TN $t.Name *>$null
  if ($LASTEXITCODE -eq 0) { schtasks /Delete /TN $t.Name /F *>$null }
  $a = New-ScheduledTaskAction -Execute $nodeExe -Argument $t.Args -WorkingDirectory $ROOT
  $g = New-ScheduledTaskTrigger -AtStartup
  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $t.Name -Action $a -Trigger $g -Settings $s -RunLevel Highest -User "SYSTEM" | Out-Null
  OK "已注册：$($t.Name)"
}

# ---------- 7. 防火墙 ----------
Step 7 "放行防火墙端口 3000"
if (Get-NetFirewallRule -DisplayName "勤进物料库" -ErrorAction SilentlyContinue) {
  OK "防火墙规则已存在"
} else {
  try {
    New-NetFirewallRule -DisplayName "勤进物料库" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow | Out-Null
    OK "已放行"
  } catch { Warn "放行失败，请用『管理员身份』重新运行本脚本" }
}

# ---------- 8. 启动 ----------
Step 8 "启动服务"
foreach ($t in $tasks) { schtasks /Run /TN $t.Name *>$null }
Start-Sleep -Seconds 8
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3000/login" -UseBasicParsing -TimeoutSec 15
  OK "服务已启动（HTTP $($r.StatusCode)）"
} catch {
  Warn "暂时访问不到，可能还在启动。等半分钟后浏览器打开 http://localhost:3000 试试"
}

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
Write-Host "`n===== 部署完成 =====" -ForegroundColor Green
Write-Host "  本机访问：  http://localhost:3000"
Write-Host "  同事访问：  http://${ip}:3000" -ForegroundColor White
Write-Host "  同步文件夹：$ROOT\data\inbox"
Write-Host "`n  请把这个地址和访问密码发给同事。建议让网管把本机 IP 固定住。`n"
Read-Host "按回车关闭"
