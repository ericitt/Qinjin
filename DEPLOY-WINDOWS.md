# Windows 台式机部署（不用 Docker）

装两个软件，跑一个脚本，完事。全程约 30 分钟，其中大半是等下载。

**这套方案不需要梯子**：所有下载都走国内镜像，npm 走淘宝源。

---

## 第 1 步：装 Node.js

下载（国内镜像，速度快）：
**https://mirrors.huaweicloud.com/nodejs/v20.18.0/node-v20.18.0-x64.msi**

双击安装，**一路下一步保持默认**（默认就会加入 PATH）。

> 官网 nodejs.org 也可以，但国内慢。

## 第 2 步：装 PostgreSQL 17

下载：
**https://www.enterprisedb.com/downloads/postgres-postgresql-downloads**
选 **PostgreSQL 17** 的 Windows x86-64 版本。

安装时注意四点：

1. 组件全选（尤其 **Command Line Tools** 必须勾）
2. 会让你设一个 **postgres 超级用户密码** —— **记下来**，脚本要用
3. 端口保持默认 5432
4. **最后一步会问 `Launch Stack Builder at exit?`（退出时启动 Stack Builder）—— 把这个勾去掉**，
   直接点 Finish 结束。Stack Builder 是装额外插件用的，我们一个都不需要，
   而且它要连国外服务器下载，国内会卡住白等。
   （已经点进去了也没关系，直接关掉窗口，不影响已装好的 PostgreSQL）

装完**重启一次电脑**（让 PATH 生效）。

> 下载慢的话，也可以用国内镜像：
> https://mirrors.tuna.tsinghua.edu.cn/postgresql/binary/ （选 win-x64 的 zip 版，需手动配 PATH，麻烦一点）

## 第 3 步：放程序

把 Eric 给的 `qijin-mvp.zip` 解压，文件夹改名成 **qijin**，整个放到 **C 盘根目录**。

最终是 `C:\qijin\`，里面能看到 `package.json`、`scripts` 这些。

再把 Eric 给的 **qijin-dump.sql** 也复制进 `C:\qijin\`。

> 这个文件是现有的全部数据（物料、出货、客户、供应商、报价，约 2.7MB）。
> 新装的 PostgreSQL 是空的，第 4 步的脚本会读这个文件把数据灌进去。
> 放好后，`C:\qijin\` 里应该同时能看到 `package.json` 和 `qijin-dump.sql`。

## 第 4 步：跑一键脚本

在 `C:\qijin` 文件夹里，**按住 Shift 点右键** → 选「**在此处打开 PowerShell 窗口**」，粘贴这行回车：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
```

脚本会依次问你两件事：

- **数据库密码** —— 自己定一个，比如 `qijin2026db`
- **访问密码** —— 同事打开网页要输的，比如 `qijin888`（直接回车＝不设密码）

然后会提示输入 **postgres 超级用户密码**（第 2 步你设的那个）。

之后全自动：建库 → 导数据 → 装依赖 → 构建 → 设开机自启 → 放行防火墙 → 启动。
中间「正在构建」那步要 1-3 分钟，别关窗口。

跑完最后会显示：

```
===== 部署完成 =====
  同事访问：  http://192.168.1.50:3000
```

**这个地址就是给同事的。**

> 脚本可以重复运行，已完成的步骤会自动跳过。哪一步失败了，修好再跑一次即可。

---

## 日常使用：同步龙威数据

把龙威导出的报表丢进 **C:\qijin\data\inbox** 文件夹，系统每 5 分钟自动导入。

文件名要带关键词（靠这个判断数据类型）：

| 文件名包含 | 识别为 |
|---|---|
| 采购 / 进货 / 收货 | 供应商报价 |
| 销售 / 出货 / 发货 | 出货流水 |
| 供应商 | 供应商通讯录 |
| 客户 | 客户档案 |
| 库存 / 物料 / 型号明细 | 物料成本表 |

处理完自动归档到 `已导入\`；出错的进 `失败\`，旁边有 `.错误.txt` 写明原因。

**重复导入是安全的**，不会产生重复数据。所以每次直接导整年的表就行。

---

## 备份（别跳过）

数据在本机，硬盘坏了就全没了。

开始菜单搜「**任务计划程序**」→ 创建基本任务：

| 填写项 | 填什么 |
|---|---|
| 名称 | 勤进数据库备份 |
| 触发器 | 每天，凌晨 2:30 |
| 操作 | 启动程序 |
| 程序 | `powershell.exe` |
| 参数 | `-Command "$env:PGPASSWORD='你的数据库密码'; pg_dump -U qijin -d qijin -f C:\qijin\backups\qijin-$(Get-Date -Format yyyyMMdd).sql"` |

**定期把 `C:\qijin\backups\` 复制到 NAS 或网盘** —— 备份和数据库在同一块硬盘上，那块盘坏了两个一起没。

---

## 出问题怎么办

| 情况 | 处理 |
|---|---|
| 提示找不到 node 或 psql | 装的时候没勾加入 PATH，或者没重启电脑。重启后再试 |
| 建库失败 | postgres 超级用户密码输错了，重跑脚本 |
| 网页打不开 | 任务计划程序里看「勤进物料库-应用」是否在运行，右键手动「运行」 |
| 本机能开、别人打不开 | 防火墙。用**管理员身份**重跑一次脚本 |
| 电脑重启后打不开 | 任务是开机自启的，等 1 分钟。还不行就手动运行那两个任务 |
| 同步没反应 | 看 `data\inbox\失败\` 里的 `.错误.txt`；最常见是文件名没关键词 |

**看应用日志**：任务计划程序 →「勤进物料库-应用」→ 右键「运行」，或在 `C:\qijin` 里手动跑
`node node_modules\next\dist\bin\next start -p 3000` 看报错。

---

## 更新程序

Eric 给你新版本时：

```powershell
cd C:\qijin
npm install --no-audit --no-fund
npm run build
schtasks /End /TN "勤进物料库-应用"
schtasks /Run /TN "勤进物料库-应用"
```

数据不会丢。

---

## 关于 AI 询价

这个功能暂时用不了（需要单独申请 DeepSeek 密钥）。其他所有功能——查物料、看成交价、客户分析、供应商比价、数据导入——都正常。等以后要用了再找 Eric 要密钥。
