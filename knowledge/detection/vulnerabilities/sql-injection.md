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

## 驱动参数、标识符与延迟执行

- node-postgres 的 `query(text, values)` 与配置对象 `query({ text, values })` 将查询文本与值分别传递。占位参数无法用作表名、列名、排序方向等 SQL 语法。MySQL2 `execute(sql, values)` 使用预执行语句。审查 `query` 时需结合驱动 API 和适配器确认实际构造方式。以锁定的驱动版本及最终调用为准。
- Java JDBC 的 `PreparedStatement` 在 `prepareStatement` 接收 SQL 文本，`setString` 等 setter 后置绑定值。源码里的 `PreparedStatement` 类型只能证明使用了这一接口，仍要回到构造语句，确认没有把受外部影响的 SQL 片段提前写入文本。复用同一语句时还可检查是否每次执行都绑定了业务需要的参数。
- ORM 链式查询按受支持接口绑定值时，有效控制来自该实现。需要另读 `raw` 方法、查询 builder 的表达式入口、标识符、排序和自定义片段的绑定。对于多个合法排序方式，受信枚举到固定表达式的映射可以作为反证，前提是映射后的表达式才被执行。类型断言、限制长度或 SQL 名称转义对语法位置与值位置的保障各不相同。
- 入库前安全绑定的字段以后可能被报表或任务当作 SQL 表达式，读第二次消费路径。对于存储过程，参数绑定保护应用调用该过程的语法。若过程内部构造动态 SQL，就需要过程定义和实际参数。只在测试快照或日志出现的 SQL 字符串也要核对有无生产执行。

~~~ts
export const listCustomerOrders = (db: Db, tenantId: string, customerId: string) =>
  db.query({
    text: 'SELECT id, state FROM orders WHERE tenant_id = $1 AND customer_id = $2',
    values: [tenantId, customerId],
  });
~~~

在控制器、仓储和 `db` 装配处核对实际导入。若包装器仍将模板与值分开交给驱动，这支持值在当前语法位置安全。需要深入审查的情形是输入从另一层进入 `text` 或 raw 语法表达式，即使同一调用还绑定了其他参数。候选要指出实际解释的 SQL 位置、字段来源、运行查询路径和有效防御缺口。对象归属缺失需要按授权规则另行分析。

## References

- [OWASP · SQL Injection Prevention](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.md)
- [CodeQL · js/sql-injection](https://github.com/github/codeql/blob/f416ee5fd27fe8d82ae70abdeedb7abf856a0152/javascript/ql/src/Security/CWE-089/SqlInjection.ql)
- [node-postgres · Parameterized query](https://node-postgres.com/features/queries#parameterized-query)
- [MySQL2 · Prepared Statements](https://sidorares.github.io/node-mysql2/docs/documentation/prepared-statements)
- [Oracle JDBC · Using Prepared Statements](https://docs.oracle.com/javase/tutorial/jdbc/basics/prepared.html)
- [版本、许可证及改写说明](../SOURCES.md)
