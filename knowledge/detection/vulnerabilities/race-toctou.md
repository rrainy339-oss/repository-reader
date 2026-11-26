# 竞争条件与检查到使用不一致

任务涉及异步更新、文件检查后使用、任务重试、计数或资金状态转换。

## 安全属性与成立条件

约束在副作用提交时仍须成立。候选问题应能说明检查依据的是可在提交前变化的共享状态，并且缺少覆盖相同资源的有效一致性机制。异步函数或存在 `await` 本身只表明有时序边界。

## 源码调查

找读与写之间的控制，审查条件更新、唯一键、事务隔离级别、锁持有范围及幂等键生命周期。确认进程内锁在实际部署是否覆盖同一共享资源，写失败或条件不满足时后续副作用如何处理。对文件区分验证路径和最终使用的对象。

## 控制、证据与反证

对照例在数据库中提交带旧状态约束的单操作更新，并根据受影响记录决定是否继续。涉及多个外部副作用时核对持久化一致性边界与重试方案。引用资源、检查、提交点、实际并发覆盖和预计后果。单写者、数据层约束、有效事务或绑定同一受保护对象的机制都需要考虑。

## 确认竞争的状态和原子边界

用 `search_text` 查状态名、余额字段、唯一索引和队列主题，列出处理此状态的请求、定时任务、回调和重试。标出独立可交错的读取、变更与效果，查找保持不变量的数据库谓词或锁范围。多个 `await` 只能标出可能让渡的位置。若被保护对象彼此独立，或所有修改者受同一原子约束，则不支持假设。进程内互斥能否覆盖任务取决于实例、进程和共享状态的范围。事务封装器要确认所有仓储操作使用同一客户端，异常会回滚，以及外部消息是否等待提交。

~~~sql
UPDATE orders
SET state = 'reserved'
WHERE id = $1 AND tenant_id = $2 AND state = 'pending'
RETURNING id;
~~~

PostgreSQL 在 Read Committed 中遇到已被并发事务更新的目标行时，会在特定提交情形下对更新后的行重新检查 `WHERE`。此模式支持单行状态转换的前提包括使用该驱动、身份谓词正确、仅在返回行时排队，以及其他路径也遵守待处理约束。跨行总量或「不存在某行」需要另查锁、约束或隔离级别及重试语义。代码已开启事务但使用独立连接写审计表、提前发消息或忽略更新行数，仍应分别分析观察到的提交边界。文件竞态则核对检查的是路径还是已打开句柄，以及路径所在目录是否真的可变。

## References

- [MITRE · CWE-367](https://cwe.mitre.org/data/definitions/367.html)
- [OWASP WSTG v4.2 · 业务数据验证与完整性](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/10-Business_Logic_Testing/03-Test_Integrity_Checks/)
- [OWASP · Business Logic Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Business_Logic_Security_Cheat_Sheet.md)
- [PostgreSQL · Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-READ-COMMITTED)
- [Node.js · File system（22.x）](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- [版本、许可证及改写说明](../SOURCES.md)
