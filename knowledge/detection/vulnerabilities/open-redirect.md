# 重定向与网页导航目的地

接口生成 Location，接受 returnTo，或小程序网页跳转依赖外部参数。

## 安全属性与成立条件

导航或认证返回只能落在该操作允许的路径、来源或已注册位置。只有外部值影响最终导航且可以超出政策时，才能形成相应候选。区分客户端导航、服务器重定向和服务器出站访问。

## 源码调查

从重定向调用、`Location` 或网页导航消费点回溯目标。核对可信基准 URL、解析后的来源和协议、路径要求以及多步跳转。若处于登录回调，确认返回目标和当前会话或状态的绑定。允许列表应采用与实际消费者一致的解释语义。

## 控制、证据与误报

对照例通过已知页面标识选择应用内固定路由，而不把外部字符串当成最终目的地。对允许外站的功能明确业务政策并检查精确目标。引用输入、解析、检查与输出；导航到预登记身份提供方或恰当验证后生成的站内地址可能符合预期。客户端配置的作用范围另按平台资料确认。

## 跳到哪里，由哪个组件决定

追踪 `returnTo`、订单返回页、OAuth 登录完成页和 WebView `src`，直到真正写入 `Location` 或导航 API。确定校验与消费者使用的解析规则，比较目标协议、来源及允许的路径。若服务接收导航键并从服务端固定映射选路径，查失败分支也用固定默认值。以请求 Host 构造基址时，要核实网关或框架对 Host 的来源约束。向用户显示目标域名只是 UI 提示，服务端仍可能使用另一个值。

例如，账户模块在登录前存下经过本站导航策略验证的路由 ID，回调只从内建表取站内目标。读回调和存储序列化，确认未从原始请求重新取 URL。浏览器导航目的地可影响用户和认证流程。SSRF 调查关注服务端外联，看到相同的 URL API 时按消费点判断。发生跨域导航亦不自动证明授权码、Cookie 或 Token 会送达，需看应用显式转发和浏览器实际的凭据策略。

## References

- [OWASP · Unvalidated Redirects and Forwards](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.md)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [版本、许可证及改写说明](../SOURCES.md)
