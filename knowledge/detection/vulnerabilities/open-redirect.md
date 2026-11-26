# 重定向与网页导航目的地

接口生成 Location，接受 returnTo，或小程序网页跳转依赖外部参数。

## 安全属性与成立条件

导航或认证返回只能落在该操作允许的路径、来源或已注册位置。只有外部值影响最终导航且可以超出政策时，才能形成相应候选。区分客户端导航、服务器重定向和服务器出站访问。

## 源码调查

从重定向调用、`Location` 或网页导航消费点回溯目标。核对可信基准 URL、解析后的来源和协议、路径要求以及多步跳转。若处于登录回调，确认返回目标和当前会话或状态的绑定。允许列表应采用与实际消费者一致的解释语义。

## 控制、证据与误报

对照例通过已知页面标识选择应用内固定路由，而不把外部字符串当成最终目的地。对允许外站的功能明确业务政策并检查精确目标。引用输入、解析、检查与输出；导航到预登记身份提供方或恰当验证后生成的站内地址可能符合预期。客户端配置的作用范围另按平台资料确认。

## References

- [OWASP · Unvalidated Redirects and Forwards](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.md)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [版本、许可证及改写说明](../SOURCES.md)
