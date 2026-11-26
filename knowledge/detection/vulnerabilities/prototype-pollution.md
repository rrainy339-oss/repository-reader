# 原型污染、字典属性与安全决策

存在深合并、动态对象路径、配置选项或根据继承值作权限判断时。

## 安全属性与成立条件

外部结构只改变该输入接口允许的字段和对象。对于原型类问题，需要区分普通自有字段写入、原型相关语义，以及后续读取是否影响业务或安全控制。单独看到任意键写入不足以判定影响。

## 源码调查

阅读动态键来源、合并策略、目标对象类型、递归层级和字段限制。检查依赖版本及选项。安全决策端辨别读取的是经验证的自有属性、默认值还是继承属性。分析映射与解构时核对是否把原始对象重新传入后续路径。

## 控制、对照与反证

按 schema 选择已知字段并创建单独的业务对象。若需要无结构字典，考虑 `Map`，或在适用边界使用无原型字典及确认自有属性。引用实际写入、对象可见性和安全相关消费处。固定键、有效嵌套 schema、隔离字典或真正无继承的读取可构成反证。

## References

- [MITRE · CWE-1321](https://cwe.mitre.org/data/definitions/1321.html)
- [MITRE · CWE-915](https://cwe.mitre.org/data/definitions/915.html)
- [Semgrep · prototype-pollution-assignment.yaml](https://github.com/semgrep/semgrep-rules/blob/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/javascript/lang/security/audit/prototype-pollution/prototype-pollution-assignment.yaml)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [版本、许可证及改写说明](../SOURCES.md)
