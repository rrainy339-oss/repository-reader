# 反序列化、对象重建与动态解释

涉及序列化库、自定义还原器、持久化对象或跨系统消息。

## 安全属性与成立条件

来自可变边界的数据只能按该接口批准的形状恢复为数据。需要查证当前解析器、配置或业务回调会恢复类型、执行回调或授予对象原本没有的权限。普通 JSON 解析本身只提供数据结构，后续消费决定安全含义。

## 源码调查

查输入来源、真实性校验、实际解析库与版本、时序和输出对象的消费者。阅读 reviver、类型映射、转换 hook、合并操作和动态调用。只验证外层字段时，必须继续检查嵌套数据是如何解释的。

## 控制、对照与反证

用简单数据格式，运行时验证后将允许字段显式构造成业务对象。对不需要的扩展类型和动态执行能力保持禁用。若接口依赖来源认证，核对完整性验证是否发生在解释之前。引用调用者、解析点、对象还原或后续敏感消费。只解析为普通值、白名单映射或数据来源已受可信约束是可验证反证。

## References

- [OWASP · Deserialization](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Deserialization_Cheat_Sheet.md)
- [MITRE · CWE-502](https://cwe.mitre.org/data/definitions/502.html)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [版本、许可证及改写说明](../SOURCES.md)
