# NoSQL 查询对象与操作符边界

MongoDB、云数据库或其他文档查询使用外部对象、动态过滤或更新字段时。

## 安全属性与成立条件

不可信输入在有明确数据结构的查询接口中只能占用允许的值或有限字段。候选需要证明调用者对实际执行的过滤、更新或表达式结构有不符合预期的影响。不同数据库和驱动的对象语义不能互相替代。

## 源码调查

跟踪请求解析的原始类型，包括对象、数组、空值和默认值，再读构造过滤或更新的代码。区分固定字段中的值、动态键、传播整个对象和驱动解释的操作符。确认 schema 是否真的执行，是否限制嵌套字段，以及校验结果是否传给最终客户端。对云数据库阅读SDK实际对象与权限范围。

## 控制、证据与反证

正例以经过运行时检查的字符串 ID 构造固定查询字段，再由服务端补入已验证的租户范围。归属控制和查询结构控制分别取证。记录解码、过滤对象构造、驱动/API 和相关控制。强制标量、服务端固定对象形状和不解释查询操作符的 API 可提供反证。仅凭对象传入查询或 TypeScript 类型注解无法判断风险。

## References

- [OWASP · NoSQL Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/NoSQL_Security_Cheat_Sheet.md)
- [OWASP · Input Validation](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Input_Validation_Cheat_Sheet.md)
- [CodeQL · js/sql-injection](https://github.com/github/codeql/blob/f416ee5fd27fe8d82ae70abdeedb7abf856a0152/javascript/ql/src/Security/CWE-089/SqlInjection.ql)
- [腾讯 CloudBase · 小程序云数据库](https://docs.cloudbase.net/recipes/add-database-wechat-miniprogram)
- [腾讯 CloudBase · 云函数访问控制](https://docs.cloudbase.net/cloud-function/security-rules)
- [版本、许可证及改写说明](../SOURCES.md)
