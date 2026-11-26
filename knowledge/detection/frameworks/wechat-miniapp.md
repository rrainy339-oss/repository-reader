# 微信小程序页面、会话与 WebView

任务涉及 app.json、WXML、wx.login、wx.request、本地存储或 web-view 时。

## 从事件定位后端

用入口索引识别 `app.json` 页面与分包候选。结合 WXML 绑定、`Page`/`Component` 处理函数和请求封装找到 `wx.request`、`wx.cloud.callFunction` 或页面导航。阅读实际数据字段与服务端处理器。按钮可见性、客户端字段检查和本地缓存只证明客户端行为。

`wx.login` 返回供服务端交换的临时凭证；业务会话仍需检查后端交换结果如何绑定用户、签发及撤销会话。把平台用户标识、应用账户和资源归属分开。独立查普通网络请求、云调用和网页内会话的凭据载体及退出行为，避免猜测 Cookie 是否共享。

## 本地数据、网页与支付

对 `wx.setStorage` 或同步版本，记录写入字段、清除时机、后续消费和实际露出。展示缓存与服务端权限区分。对 `web-view` 查 URL 来源、允许的目标、消息接收处理及携带会话信息的边界。不假定配置域名或页面来源能替代服务端授权。基础库和正式环境的行为没有适用资料时保留缺口。支付成功界面记录为客户端状态，款项与订单状态的权威依据见[订单支付手册](../vulnerabilities/payment-order.md)。

## 证据与反证

保留事件绑定和网络封装的范围，后端未在仓库时说明缺失。服务端可在其他项目接收请求，网页可能有独立的访问策略。网页文档无法核验时，只根据目标仓库的可见代码、官方 SDK 声明和经核实的适用资料作结论。

## References

- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/e5dc50ccea71e7999a8aa8a942a6f68045e141ca/types/wx/lib.wx.api.d.ts)
- [腾讯 CloudBase · 小程序云数据库](https://docs.cloudbase.net/recipes/add-database-wechat-miniprogram)
- [腾讯 CloudBase · 云函数访问控制](https://docs.cloudbase.net/cloud-function/security-rules)
- [微信支付官方 · 支付回调和查单实现指引](https://pay.wechatpay.cn/doc/v3/partner/4012082568)
- [版本、许可证及改写说明](../SOURCES.md)
