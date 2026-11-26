# 微信云开发的函数身份与数据权限

涉及云函数 exports.main、action、getWXContext 或云数据库时。

## 入口与身份路径

从 `cloudfunctions/**`、项目配置、`exports.main` 或 SDK 注册点找到候选。核对实际触发方式是客户端、HTTP、定时任务还是另一云函数，然后确认当前客户端或 SDK 版本提供哪些可信身份字段。检查 `getWXContext` 结果或经验证的业务会话怎样绑定账户，`event` 字段作为外部参数追踪。用 `action` 分支、处理器映射和共享前置检查确认实际操作。

## 访问控制和数据访问

同一入口可以覆盖读、写、删、批量和管理分支。核对每项资源操作的主体、账户、租户、权限和字段约束。分别查客户端直接访问的数据库规则、云函数调用权限和服务端 SDK 当时使用的身份与环境。部署规则只能在仓库提供对应配置时核实。对 `collection`、`doc`、`where` 以及储存对象读写，确认实际资源范围和过滤应用位置。

## 证据与反证

引用上下文取值、分支、策略及最终查询或持久化范围。`OPENID` 的出现说明一个身份属性的来源，资源授权还要检查。客户端传入资源标识可经严格归属校验，服务端不必把它当身份。函数账号和云规则默认权能随产品、版本和环境而变，缺少资料时记录具体待查配置。

## Action 分发与触发方式

小程序的 `wx.cloud.callFunction` 将 `data` 传入函数的 `event`。CloudBase 的微信接入示例在 `wx-server-sdk` 初始化后于调用期间读取 `cloud.getWXContext()`。检查函数名、环境选择和 `OPENID`/`APPID` 的实际来源。定时、HTTP、管理后台与其他函数可能有不同上下文，需看到各自经过校验的身份建立路径。若 `event.userId` 只是查询参数，仍应证明函数基于可信上下文检验了对该对象的操作关系。

用 `get_file_symbols` 找 `exports.main`，沿注册表或 `switch` 查每个相关 Action 实际调用谁。权限检查可能在入口、Action 内部或服务本身，核对覆盖读、删、批量、管理员分支及失败路径。下面的示意仅用于已确认采用小程序调用上下文的函数，业务服务仍需按订单范围执行授权。

~~~js
exports.main = async (event) => {
  const { OPENID, APPID } = cloud.getWXContext();
  if (!OPENID || !APPID) throw new AuthenticationError();
  if (event.action !== 'order.detail') throw new UnsupportedAction();
  const actor = await accounts.requireMembership({ appId: APPID, openId: OPENID });
  return orders.findVisible(actor, requireOrderId(event.orderId));
};
~~~

## 数据库、存储与服务端权限分别验证

- CloudBase 传统文档型数据库规则中，`auth.openid` 与 `auth.uid` 分别对应不同认证来源。根据真实集合规则核对 `read`、`create`、`update`、`delete` 需要的数据约束。官方示例按可满足规则的条件在客户端 `where` 中选择记录，不能将规则理解为会替任意查询自动补对象过滤。文档的归属字段由谁写、能否更新也要追到源头。PostgreSQL 模式需核对其身份、GRANT 与 RLS，不套用文档型规则。
- 核对数据库和存储最终通过用户 SDK 还是使用函数或管理 SDK 的身份访问。平台对函数的调用资格和函数是否有权代表当前主体执行某项操作分别取证。在源码中找初始化、环境和目标资源。配置只存在于控制台时，以该部署事实未知为结论的一部分。
- 云存储文件 ID 是资源引用。临时 URL 的可用期、签发和具体对象权限分开审查。CloudBase 小程序上传示例区分拥有者规则与公开读，实际是否私有由环境的存储规则决定。从文件业务记录反查 owner、租户、状态和 fileID，再看取得 `getTempFileURL` 的身份。服务端具备签发能力时，要证明它是在检查业务关系后才给当前主体生成链接。数据库私有不能证明同一附件在存储侧不可公开读取。

例如，页面请求订单附件时，引用平台调用资格、函数选择的 Action、业务记录归属、服务端签发位置及环境规则。读取范围许可、客户端直连权限、订单状态和签发后的链接扩散分别记录。批量附件或退款触发函数若还有新的事务和并发条件，按项目具体不变量检查。

## References

- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [腾讯 CloudBase · 小程序云数据库](https://docs.cloudbase.net/recipes/add-database-wechat-miniprogram)
- [腾讯 CloudBase · 云函数访问控制](https://docs.cloudbase.net/cloud-function/security-rules)
- [微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/e5dc50ccea71e7999a8aa8a942a6f68045e141ca/types/wx/lib.wx.api.d.ts)
- [腾讯 CloudBase · 小程序调用云函数](https://docs.cloudbase.net/recipes/add-cloud-function-wechat-miniprogram)
- [腾讯 CloudBase · 云数据库安全规则](https://docs.cloudbase.net/database/security-rules)
- [腾讯 CloudBase · 小程序云存储与文件权限](https://docs.cloudbase.net/recipes/add-file-upload-wechat-miniprogram)
- [版本、许可证及改写说明](../SOURCES.md)
