# 竞争条件与检查到使用不一致

任务涉及异步更新、文件检查后使用、任务重试、计数或资金状态转换。

## 安全属性与成立条件

约束在副作用提交时仍须成立。候选问题应能说明检查依据的是可在提交前变化的共享状态，并且缺少覆盖相同资源的有效一致性机制。异步函数或存在 `await` 本身只表明有时序边界。

## 源码调查

找读与写之间的控制，审查条件更新、唯一键、事务隔离级别、锁持有范围及幂等键生命周期。确认进程内锁在实际部署是否覆盖同一共享资源，写失败或条件不满足时后续副作用如何处理。对文件区分验证路径和最终使用的对象。

## 控制、证据与反证

对照例在数据库中提交带旧状态约束的单操作更新，并根据受影响记录决定是否继续。涉及多个外部副作用时核对持久化一致性边界与重试方案。引用资源、检查、提交点、实际并发覆盖和预计后果。单写者、数据层约束、有效事务或绑定同一受保护对象的机制都需要考虑。

## References

- [MITRE · CWE-367](https://cwe.mitre.org/data/definitions/367.html)
- [OWASP WSTG v4.2 · 业务数据验证与完整性](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/10-Business_Logic_Testing/03-Test_Integrity_Checks/)
- [OWASP · Business Logic Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Business_Logic_Security_Cheat_Sheet.md)
- [Node.js · Child process](https://nodejs.org/api/child_process.html)
- [版本、许可证及改写说明](../SOURCES.md)
