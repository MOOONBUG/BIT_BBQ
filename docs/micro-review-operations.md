# 微诊断运维与后续改版预留

正式路径 /free-review/，支持 ko / ja / zh-hant / ru / fr。页面语言与英语交付语言分离。

## 稳定边界

- shared/services.ts：服务 ID、条款版本、交付语言和初始显示值。改版不改 ID；变更交付范围须同步更新条款版本，旧表单会拒收而不是静默接受新范围。
- src/i18n/micro-*.json：六语言文案集中管理。
- src/pages/free-review.astro：展示层；BriefBuilder 按服务类型复用。改布局无需重建数据库。
- POST /api/enquiries：保留原有接口和旧请求哈希兼容；免费申请带 serviceType=free_trial 和 policyVersion。
- GET /api/free-reviews/config：实时开关与每周容量，不公开客户资料。后续改 URL 应保留兼容路由或重定向。
- review_campaigns：运行时开关、weekly_limit、intake_limit。首轮每周最多入选 2 个，待评估/候补最多 5 个；满额自动暂停免费接收，不影响付费询价。公开每周名额读取接口；永久变更也要同步静态默认值。
- free_reviews：独立评审状态、范围版本、交付语言。同请求重试返回原编号；同邮箱/规范化页面的新请求只作内部重复标记，人工核对，不返回别人的编号。
- review_slots：数据库触发器控制每周容量，并发也不能超额。selection_week 为约定交付周的周一日期，以北京时间业务周解释。撤回或改期不会自动释放原周名额，保守防止超额安排。
- 不增加公开管理接口，不与付款或日历绑定。保持 mooon3 静态站与 mooon-enquiries API 分离。

## 人工处理

由经营者人工查看。建议北京时间 10:00、18:00 检查；未安装定时提醒。Zoho 仍无发送器，不得把 pending 当成已发邮件。不得向旧内部验收编号 MSC-51e08077-c0ac-49a4-aad4-b722de0bdb4f 发送通知。

npm run reviews -- list：先看编号、时间和状态。
npm run reviews -- detail MSC-完整编号：必要时查看客户资料，不把输出贴到公开日志。

变更默认只预览 SQL，加 --apply 才实际执行。先与客户确认范围和交付日期，再选入对应周：

```text
npm run reviews -- status MSC-完整编号 selected 2026-09-28 --apply
npm run reviews -- status MSC-完整编号 waitlisted --apply
npm run reviews -- status MSC-完整编号 unsuitable --apply
npm run reviews -- status MSC-完整编号 delivered --apply
npm run reviews -- pause --apply
npm run reviews -- resume --apply
```

日期只是示例，不是承诺。每周满额将拒绝入选；交付状态需要已有选择周。CLI 不发送消息。

优先检查重复申请并人工合并/关闭多余请求。每份 20 分钟、周筛选 10 分钟为内部预算。待处理上限限制的是积压，不是每周总申请数；本周筛选预算用完时应主动暂停。首两单后核实真实耗时。

## 保留、发布及回退

询价及关联评审、名额记录、outbox 随原 expires_at（90 天）清理，不作为长期授权或财务档案。内部测试没有永久豁免。

0002 为增量迁移，先迁移再发布 API，最后发布静态站。回退先暂停活动，可还原静态/API 版本，但保留新增表和记录，不删库。数据库 enabled 开关在重新部署后仍保留。

验证：npm test、npm run build、tsc --noEmit、Wrangler dry-run；本地浏览器测试在工作区 runs/site-browser-qa/micro-review-integration.cjs 和 micro-paid-regression.cjs。本地替代 Turnstile 仅用于测试，生产保持真实安全验证。
