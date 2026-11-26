# 业务规则、根因与同类代码复核

同一政策覆盖多个入口，或需要判断相似代码是否应另立待查项时。

## 确认规则和适用范围

按主体、资源、动作、租户或角色及当前状态描述约束。查需求、项目规范、路由约定、存储约束和用例。区分明确的租户隔离与业务允许的共享，区分既有规范与待确认的推导。涉及金额、状态或跨步骤操作时，列出权威字段来源、允许的前后状态和写入位置。

## 根因与相邻代码

对已经有依据的控制问题，描述约束由哪一层负责、为什么当前实现不能保证它。若仓库中存在共用控制模块或重复业务模板，可以用索引或字面搜索定位相邻实现，逐处核对是否采用同一政策及控制版本。代码形似、共享依赖或同一命中规则都只提供待查范围。对不同业务授权、字段与作用域分别记录。

## 反证与移交

先寻找可支持实现的例外，例如管理员策略、状态机规则、查询内的归属过滤或数据库约束。若缺少策略或另一个处理器，只提交需要读取哪个位置的关联问题。Detection 将这些问题放进 `leads`，每个线索绑定实际核验过的源码证据。范围外的相邻代码保留为待查，不扩写成当前任务的结论。

## References

- [Trail of Bits Skills · root-cause.md](https://github.com/trailofbits/skills/blob/149d7b21f4067765b82e67029730b42d228ef4b4/plugins/variant-analysis/skills/variant-analysis/references/root-cause.md)
- [OWASP · Secure Code Review](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Secure_Code_Review_Cheat_Sheet.md)
- [OWASP WSTG v4.2 · 业务数据验证与完整性](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/10-Business_Logic_Testing/03-Test_Integrity_Checks/)
- [MITRE · CWE-862](https://cwe.mitre.org/data/definitions/862.html)
- [版本、许可证及改写说明](../SOURCES.md)
