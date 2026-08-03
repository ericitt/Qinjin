# Windows 台式机部署指南

在办公室那台 Windows 台式机上把整套系统跑起来，局域网里大家用浏览器访问。

**为什么这么部署**：不走国际线路（不受墙影响）、不用 ICP 备案、没有月费，
数据库就在本机，延迟从 300ms 降到 1ms 以内。

---

## 一、装 Docker Desktop

1. 下载：https://www.docker.com/products/docker-desktop/ → Download for Windows
2. 双击安装，**勾选 "Use WSL 2 instead of Hyper-V"**（默认就是勾的）
3. 装完重启电脑
4. 打开 Docker Desktop，等左下角变成绿色的 "Engine running"

如果提示要装 WSL2，按提示走，或者以管理员身份打开 PowerShell 执行：

```powershell
wsl --install
```

装完再重启一次。

> **设置开机自启**：Docker Desktop → 右上角齿轮 → General → 勾上
> "Start Docker Desktop when you log in"。不勾的话电脑重启后系统就打不开了。

## 二、装 Git 并把代码拉下来

装 Git：https://git-scm.com/download/win （一路下一步）

装完，在开始菜单搜 **PowerShell** 打开，执行：

```powershell
cd C:\
git clone https://github.com/ericitt/Qinjin.git qijin
cd C:\qijin
```

## 三、配置

在 `C:\qijin` 里新建一个叫 `.env` 的文件（注意前面有个点，没有扩展名）。

用记事本建：PowerShell 里执行 `notepad .env`，问你要不要新建就选是。粘进去：

```
DB_PASSWORD=改成你自己的密码

DEEPSEEK_API_KEY=sk-你在platform.deepseek.com申请的密钥
AI_PROVIDER=deepseek

ACCESS_PASSWORD=改成访问密码（留空就是不设门禁）

SYNC_INTERVAL_MS=300000
```

保存关闭。

> 记事本可能会存成 `.env.txt`。保存时"保存类型"选**所有文件**，文件名写 `.env`。
> 存完在 PowerShell 里用 `dir` 确认文件名就是 `.env`。

## 四、启动

```powershell
cd C:\qijin
docker compose up -d --build
```

第一次要 5~10 分钟（下载镜像 + 构建）。完成后检查：

```powershell
docker compose ps
```

三个容器都应该是 running：`qijin-db`、`qijin-app`、`qijin-sync`。

看日志（排查问题用，Ctrl+C 退出）：

```powershell
docker compose logs -f app
```

## 五、把现有数据搬过来

数据现在还在 Supabase（云端），要导出来灌进本地。

**在你的 Mac 上**导出：

```bash
cd ~/Desktop/files/qijin-mvp
pg_dump "$(grep DATABASE_URL .env | cut -d= -f2-)" \
  --clean --if-exists --no-owner --no-privileges -f qijin-dump.sql
```

没有 `pg_dump` 就先 `brew install libpq && brew link --force libpq`。

