# 微信小程序页面、会话与 WebView

任务涉及 app.json、WXML、wx.login、wx.request、本地存储或 web-view 时。

## 从事件定位后端

用入口索引识别 `app.json` 页面与分包候选。结合 WXML 绑定、`Page`/`Component` 处理函数和请求封装找到 `wx.request`、`wx.cloud.callFunction` 或页面导航。阅读实际数据字段与服务端处理器。按钮可见性、客户端字段检查和本地缓存只证明客户端行为。

`wx.login` 返回供服务端交换的临时凭证；业务会话仍需检查后端交换结果如何绑定用户、签发及撤销会话。把平台用户标识、应用账户和资源归属分开。独立查普通网络请求、云调用和网页内会话的凭据载体及退出行为，避免猜测 Cookie 是否共享。

## 本地数据、网页与支付

对 `wx.setStorage` 或同步版本，记录写入字段、清除时机、后续消费和实际露出。展示缓存与服务端权限区分。对 `web-view` 查 URL 来源、允许的目标、消息接收处理及携带会话信息的边界。不假定配置域名或页面来源能替代服务端授权。基础库和正式环境的行为没有适用资料时保留缺口。支付成功界面记录为客户端状态，款项与订单状态的权威依据见[订单支付手册](../vulnerabilities/payment-order.md)。

## 证据与反证

保留事件绑定和网络封装的范围，后端未在仓库时说明缺失。服务端可在其他项目接收请求，网页可能有独立的访问策略。网页文档无法核验时，只根据目标仓库的可见代码、官方 SDK 声明和经核实的适用资料作结论。

## 登录交换和账户绑定

从 `app.json` 的页面与分包，读 WXML 事件、请求封装、后端登录路由与持久化映射。官方 SDK 声明描述 `wx.login` 返回临时 code，供服务端交换身份。审查服务端是否用当前应用配置参与交换、只使用交换结果中的平台身份，再签发自身业务会话。平台 OpenID 在小程序应用范围内使用。多应用共享账户时检查项目如何约束应用身份、平台 ID 与业务用户的映射。UnionID 有返回条件。绑定与合并是否允许由本项目规则决定。核对 `session_key`、应用密钥与换票凭据的实际消费者，确认业务响应和日志没有返回这些值。

例如，`login.ts` 将临时 code 提交到会话服务，`identity.ts` 按已确认的应用及交换所得 OpenID 查找业务账户，`orders.ts` 通过同一个会话查找当前用户的订单。支持证据包括实际收到的 code、服务端绑定的配置、会话解析和订单谓词。若只有页面成功回调，没有服务端交换或映射源码，只能确认客户端请求与界面状态。`wx.request` 的成功回调提供响应状态。判断会话续期、支付或业务提交时应继续核对 `statusCode`、业务响应字段和实际持久化。

## WebView 及跨通道身份

单独画出小程序网络请求、云 SDK 和 WebView 网页三个通道的访问主体、凭据来源和退出路径。追踪 `web-view` 实际 `src`、网页跳转、网页 Cookie 或单点登录流程，以及消息事件的真实处理位置。对进入敏感动作的消息，检查项目是否解析允许的消息类型、校验字段、从可靠的上下文确认来源以及由后端独立授权。如果需要来源属性、域名限制或特定时点才能作结论，以对应基础库、平台模式和配置为准。在缺失对应文档时不推断消息是实时投递或具备可校验的来源属性。可信网页想调用小程序侧动作，网页会话也需要与实际业务主体关联。

案例中，WebView 返回「已提交」后页面只刷新订单，服务端从验证过的来源读取订单状态。对照路径是网页消息、JS 回调或本地缓存直接形成可用权益。需要阅读消息消费、凭据注入、订单查询和最终更新，证明实际影响及业务要求。应用退出只清掉小程序本地存储时，再看网页的独立 Cookie 与后端会话是否也应退出。支付、退款或奖励状态应按[订单支付](../vulnerabilities/payment-order.md)和[业务状态](../vulnerabilities/business-invariants.md)各自追踪。

## References

- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/e5dc50ccea71e7999a8aa8a942a6f68045e141ca/types/wx/lib.wx.api.d.ts)
- [腾讯 CloudBase · 小程序云数据库](https://docs.cloudbase.net/recipes/add-database-wechat-miniprogram)
- [腾讯 CloudBase · 云函数访问控制](https://docs.cloudbase.net/cloud-function/security-rules)
- [微信支付官方 · 支付回调和查单实现指引](https://pay.wechatpay.cn/doc/v3/partner/4012082568)
- [miniapp-audit-skills · 不同平台通道与可用证据](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-tools-evidence.md)
- [版本、许可证及改写说明](../SOURCES.md)
