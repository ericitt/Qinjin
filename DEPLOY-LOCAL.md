# 局域网自建部署指南

把整套系统跑在办公室自己的机器上：**不受墙影响、不用备案、没有月费、延迟从 300ms 降到 1ms 以内。**

代价是三件事，先说清楚再动手：

1. **AI 询价要换成 DeepSeek** —— Claude 的接口在大陆连不上（这一步已经写好了，配个 Key 就行）
2. **出了办公室访问不了** —— 按你的选择，暂时不做内网穿透
3. **备份得自己管** —— 云端硬盘坏了是别人的事，自建就是你的事

---

## 一、准备一台机器

不用讲究，这个负载很轻（2-3 人用、两万行数据）：

- 迷你主机（零刻、极摩客之类）¥800~1500，装 Ubuntu Server
- 已有群晖 NAS 的话，直接用它的 Docker 套件，不用另买
- 先拿一台闲置台式机验证也完全可以

要求：能装 Docker，接在办公室路由器上，**设成固定内网 IP**（不然重启后地址变了大家都找不到）。

装 Docker（Ubuntu）：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER    # 之后重新登录一次
```

## 二、把代码放上去

```bash
git clone https://github.com/ericitt/Qinjin.git /opt/qijin
cd /opt/qijin
```

## 三、配置

在 `/opt/qijin` 下建一个 `.env`：

```bash
# 数据库密码，自己随便定一个，这台机器不对外就够了
DB_PASSWORD=换成你自己的密码

# DeepSeek：platform.deepseek.com 注册（手机号实名）→ API keys 创建 → 支付宝充值
# 先充 ¥20 能用很久（约 ¥0.002/千token）
DEEPSEEK_API_KEY=sk-你申请到的真实密钥
AI_PROVIDER=deepseek

# 访问密码，留空就是不设门禁（内网自用可以不设）
ACCESS_PASSWORD=
```

**先验证 AI 通不通**，别等用起来才发现：

```bash
npm install          # 只是为了跑这个测试脚本
npm run ai:test
```

看到「AI 询价助手可以正常使用」再往下走。报错的话它会直接告诉你是 Key 不对、余额不足还是连不上。

## 四、启动

```bash
docker compose up -d --build
```

第一次要几分钟（拉镜像 + 构建）。完成后：

```bash
docker compose ps        # 两个容器都应该是 running/healthy
docker compose logs -f app
```

## 五、把数据搬过来

现在数据库是空的，要从 Supabase 导出再导入。**在你的 Mac 上**执行导出（需要 `.env` 里的 `DATABASE_URL`）：

```bash
cd ~/Desktop/files/qijin-mvp
pg_dump "$(grep DATABASE_URL .env | cut -d= -f2-)" --clean --if-exists --no-owner --no-privileges -f qijin-dump.sql
```

没装 `pg_dump` 的话：`brew install libpq && brew link --force libpq`

把 `qijin-dump.sql` 拷到那台机器上（U 盘、scp 都行），然后：

```bash
cd /opt/qijin
docker compose exec -T db psql -U qijin -d qijin < qijin-dump.sql
```

核对一下：

```bash
docker compose exec db psql -U qijin -d qijin -c \
  "select (select count(*) from parts where merged_into is null) 物料,
          (select count(*) from shipments) 出货,
          (select count(*) from supplier_parts) 报价,
          (select count(*) from customers) 客户;"
```

对得上就说明搬完了（当前应该是 4789 / 5974 / 918 / 24）。

## 六、大家怎么访问

浏览器打开 `http://<这台机器的内网IP>:3000`，比如 `http://192.168.1.50:3000`。

建议在路由器上给这台机器绑定固定 IP，再让同事把地址存成书签。
讲究一点可以在路由器加条本地 DNS，让 `http://wuliao.local:3000` 这种也能用。

## 七、备份（**别跳过这一步**）

```bash
sh scripts/backup.sh                    # 先手动跑一次确认能用
crontab -e
# 加这一行：每天凌晨 2:30 自动备份
30 2 * * * cd /opt/qijin && sh scripts/backup.sh >> backups/backup.log 2>&1
```

备份在 `/opt/qijin/backups/`，保留 30 天。
**记得定期往 NAS 或网盘同步一份** —— 备份和数据库在同一块硬盘上，那块盘坏了两个一起没。

恢复：

```bash
gunzip -c backups/qijin-20260803-023000.sql.gz | docker compose exec -T db psql -U qijin -d qijin
```

## 八、以后怎么更新

```bash
cd /opt/qijin
git pull
docker compose up -d --build
```

数据在 volume 里，重建容器不会丢。

---

## 常见问题

**打不开页面**：先 `docker compose ps` 看容器状态，再 `docker compose logs app` 看报错。
局域网别的机器连不上的话，多半是防火墙：`sudo ufw allow 3000/tcp`。

**AI 报错**：`npm run ai:test` 单独测，能区分是 Key、余额还是网络的问题。

**数据库连不上**：`docker compose logs db`。注意 compose 里数据库端口只绑了 `127.0.0.1`，
局域网其他机器连不到数据库是**故意的**，应用通过容器网络访问它。

**机器重启后**：`restart: unless-stopped` 会自动拉起来，不用管。
