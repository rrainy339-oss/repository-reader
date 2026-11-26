# SQL 注入的查询结构与参数绑定

任务涉及 SQL 查询、原生查询、ORM raw 或可配置排序筛选时。

## 安全属性与成立条件

数据库接收的查询结构必须符合为该操作认可的语法。风险来自不可信值被当作查询结构解析。审查时要区分值绑定、标识符和动态语句片段，以及最终接收者到底是 SQL 驱动、ORM 还是普通格式化器。

## 源码调查

定位查询执行处和所用驱动版本。向上确认模板、值数组和可变片段分别来自哪里。对包装器、条件筛选、动态排序和存储过程，阅读决定语句结构的代码。验证后的值在离开函数时是否仍为同一个值，结构控制是否作用于目标驱动。

## 控制与安全对照

以支持 `$1` 占位符的驱动为例，`db.query('SELECT name FROM products WHERE id = $1', [id])` 将值单独绑定。标识符和排序方向适合通过有限的服务端枚举映射选择固定表达式。手写转义和模糊正则需要结合驱动、编码及语境核实。数据库最小权限限制后果。

## 证据与误报

引用外部值的来源、实际模板或参数构造、执行 API 和相关控制。ORM 普通条件查询、固定语句、独立值绑定及安全构造器都可能否定所猜测的语义。仅有规则命中或形似查询的字符串不足以形成结论。

## References

- [OWASP · SQL Injection Prevention](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.md)
- [CodeQL · js/sql-injection](https://github.com/github/codeql/blob/f416ee5fd27fe8d82ae70abdeedb7abf856a0152/javascript/ql/src/Security/CWE-089/SqlInjection.ql)
- [版本、许可证及改写说明](../SOURCES.md)
