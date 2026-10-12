# SnapTrade 投资组合(只读)+ 交易同步

两样东西共用同一个 SnapTrade Personal API key:

| | 在哪 | 做什么 | key 放哪 |
| --- | --- | --- | --- |
| 投资组合页面 | `/dashboard/portfolio` + `supabase/functions/snaptrade-portfolio` | 实时看账户、余额、持仓、分配、最近订单/活动、连接状态。只读,不落库 | Supabase Edge Function secrets |
| 交易同步(线上定时) | `supabase/functions/snaptrade-sync` + pg_cron(每 10 分钟) | 把 Wealthsimple 的成交/出入金补进 `stock_trades` / `stock_cash`,每次在 `sync_runs` 记"上次检查" | Supabase Edge Function secrets |
| 交易同步脚本(本地) | `scripts/snaptrade/sync-activities.mjs` | 同一份逻辑的命令行版:预览、排查、手动补全部历史 | 本地 `.env` |

## 一次性准备

1. SnapTrade Dashboard:注册 Personal 账户 → 连上券商 → 开 2FA → API Key 页面生成 Personal key。
2. **不要把 key 贴进任何聊天/AI 对话、截图或 issue。** 只写进下面两个地方。
3. 本地 `.env`(已在 `.gitignore`,`git check-ignore .env` 应该输出 `.env`):

   ```dotenv
   SNAPTRADE_CLIENT_ID=
   SNAPTRADE_CONSUMER_KEY=
   WEALTHSIMPLE_USER_ID=     # 你在 Supabase 的 user id(同步脚本写库用)
   ```

4. Edge Function secrets(Supabase Dashboard → Edge Functions → Secrets,或 CLI):

   | 名字 | 值 |
   | --- | --- |
   | `SNAPTRADE_CLIENT_ID` | 同上 |
   | `SNAPTRADE_CONSUMER_KEY` | 同上 |
   | `PORTFOLIO_OWNER_USER_ID` | 你在 Supabase 的 user id —— 只有这个用户能调这个函数 |
   | `PORTFOLIO_ALLOWED_ORIGINS` | 可选,逗号分隔;默认 `https://www.stzheng.com,https://stzheng.com` + 本地 vite 端口 |

5. 部署函数(需要 Supabase CLI,`supabase login` + `supabase link` 过一次):

   ```bash
   supabase functions deploy snaptrade-portfolio
   ```

   保持默认的 JWT 校验(不要加 `--no-verify-jwt`)。

## 本地开发

```bash
npm run dev                                      # 页面:http://localhost:8888/dashboard/portfolio(登录后)
deno test --node-modules-dir=none --no-lock supabase/functions/_shared/   # view model + 部分失败的测试
npm run snaptrade:sync                           # 同步脚本:只预览
npm run snaptrade:sync -- --apply                # 确认预览没问题再写库
```

页面调的是**已部署**的 edge function(和其它函数一样走 `supabase.functions.invoke`),本地前端也一样。

## 安全设计

- **key 只在服务端。** 浏览器 bundle 里没有 SDK 也没有 key;edge function 只返回整理好的 view model
  (`supabase/functions/_shared/snaptradeViewModels.ts`),不返回原始响应。
- **双重鉴权。** 平台的 JWT 校验 + 函数内 `auth.getUser()` 后比对 `PORTFOLIO_OWNER_USER_ID`,不是本人返回 403。
  网站谁都能注册账号,"已登录"本身不够。
- **只读。** 只调 `listBrokerageAuthorizations`、`listUserAccounts`、`getUserAccountBalance`、`getAllAccountPositions`、
  `getUserAccountRecentOrders`、`getAccountActivities`。`PortfolioClient` 接口里没有任何交易方法,也不要加。
- **Personal key 用法。** 官方 SDK(`snaptrade-typescript-sdk`,版本固定)+ `SnaptradeAuth.personalApiKey`;
  不调 `registerSnapTradeUser`,不传 `userId` / `userSecret`,不手写签名。
- **不落库、不缓存。** 响应 `Cache-Control: no-store, private`;日志只记哪个账户的哪一块失败(脱敏后的状态码),不记金额。
- **错误脱敏。** SnapTrade 的 401 会把收到的 clientId 原样回显在错误信息里(`Invalid clientId provided - <值>`),
  `describeError` 和同步脚本都会截掉。
- **CORS** 只放行自己的站点和本地开发端口。
- 怀疑 key 泄露:SnapTrade Dashboard 里删掉重建,再更新上面两处。

## 页面怎么算

