# 余额悬浮窗（balance-float）

DSH Web UI 的悬浮小窗：显示当前 API 余额、今日已用、**每轮次消耗**和峰谷定价。
Host 半边自己维护本地用量账本（按轮记账 + 余额轮询），浏览器半边只读快照。

## 两半

| 半边 | 文件 | 作用 |
| --- | --- | --- |
| Host | `index.js` + `lib/` | 订阅会话事件记账、轮询余额、写本地账本，注册只读路由 `GET /balance-float/snapshot` |
| Client | `client.js` | 在 `shell.overlay` 里注册悬浮窗（可拖动、每 4 秒刷新、点开看明细） |

## 账本

- 位置：`$DSH_HOME/balance-float/usage.json`（可用 `storeFile` 改）。原子写入（临时文件 + rename），损坏时按默认结构重建。
- 首次运行若没有自己的账本，会从旧的 `.dshw-usage.json` **复制**一份做种子（余额、今日、历史、近期事件），之后两边互不影响。
- 字段：`date`、`dayStart`（今日 0 点余额）、`lastBalance`、`todayUsage`、`history`（按天）、`events`（每轮每模型一条，含 `ts`/`model`/`cost`/`tokens`）。

## 记账与余额

- **逐轮记账**：监听 `session/event`，把 `assistant/message` 的 `usage` 按（会话, 轮次）聚合，`turn/end` 时按官方单价折成费用，每个模型追加一条事件。子代理轮次同样计入。
- **余额**：每 `refreshSeconds`（默认 20 秒）用 `credentials.resolve(apiKeyRef)` 取官方 API Key，请求 `https://api.deepseek.com/user/balance`，写回 `lastBalance`。密钥不出 Host 进程，也不写日志。
- **今日已用**：`dayStart - lastBalance`（能覆盖本机其它客户端的花费），同时不低过本地事件合计；跨零点时把昨日合计归档进 `history`，并用当前余额作为新一天基线。检测到充值（余额变大）时重设基线而不是报负数。
- 拿不到 Key 或接口失败时只保留已有数字，不会把余额写成 0。

## 峰谷定价

- 峰时：北京时间周一至周五（不含法定节假日）`09:00–12:00`、`14:00–18:00`；其余时段（含周末、法定节假日全天）为谷时。
- 界面配色：**峰=红、谷=绿**（胶囊的时段标签、卡片徽标、单价表里当前生效的一侧）。
- 单价（元 / 百万 tokens，`谷 / 峰`）：Flash 命中 `0.02 / 0.04`、未命中 `1 / 2`、输出 `4 / 8`；
  Pro 命中 `0.15 / 0.3`、未命中 `4.5 / 9`、输出 `13.5 / 27`。
- 来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>。
- 2027 年节假日安排发布后，补 `lib/pricing.js` 的 `HOLIDAY_VALLEY` 表即可。

## 配置

```yaml
- insert:
    - id: balance-float
      name: '@local/balance-float'
      config:
        storeFile: ''          # 账本路径，默认 $DSH_HOME/balance-float/usage.json
        legacyFile: ''         # 首次运行的种子账本，默认 $DSH_HOME/.dshw-usage.json
        refreshSeconds: 20     # 余额轮询间隔
        apiKeyRef: DEEPSEEK_API_KEY
```

## 外观设置

胶囊右侧的滑杆图标（卡片标题栏里也有）打开外观面板，三项都即时生效并保存在 `localStorage['dsh.balance-float.appearance']`：

| 项 | 范围 | 说明 |
| --- | --- | --- |
| 背景透明度 | 0–90% | 0 用主题的 `--dsw-alias-bg-overlay`，越大越透（面板/胶囊/气泡一起） |
| 边框 | 0–100% | 边框层的不透明度 |
| 阴影 | 0–100% | 投影强度，0 时完全无影 |

「恢复默认」回到 0% / 100% / 100%。实现是把背景与边框放在 `::before` / `::after` 图层上，文字和图标始终不透明，不会跟着变淡。

## 交互

- 默认停在右下角，拖动后位置记在 `localStorage['dsh.balance-float.position']`。
- 收起态：余额 / 今日 / 当前时段与秒级倒计时；点开：本轮消耗与耗时、今日峰谷拆分、单价表、近 7 天柱状图、账本更新时间。
- 每结算完一轮，胶囊左下方浮出「本轮 ¥x」气泡，3 秒后自动淡出；同一轮只提示一次。
- 胶囊下方剩余空间 <120px（输入框就在这条底部带里）时，气泡自动翻到胶囊**上方**，尖角方向随之翻转；卡片开合或拖动胶囊后会重新量一次。
- 悬浮窗每 4 秒轮询一次，页面回到前台、窗口获得焦点或展开面板时立即补一次。
- 刷新按钮（环形箭头，请求中旋转）立即刷新；**点标题栏即可收起**（没有单独的收起按钮）。
- 展开方向自适应：默认从胶囊**向下展开**；胶囊贴在屏幕底部、下方空间不够（<340px）时改为**向上展开**，并把卡片高度限制在视口内、内容区滚动。
- 卡片比胶囊宽（316px），靠右时自动改为右边缘对齐，不会顶出屏幕；胶囊本身的位置保持不变。
- 动效方向跟着展开方向走：向下展开从上方滑入、向上收起；向上展开从下方向上浮出、向下收回。均无缩放，收起先播 180ms 再卸载。
