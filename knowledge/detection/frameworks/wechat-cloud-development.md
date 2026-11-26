# 微信云开发的函数身份与数据权限

涉及云函数 exports.main、action、getWXContext 或云数据库时。

## 入口与身份路径

从 `cloudfunctions/**`、项目配置、`exports.main` 或 SDK 注册点找到候选。核对实际触发方式是客户端、HTTP、定时任务还是另一云函数，然后确认当前客户端或 SDK 版本提供哪些可信身份字段。检查 `getWXContext` 结果或经验证的业务会话怎样绑定账户，`event` 字段作为外部参数追踪。用 `action` 分支、处理器映射和共享前置检查确认实际操作。

## 访问控制和数据访问

同一入口可以覆盖读、写、删、批量和管理分支。核对每项资源操作的主体、账户、租户、权限和字段约束。分别查客户端直接访问的数据库规则、云函数调用权限和服务端 SDK 当时使用的身份与环境。部署规则只能在仓库提供对应配置时核实。对 `collection`、`doc`、`where` 以及储存对象读写，确认实际资源范围和过滤应用位置。

## 证据与反证

引用上下文取值、分支、策略及最终查询或持久化范围。`OPENID` 的出现说明一个身份属性的来源，资源授权还要检查。客户端传入资源标识可经严格归属校验，服务端不必把它当身份。函数账号和云规则默认权能随产品、版本和环境而变，缺少资料时记录具体待查配置。

## References

- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [腾讯 CloudBase · 小程序云数据库](https://docs.cloudbase.net/recipes/add-database-wechat-miniprogram)
- [腾讯 CloudBase · 云函数访问控制](https://docs.cloudbase.net/cloud-function/security-rules)
- [微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/e5dc50ccea71e7999a8aa8a942a6f68045e141ca/types/wx/lib.wx.api.d.ts)
- [版本、许可证及改写说明](../SOURCES.md)
