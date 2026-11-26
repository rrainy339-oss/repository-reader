# NoSQL 查询对象与操作符边界

MongoDB、云数据库或其他文档查询使用外部对象、动态过滤或更新字段时。

## 安全属性与成立条件

不可信输入在有明确数据结构的查询接口中只能占用允许的值或有限字段。候选需要证明调用者对实际执行的过滤、更新或表达式结构有不符合预期的影响。不同数据库和驱动的对象语义不能互相替代。

## 源码调查

跟踪请求解析的原始类型，包括对象、数组、空值和默认值，再读构造过滤或更新的代码。区分固定字段中的值、动态键、传播整个对象和驱动解释的操作符。确认 schema 是否真的执行，是否限制嵌套字段，以及校验结果是否传给最终客户端。对云数据库阅读SDK实际对象与权限范围。

## 控制、证据与反证

正例以经过运行时检查的字符串 ID 构造固定查询字段，再由服务端补入已验证的租户范围。归属控制和查询结构控制分别取证。记录解码、过滤对象构造、驱动/API 和相关控制。强制标量、服务端固定对象形状和不解释查询操作符的 API 可提供反证。仅凭对象传入查询或 TypeScript 类型注解无法判断风险。

## 按驱动解释查询对象

MongoDB Node 驱动将传入的过滤文档解释为匹配条件，固定字段上的标量值与含运算语义的对象在运行时含义不同。还要区分 `find`/`findOne` 的过滤、聚合管道各 stage、更新的筛选条件与更新文档。即便过滤器正确，未经授权的更新字段可能属于对象属性授权问题。Mongoose 查询执行时按 schema 路径 casting。在支持的版本，`strictQuery` 可丢弃未声明字段，结果可能变为空过滤，具体须读配置和空查询处理。`sanitizeFilter` 对含操作符属性的嵌套对象有专门处理，核对版本、是否在本次查询启用及 `trusted` 的使用。它的过滤行为不能推出任意聚合或更新语句都接受了相同保护。

~~~ts
async function memberByHandle(ctx: VerifiedContext, value: unknown) {
  const handle = handleSchema.parse(value); // Schema 输出原始字符串
  return members.findOne({ tenantId: ctx.tenantId, handle: { $eq: handle } });
}
~~~

这里需要核实 schema 的输出和查询的实际导入。若请求适配器返回对象，而服务直接将其作为 filter 或与租户谓词合并后交给驱动，追踪合并顺序、运行时形状及驱动对该位置的解释。CodeQL 的 NoSQL 模型区分普通污点与对象污点。用这个区别指导人工读出受影响的是整个结构还是固定字段的标量。CloudBase `db.command` 是另一套 API，须核对其实际 SDK 所支持的谓词构造，把服务端显式创建的运算条件与来源未知的对象分开。规则命中或库用法只能提示方向，候选应有可达入口、受控结构、查询解释与超出预期的结果范围。

## References

- [OWASP · NoSQL Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/NoSQL_Security_Cheat_Sheet.md)
- [OWASP · Input Validation](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Input_Validation_Cheat_Sheet.md)
- [CodeQL · NoSQL 专项数据流模型](https://github.com/github/codeql/blob/f416ee5fd27fe8d82ae70abdeedb7abf856a0152/javascript/ql/lib/semmle/javascript/security/dataflow/NosqlInjectionQuery.qll)
- [MongoDB Node Driver · Query documents](https://www.mongodb.com/docs/drivers/node/current/crud/query/query-document/)
- [Mongoose · Query Casting](https://mongoosejs.com/docs/tutorials/query_casting.html)
- [Mongoose · sanitizeFilter](https://mongoosejs.com/docs/api/mongoose.html#Mongoose.prototype.sanitizeFilter())
- [腾讯 CloudBase · 小程序云数据库](https://docs.cloudbase.net/recipes/add-database-wechat-miniprogram)
- [版本、许可证及改写说明](../SOURCES.md)
