# 业务逻辑、状态机与幂等性

存在多步骤业务、审批、库存、优惠、计数、批处理或恢复流程。

## 安全属性与成立条件

约束从规范、测试、状态模型和存储约束获得依据。先说明谁能对哪个对象执行什么动作，动作需要哪些前置状态、写入什么后置状态、谁可以观察它。若某项规则只是合理推测，应作为待确认条件。

## 源码调查

阅读真正接收写操作的入口、状态判断、持久化与外部副作用。确认 UI、API、后台任务和管理分支是否遵守相同约定。检查错误回退、异步处理和重复请求时，对资源的角色、租户、额度和状态是否一致。服务端派生值与客户端呈现值需要分别追踪。

## 控制、证据与反证

正例由服务端执行明确的状态转换，资源范围和旧状态在写入条件中核验。业务定义要求幂等时，核对幂等键与范围的绑定和实际重复结果。引用规范、处理器、前置条件、写入与重试边界。显式授权的管理操作、维护流程或不同对象状态可缩小观察范围。

## References

- [OWASP · Business Logic Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Business_Logic_Security_Cheat_Sheet.md)
- [OWASP WSTG v4.2 · 业务数据验证与完整性](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/10-Business_Logic_Testing/03-Test_Integrity_Checks/)
- [Trail of Bits Skills · FUNCTION_MICRO_ANALYSIS_EXAMPLE.md](https://github.com/trailofbits/skills/blob/149d7b21f4067765b82e67029730b42d228ef4b4/plugins/audit-context-building/skills/audit-context-building/resources/FUNCTION_MICRO_ANALYSIS_EXAMPLE.md)
- [版本、许可证及改写说明](../SOURCES.md)
