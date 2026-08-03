# 部署指南（Supabase + Vercel 版，全程免费、不需要服务器）

比之前的阿里云方案简单很多：不用买服务器、不用装Docker、不用管Nginx，全部交给两个托管平台。大概15分钟能上线。

## 你需要准备的

1. 一个 [Supabase](https://supabase.com) 账号（免费额度：500MB数据库，够这个项目用很久）
2. 一个 [Vercel](https://vercel.com) 账号（免费额度对这种内部小工具完全够用）
3. 一个 GitHub 账号（Vercel 从 GitHub 仓库自动部署）
4. 一个 Anthropic API Key（[console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key）

---

## 第一步：建 Supabase 项目 + 导入数据

1. 打开 [supabase.com](https://supabase.com) → New Project，随便起个名字（比如 `qijin-mvp`），选一个离你近的区域（新加坡或者香港，国内访问快一些），设置数据库密码（记住它）
2. 建好之后，进项目 → **Settings → Database → Connection string**，选 **"Transaction" 模式**（不是 Session，也不是 Direct），复制那串 `postgresql://postgres.xxxxx:...@...pooler.supabase.com:6543/postgres`，把里面的 `[YOUR-PASSWORD]` 换成你刚才设的密码
3. 在你自己电脑上（不是服务器）：

```bash
cd qijin-mvp
npm install
cp .env.example .env
# 编辑 .env，把 DATABASE_URL 填成上一步复制的连接串，ANTHROPIC_API_KEY 填你的密钥
npm run seed
```

看到"全部完成"说明 5327个型号、5974条出货记录、142条BOM明细、227家供应商统计都导进 Supabase 了。你可以打开 Supabase 网页后台的 **Table Editor** 亲眼看一眼数据在不在。

---

## 第二步：把代码传到 GitHub

```bash
cd qijin-mvp
git init
git add .
git commit -m "MVP初版"
```

去 GitHub 建一个新仓库（可以设成 Private，毕竟是公司内部数据相关的代码），然后：

```bash
git remote add origin https://github.com/你的用户名/qijin-mvp.git
git push -u origin main
```

> `.env` 文件本身**不会**被传上去（`.gitignore` 已经排除了），密钥不会泄露到 GitHub 上，放心。

---

## 第三步：部署到 Vercel

1. 打开 [vercel.com](https://vercel.com) → Add New → Project → 选你刚推上去的 GitHub 仓库 → Import
2. 部署之前，展开 **Environment Variables**，加两个：
   - `DATABASE_URL` = 跟第一步 `.env` 里填的一样（Supabase 连接池串）
   - `ANTHROPIC_API_KEY` = 你的 Anthropic API Key
3. 点 Deploy，等 1-2 分钟

部署完成后 Vercel 会给你一个免费网址，形如 `https://qijin-mvp-xxxx.vercel.app`——这就是能用的正式地址了，不需要自己买域名。

---

## 第四步：跑一次供应商评分计算（只需要做一次）

```bash
curl -X POST https://你的vercel网址.vercel.app/api/suppliers/recalc-score
```

---

## 完成，打开网址试试

- `/` 智能查询
- `/bom` AI 询价助手
- `/orders` 出货明细
- `/suppliers` 供应商管理

---

## 以后要更新代码怎么办

跟正常的 GitHub 项目一样：本地改完代码，`git push`，Vercel 会自动检测到并重新部署，不需要你手动做任何事。

## 数据库备份

Supabase 免费版自带每天自动备份，保留7天，在 Supabase 后台 **Database → Backups** 能看到，不需要你自己搭。想要更长期的留存，之后再考虑手动导出：

```bash
pg_dump "你的DATABASE_URL" > backup_$(date +%Y%m%d).sql
```

## 免费额度什么时候会不够用

Supabase 免费版：500MB 数据库空间（现在这批数据不到20MB，够用很久）、每月 5GB 出站流量、项目**7天不活跃会暂停**（暂停后再打开一次就恢复，2-3人天天用不会触发）。Vercel 免费版：对这种低流量内部工具基本用不完额度。真到了要收费的那天，说明这工具已经证明了自己的价值，到时候按需升级就是了。

---

## 这一版 MVP 里，我刻意没做的事（不是漏了，是故意留到下一步）

- 没有登录/账号系统（你说了内部2-3人不用做）
- 没有把 BOM 原始文件存档（现在只存 AI 解析后的文本和结构化数据，原始文件本身不留底；以后要做的话 Supabase 自带 Storage，免费额度里也有1GB，到时候接起来不复杂）
- 数据分析图表页（出货趋势、品类分布这些）先没做，核心是先把"查询"和"AI询价助手"跑起来

## 如果以后还是想换回自己的服务器

之前给你写过一版基于阿里云ECS + Docker + 自建Postgres的方案（不依赖Supabase/Vercel），代码逻辑完全一样，只是数据库连接方式和部署步骤不同。需要的话告诉我，我把那版部署文件重新补回来。
