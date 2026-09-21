# MooonStoreClinic 商务官网管理手册

## 网站入口与用途
- 目标默认网址：https://mooon3.wooou-bill.workers.dev
- Cloudflare Worker：mooon3。
- GitHub：https://github.com/MOOONBUG/BIT_BBQ ，生产分支 main。
- 这是服务介绍与询盘网站，不是已商用的自动改站SaaS。没有自动收费、会员或客户HTML上传入口。
- 业务：单商品页诊断，USD60为建议入门报价；实施另行报价。实际书面报价与付款条款在开工前确认。
- 默认域名为Cloudflare提供的子域名，不是已恢复的自有域名。最终上线状态见随附部署记录。

## 页面与修改入口
| 内容 | 文件 |
|---|---|
| 首页服务、流程、FAQ | src/pages/index.astro |
| 关于我们 | src/pages/about.astro |
| 自制诊断样例 | src/pages/sample.astro |
| 联系页面与咨询说明 | src/pages/contact.astro |
| 隐私说明 | src/pages/privacy.astro |
| 服务条款 | src/pages/terms.astro |
| 邮箱、WhatsApp链接、首页价格 | src/site.ts |
| 配色和移动布局 | src/styles/global.css |
| 标志、分享图、favicon | public/brand/ 与 public/favicon.svg |
| 浏览器标题、分享信息 | src/components/BaseHead.astro 与页面传入标题 |
| 网站正式URL | astro.config.mjs 中 site |
| 搜索引擎站点地图地址 | public/robots.txt |
| 下载的咨询提纲 | public/review-brief.txt |

## 联系方式
当前WhatsApp Business公开入口：https://wa.me/message/MBMDLTOAH5HFF1 ，商家显示名称Mooon Store Clinic。邮箱尚未配置。链接由用户提供，网站不自动发送消息。
在 src/site.ts 的 email 填完整邮箱，whatsapp 填应用提供的完整分享链接，或核实的 https://wa.me/国际号码。不得把@用户名直接拼接成wa.me链接。手机号链接会公开该号码。
两项为空时页面会提示未开放咨询，提纲下载不等于发送。设置地址后必须实际点击确认打开正确收件人；不在测试时向自己以外的人发消息。
网站不会自动替你设置邮箱。域名邮箱需要独立邮箱服务和MX/SPF/DKIM/DMARC；Cloudflare Email Routing只做转发时不等于有商务发信能力。

## 本地预览和检查
使用支持项目依赖的Node LTS与npm。本次Node24.16验证通过。
```
npm ci
npm run dev
npm run check
```
本地预览默认 http://localhost:4321 。check执行构建、tsc、Cloudflare打包预检，不上传线上。
如在受限机器执行，设置ASTRO_TELEMETRY_DISABLED=1、WRANGLER_SEND_METRICS=false，并将WRANGLER_LOG_PATH设置到可写目录。
现有适配器会提示当前全静态页面不需要SSR适配器；这是提示，不代表构建失败。本次保留现有部署结构，未盲目升级旧依赖。上线后另行安排依赖安全审查。

## Cloudflare自动部署
截图确认的配置：仓库BIT_BBQ、生产分支main、根目录 ./、构建命令留空、部署命令 npm run deploy。
此deploy脚本已包含 astro build && wrangler deploy，因此构建命令留空是有效配置。wrangler.json名称必须与mooon3一致。
main有新提交可触发自动部署。先确认GitHub对应提交成功，再到Cloudflare“部署/构建”核对状态与提交，不能把Git push成功当作网站上线成功。
检查默认网址首页、sample、contact、privacy、terms及404，检查手机布局和下载。若有500，开启Workers日志并用一次访问复现，查看异常，别删除不理解的旧变量。
部署会替换该Worker正在运行的版本；保留部署历史便于回滚。

## 自定义域名
badbenu.sbs此前公开DNS返回NXDOMAIN，尚未确认注册状态。先到原注册商检查有效期、暂停状态和NS委派。Cloudflare保留绑定不代表域名仍有效。
确认持有和有效后，在Cloudflare Worker的“域/域名和路由”添加选定自定义域名，按平台要求配置DNS，等待HTTPS证书有效。
域名成功后同步修改astro.config.mjs的site和public/robots.txt，再部署检查canonical、sitemap及分享URL。旧默认域名是否重定向需单独决定。
不要随意删除MX/TXT等邮箱记录，不要把域名绑定和邮箱配置混为一谈。域名续费需要另行购买授权。

## 日常管理与回退
- 内容在GitHub修改，先预览检查，再合并main；不同时在Cloudflare“编辑代码”另改一份，避免配置漂移。
- 每次上线记录提交SHA和Cloudflare部署版本。故障优先用Cloudflare部署历史回滚；或revert问题提交并重新部署，避免force push。
- Git只保存源码，客户资料、API密钥、密码、收款记录不入库。Cloudflare机密应使用Secret。
- 本次只使用官方v8购物袋月亮行星环标志；商标审查仍待完成。
- 不添加虚假客户Logo、评价或“提升xx%”数据。示例报告必须保持演示标记。
- 不承诺零数据丢失、保证销量或自动整站修改。
- 初期无新增订阅；Cloudflare免费额度有上限，检查账户计划、用量和账单提醒，不假定永久免费。
- 新增分析、表单或支付前更新隐私/条款并核实数据处理方式。现有外链通信受邮件/WhatsApp服务商规则约束。
- 联系方式、报价、付款条款和实际交付能力定期复核。价格变化需同步首页和terms页面。