- **按币种分开汇总,不做汇率换算。** 每种货币一张卡:账户总值(SnapTrade 的 `balance.total`)、现金、持仓市值。
- **只算投资账户。** 信用卡、投资组合信用额度(LOC)、现金账户(Chequing)只在账户列表里显示,不计入汇总,也不拉明细。
- **持仓市值** = 数量 × 每股价 × 合约乘数(股票 1,期权通常 100)。`cash_equivalent` 的持仓已经计入现金,不重复加。
- **部分失败**:每个账户的余额/持仓/订单/活动各自独立,失败的那块在页面上标出具体账户和原因,其它照常显示;不会用假数据补。
- **时间**:页面显示"本页拉取于"(edge function 拉数据的时间)和每个账户 SnapTrade 给的"持仓同步 / 数据时间",
  两者不是一回事。
- **数据新鲜度**:Personal 版大多是每日缓存。持仓、余额、活动一般一天一更;最近订单(24 小时)是实时接口。
  活动记录当天的成交通常第二天才出现。

## 线上定时同步

- 逻辑在 `supabase/functions/_shared/snaptradeSync.mjs`(配对)、`stockApply.mjs`(写库 + 日历 diff + import_logs)、
  `priceSync.mjs`(收盘价)。本地脚本和 edge function import 的是同一份;`src/app/lib/dailyPnl.ts` 等只是转发到 `_shared`。
- pg_cron 任务 `snaptrade-sync` 每 10 分钟调 `public.invoke_snaptrade_sync()` → POST edge function,请求头带 Vault 里的
  `snaptrade_sync_secret`。函数 `verify_jwt` 关闭,自己校验:密钥对(RPC `snaptrade_sync_secret_ok`,只有 service_role 能调),
  或者 Bearer 是 `PORTFOLIO_OWNER_USER_ID` 本人的登录 token。其它一律 401/403。
- 每次只看最近 14 天;没有新记录就不写库(不同步收盘价、不写 import_logs),只更新 `sync_runs`。
- 首页 Wealthsimple 卡片的"自动检查"读 `sync_runs`;"上次同步"仍然是库里最新一条记录的写入时间。
- 停掉:`select cron.unschedule('snaptrade-sync');`  手动跑一次:`select public.invoke_snaptrade_sync();`
  (结果在 `net._http_response`)。改了 `_shared` 里的代码要重新部署 `snaptrade-sync`。

## 同步脚本的去重规则

SnapTrade 的 activity id 和 CSV 导入的 `ws_trade_*` 对不上,按内容配对:账户 + 标的 + 方向 + 股数 + 日期
(同一天 → ±1 天;同一桶里挑价格最接近的)。配上的不写;配不上的以 `snap_trade_<id>` 写入,下次按 id 直接认出。

- 账户按 `meta.unifiedAccountType` 映射(`SELF_DIRECTED_TFSA` → TFSA,`SELF_DIRECTED_NON_REGISTERED[_MARGIN]` → NON-REG),
  **不要按名字猜**:WS 的投资组合信用额度 `raw_type` 也是 `PERSONAL`。已关闭的投资账户也读(老交易靠它配对)。
- 期权:SnapTrade 是每股权利金,库里 WS OCC 期权按每张合约总价记,写入时 ×100;OCC 代码按 WS 的写法补齐到 6 位。
- 改名的票(SnapTrade 用新代码回显历史成交):`TICKER_ALIASES` 里加一条,只用于配对。
- **现金只同步库里最后一笔非 SnapTrade 现金记录之后的。** 历史部分口径不同(SnapTrade 分红是扣税后净额,
  CSV 是毛额 + 预扣税两条;CSV 导入专门排除过几笔重复转账;还有手动"对齐余额"的记录),硬配会重复记钱。
- 写库、收盘价同步、日历前后 diff、`import_logs` 复用 `scripts/wealthsimple/import-csv.mjs` 的 `applyToSupabase`(source = `snaptrade`)。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 页面"Failed to send a request to the Edge Function" | 函数还没部署,或 CORS 不放行当前域名(看 `PORTFOLIO_ALLOWED_ORIGINS`) |
| `snaptrade-portfolio 403: forbidden` | 登录的不是 `PORTFOLIO_OWNER_USER_ID` 那个用户 |
| `snaptrade-portfolio 500: server not configured` / credentials | 函数 secrets 没设全 |
| `HTTP 401: Invalid clientId provided` | client id / consumer key 填反或填成同一个值 |
| 某个账户显示"部分失败" | 看页面上那块的错误;一般是券商侧超时,刷新即可。SnapTrade 对个人用户每账户每分钟 10 次请求 |
| 显示"连接已被禁用" | 券商改了密码或授权过期 —— 在 SnapTrade Dashboard 里重新连接 |
| 数据和券商 App 对不上 | 先看账户的"持仓同步"时间 —— Personal 版多为每日数据 |
| 活动里看不到今天的成交 | 正常,活动是每日缓存;今天的成交看"最近订单" |
