# 身份认证与会话

任务涉及登录、鉴权中间件、Token、Cookie、跨通道会话或退出。

## 安全属性与成立条件

需要身份的敏感操作接受已验证且仍有效的主体。候选问题应能说明某个有效入口接受了未建立可信身份的请求，或采纳了与该请求不绑定的身份。认证负责建立身份，资源授权另行核对。

## 源码调查

从每个实际挂载点读凭据提取、验证、主体绑定和后续消费。区分解码与验签，核对算法选择、发行者、受众、用途和有效期属于当前项目要求的哪些条件。检查异常、缺失字段、匿名路径和回退处理。会话看签发、权限变更、轮换、撤销和退出的适用范围。小程序 code 交换、业务 Token 和 WebView Cookie 是各自的会话链。

## 控制与安全对照

验证可信凭据并建立请求上下文，敏感处理器只用这个上下文中的主体。对照例：路由消费已验证的 `ctx.principal.id`；提交表单里的账号字段只用于业务查找。服务端拒绝失效会话，浏览器会话另按部署核对传输与 Cookie 属性。JWT 的通用库名或 Cookie 属性存在只能说明一个控制点。

## 证据与误报

引用入口、验证与绑定、失败退出、敏感消费。上游网关可以是有效认证控制，但需要适用配置或集成证据。公共入口、系统回调和服务身份可能采用另一套可核实的策略。记录适用作用域与缺失条件。

## References

- [OWASP · Authentication](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Authentication_Cheat_Sheet.md)
- [OWASP · Session Management](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Session_Management_Cheat_Sheet.md)
- [OWASP · REST Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/REST_Security_Cheat_Sheet.md)
- [Express · 中间件与挂载](https://expressjs.com/en/guide/using-middleware/)
- [Express · 错误处理](https://expressjs.com/en/guide/error-handling/)
- [微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/e5dc50ccea71e7999a8aa8a942a6f68045e141ca/types/wx/lib.wx.api.d.ts)
- [版本、许可证及改写说明](../SOURCES.md)