把 `qijin-dump.sql` 拷到台式机的 `C:\qijin\` 下（U 盘/微信/网盘都行），然后在 PowerShell：

```powershell
cd C:\qijin
Get-Content qijin-dump.sql | docker compose exec -T db psql -U qijin -d qijin
```

核对：

```powershell
docker compose exec db psql -U qijin -d qijin -c "select (select count(*) from parts where merged_into is null) as 物料, (select count(*) from shipments) as 出货, (select count(*) from supplier_parts) as 报价, (select count(*) from customers) as 客户;"
```

应该是 **4789 / 5974 / 918 / 24**。对得上就搬完了。

## 六、大家怎么访问

先查这台机器的内网 IP：

```powershell
ipconfig | findstr IPv4
```

假设是 `192.168.1.50`，那么办公室任何人浏览器打开：

```
http://192.168.1.50:3000
```

**两件必做的事：**

1. **放行防火墙**（管理员身份打开 PowerShell）：
   ```powershell
   New-NetFirewallRule -DisplayName "勤进物料库" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
   ```

2. **固定 IP**：在路由器管理页面给这台机器绑定固定 IP，
   否则重启后地址变了，同事的书签就失效了。

## 七、自动同步 ERP 数据 ⭐

这是最省事的部分。`C:\qijin\data\inbox` 这个文件夹会被自动监控。

**用法：从龙威导出报表，把文件丢进这个文件夹，剩下的不用管。**

系统每 5 分钟扫一次，自动识别类型、清洗、入库，然后把文件归档。

**文件名要带关键词**，靠这个判断是哪类数据：

| 文件名里包含 | 识别为 | 说明 |
|---|---|---|
| 采购 / 进货 / 收货 | 供应商报价 | 每个(供应商,型号)取最近一次采购价 |
| 销售 / 出货 / 发货 | 出货流水 | 带客户和成本 |
| 供应商 | 供应商档案 | 联系方式 |
| 客户 | 客户档案 | |
| 库存 / 物料 / 型号明细 | 物料主数据 | 成本、销售价 |

比如 `销售记录表2026-08.xls`、`25年采购记录.xls` 都能自动识别。

处理完文件会被移走：

```
C:\qijin\data\inbox\
  ├─ 已导入\    成功的（带日期前缀）
  └─ 失败\      出错的，旁边有个 .错误.txt 写明原因
```

**重复导入是安全的。** 龙威导出的是全量累计表，同一份文件导十次也不会产生重复行——
出货记录按「日期+型号+数量+单价+客户」算了一个自然键，重复的会自动跳过，
日志里会显示「跳过重复 N 条」。所以你可以每周直接导整年的表，不用挑增量。

看同步日志：

```powershell
docker compose logs -f sync
```

## 八、备份（**别跳过**）

数据在本机了，硬盘坏了就全没了。

手动备份一次试试：

```powershell
docker compose exec -T db pg_dump -U qijin -d qijin | Out-File -Encoding utf8 backups\qijin-backup.sql
```

**设成每天自动**（任务计划程序）：

1. 开始菜单搜「任务计划程序」→ 创建基本任务
2. 名称：勤进数据库备份；触发器：每天，凌晨 2:30
3. 操作：启动程序
   - 程序：`powershell.exe`
   - 参数：`-Command "cd C:\qijin; docker compose exec -T db pg_dump -U qijin -d qijin | Out-File -Encoding utf8 backups\qijin-$(Get-Date -Format yyyyMMdd).sql"`
4. 完成

**重要**：备份和数据库在同一块硬盘上，那块盘坏了两个一起没。
定期把 `C:\qijin\backups\` 往 NAS 或网盘同步一份。

## 九、日常维护

**更新代码**：

```powershell
cd C:\qijin
git pull
docker compose up -d --build
# 如果这次更新带了新的数据库迁移（sql/migrations/ 里多了文件），再跑一次：
docker compose exec app node scripts/seed.js --migrate-only
```

数据在 Docker volume 里，重建容器不会丢。
迁移脚本是可以重复执行的（都用了 `IF NOT EXISTS`），跑多次没有副作用。

**重启**：`docker compose restart`
**停止**：`docker compose down`（数据不会丢）
**看状态**：`docker compose ps`

---

## 出问题怎么查

**页面打不开**
```powershell
docker compose ps          # 容器都起来了吗
docker compose logs app    # 应用报什么错
```
别的电脑打不开但本机可以 → 防火墙没放行，回到第六步。

**AI 询价报错**
```powershell
docker compose exec app node scripts/ai-test.js
```
它会直接告诉你是 Key 不对、余额不足还是网络不通。

**同步没反应**
```powershell
docker compose logs sync
```
文件还在「失败」文件夹里的话，旁边的 `.错误.txt` 写了原因。
最常见的是文件名里没有可识别的关键词。

**Docker Desktop 打不开 / WSL 报错**
多半是没开虚拟化。重启进 BIOS，找到 Intel VT-x 或 AMD-V，打开。

**电脑重启后系统访问不了**
Docker Desktop 没设开机自启，回到第一步的提示。
