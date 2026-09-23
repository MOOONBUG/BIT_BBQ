# Zoho 内部通知接通说明

2026-09-24：经营者已授权；内部通知已部署启用，真实测试邮件获 Zoho 接受。收件箱及生产定时任务完整链路仍待核验，需继续人工检查。

## 通知范围

只向经营者指定的一个邮箱发送新询价/免费微诊断提醒。邮件包含编号、类型、页面语言和 UTC 接收时间，不含客户邮箱、需求、URL 或其他提交正文。不向申请者发确认邮件，不表示入选或已回复。

通知当前已开启（NOTIFICATIONS_ENABLED=true），启用时间 Unix 1790178975，每五分钟最多处理三条；不改实时表单接收，不新增数据库表。保留每天 02:15 UTC 的原清理任务。

用户已确认登录入口 https://mail.zoho.com/zm/ ，本地 ZOHO_REGION 已设为 com；尚未取得实际 API 授权。

## 接通所需

1. 确认 Zoho 数据中心：当前实现 com、cn、eu，分别使用对应 accounts/mail 域名。不得仅凭用户所在国家猜测；其他地区先补对应官方端点。
2. 在实际 Zoho 账户核实 API 权限/套餐。OAuth 使用 ZohoMail.messages.CREATE；查询账户编号时另需 ZohoMail.accounts.READ。以账户真实授权界面为准，不索取登录密码。
3. 取得账户编号和与授权账户关联的发件地址；当前候选 hello@mooonstoreclinic.top。确定经营者接收通知的邮箱，不能默认填写客户邮箱。
4. 通过 Cloudflare Secret 配置 ZOHO_CLIENT_ID、ZOHO_CLIENT_SECRET、ZOHO_REFRESH_TOKEN；不要把值放进 Git、文档或聊天。TURNSTILE_SECRET_KEY 和 RATE_LIMIT_SECRET 已存在，不应覆盖。
5. 设置 ZOHO_REGION、ZOHO_ACCOUNT_ID、NOTIFICATION_FROM、NOTIFICATION_TO。设置 NOTIFICATIONS_START_AT 为明确的 Unix 秒时间；只有此后创建且未到期的申请会进入发送。历史内部验收编号永远排除。
6. 保持关闭完成部署检查；获得经营者对实际接收地址及测试通知的授权后，安排一条新的自有测试申请，核对邮件与数据库记录。验证成功后再启用正式通知。不能把模拟测试称为真实邮件验收。

Wrangler 配置声明了密钥名称以生成类型，但不包含值。本地 .dev.vars.example 只有占位符，正式值放入忽略的 .dev.vars 或 Cloudflare Secrets。

## 失败处理

| 记录 | 含义 | 处理 |
|---|---|---|
| pending | 等待发送，或明确被 401/429 拒绝 | 自动延迟重试，最多五次；429 尊重 Retry-After，最长一天 |
| sending | 已原子领取、可能正在发送 | 120 秒租约内不重复领取 |
| sent | Zoho 返回成功状态及 messageId | 表示服务商接受，不保证最终投递/已读 |
| failed / delivery_unknown | 网络错误、5xx、无法验证的成功回执或过期发送租约 | 查 Zoho 已发送文件夹，按邮件标题里的编号核对；不能自动重发 |
| failed / http_4xx | 明确拒绝或重试上限 | 查权限、发件账户或配额，修复后人工决定 |

Zoho 所检索发送文档未声明幂等键，因此不承诺端到端 exactly-once。领取后崩溃也可能尚未发送，仍保守转人工核对。人工重排前必须先查已发送记录；若确认已接受，记录实际 messageId，否则在单独明确授权后重试。不要把 failed 批量重置成 pending。

令牌刷新失败不领取邮件，下次定时任务再试。日志事件 notification_auth_failed、notification_configuration_missing、notification_health 不包含客户资料或服务商返回正文。日志告警规则尚未配置，不能称已自动报警。

## 只读检查

在正式数据库查询（不返回客户内容）：

```sql
SELECT state, last_error_code, COUNT(*) AS total
FROM notification_outbox GROUP BY state,last_error_code;

SELECT enquiry_id,state,attempts,next_attempt_at,lease_until,provider_message_id,last_error_code
FROM notification_outbox WHERE state IN ('failed','sending') ORDER BY next_attempt_at LIMIT 50;
```

历史 pending 可能被开始时间排除，pending 数量不等于当前可发送数量。通知记录继续随询价原 90 天到期策略清理。

## 验证与回退

`npm test` 包含接收、微诊断、通知专项（模拟 Zoho 网络）；`tsc --noEmit` 与 API Wrangler dry-run 检查类型和打包。真实 Zoho 授权与单封发送已完成；收件箱投递和生产定时发送端到端验收尚未完成。

遇故障先将 NOTIFICATIONS_ENABLED 设回 false 并部署 API，保留队列供人工核对，不删除询价。旧生产接收版本仍可使用原数据库，不需要回滚迁移。

官方依据（2026-09-23 获取）：

- https://www.zoho.com/mail/help/api/post-send-an-email.html
- https://www.zoho.com/mail/help/api/using-oauth-2.html
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/

本地公开文档快照：runs/notification-20260923/（工作区根目录）。


## 2026-09-23 Zoho 实际授权核验

用户通过本地工具完成 OAuth，凭据仅保存在 .cloud-setup/zoho-oauth.dpapi（Windows 用户加密、Git 忽略）。刷新令牌及官方账户只读接口核验成功，主邮箱和有效发件地址均为 hello@mooonstoreclinic.top；本地配置已补账户编号及 com 地区。未发送邮件、未安装云端密钥、未部署。下一步确认内部通知收件地址与一封测试通知授权，完成云端配置及真实发送验收；通知开关仍为 false。

## 2026-09-24 Zoho 通知上线（北京时间，覆盖此前本地状态）

- 用户明确授权向 hello@mooonstoreclinic.top 发送一封测试通知，并用该地址接收内部新申请提醒。
- 已使用真实 OAuth 发出一封测试，Zoho 返回接受状态及 messageId。标题含 Notification connection test，编号 MSC-NOTIFY-TEST-20260923-155346。服务商接受不等于收件箱投递已核验，等待用户查看；未申请读取邮件权限。
- 三项 Zoho 密钥已通过标准输入安装到 Cloudflare mooon-enquiries，原 Turnstile / 限流密钥保留。Git 不含密钥；本地授权仍为 .cloud-setup/zoho-oauth.dpapi。
- API 已部署版本 1b302d9b-3e2a-4b89-9344-7ab48e8482b5。NOTIFICATIONS_ENABLED=true，收发地址均为 hello@mooonstoreclinic.top，ZOHO_REGION=com。开始时间 Unix 1790178975（2026-09-23 23:56:15 北京时间），不处理更早记录。
- 定时触发器已发布：每五分钟处理最多三条；原每天 02:15 UTC 清理保留。没有数据库迁移。部署前只读查询共一条历史内部测试，已排除发送。
- 本地 29 项测试、类型和 API dry-run 已通过；真实 Zoho 单封发送已获接受。尚未完成生产新申请→定时任务→收件箱的端到端验收，外部主动失败告警尚未设置；仍需人工查看业务及失败队列。
- 部署后 /api/free-reviews/config 返回 200 且启用；其他线上检查及实时日志连接遇到超时，正在记录最终复查结果。证据 runs/notification-20260923/live-verification.json。
