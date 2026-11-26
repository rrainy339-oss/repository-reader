# 服务端出站请求与目的地约束

服务端处理器、代理、Webhook、预览或下载任务会访问变动 URL 时。

## 安全属性与成立条件

服务端只向该业务允许的目的地、协议和服务访问。关键证据是调用者可影响实际服务端访问的位置并超出允许范围。浏览器或小程序客户端自己发出的请求，与服务器代为访问应分开。

## 源码调查

从 HTTP 客户端或抓取器回溯 URL 来源，区分服务端主机常量和仅用于资源选择的可变字段。读取解析、标准化、认证信息、重定向以及代理与出站策略配置。控制若在封装中，要核对当前调用是否确实使用该封装及其有效选项。DNS 与网络层类结论需要实际配置依据。

## 控制、证据与反证

可固定服务注册表，由允许的服务 ID 选择预配置客户端，再传已检查的业务参数。确需可选目的地时，由相同的解释语义校验最终地址并覆盖重定向路径，结合网络层控制。记录输入、实际服务端请求、目的地选择、控制和缺失的部署证据。固定目标、只变更经构造的资源字段或封装层拒绝非法目标均可提供反证。

## References

- [OWASP · Server Side Request Forgery Prevention](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md)
- [Semgrep · express-ssrf.yaml](https://github.com/semgrep/semgrep-rules/blob/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/javascript/express/security/audit/express-ssrf.yaml)
- [Node.js · Child process](https://nodejs.org/api/child_process.html)
- [版本、许可证及改写说明](../SOURCES.md)
