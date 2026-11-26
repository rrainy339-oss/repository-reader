# 业务逻辑、状态机与幂等性

存在多步骤业务、审批、库存、优惠、计数、批处理或恢复流程。

## 安全属性与成立条件

约束从规范、测试、状态模型和存储约束获得依据。先说明谁能对哪个对象执行什么动作，动作需要哪些前置状态、写入什么后置状态、谁可以观察它。若某项规则只是合理推测，应作为待确认条件。

## 源码调查

阅读真正接收写操作的入口、状态判断、持久化与外部副作用。确认 UI、API、后台任务和管理分支是否遵守相同约定。检查错误回退、异步处理和重复请求时，对资源的角色、租户、额度和状态是否一致。服务端派生值与客户端呈现值需要分别追踪。

## 控制、证据与反证

正例由服务端执行明确的状态转换，资源范围和旧状态在写入条件中核验。业务定义要求幂等时，核对幂等键与范围的绑定和实际重复结果。引用规范、处理器、前置条件、写入与重试边界。显式授权的管理操作、维护流程或不同对象状态可缩小观察范围。

## 从多入口提取同一个领域约束

在涉及审批、配额、优惠或补偿的任务中用「账目、参与者、状态、时点」描述约束。例如，源码规定每个已批准的退款申请至多记账一次，则要区分申请 ID、消息 ID、商户订单号与部分退款。用符号工具定位控制器、任务消费者和仓储，再读迁移里的唯一键和事件的提交边界。对于计数，核对统计对象、时间窗、单位和已撤销状态。对服务端从目录读取价格但随后使用另一字段结算的路径，要追踪实际收费值。

审批案例中，管理路由调用 `approval.approve`。定时恢复任务直接调用 `approval.finalize`。查 `finalize` 是否检查审批人、状态和目标版本，是否只在已有审批记录下可达，缺少记录时是否仍触发提交。双人审批要求须从本项目的规则或测试中找到适用依据。不能单凭方法名推定。两个入口复用带状态条件的写入、且依赖约束阻止重复记账时，应作为反证。若数据库数量受限但通知可重复，只在项目把重复通知视为受保护的不变量时继续判断。对尚无规则的多次提交或部分成功，保留业务假设。

## References

- [OWASP · Business Logic Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Business_Logic_Security_Cheat_Sheet.md)
- [OWASP WSTG v4.2 · 业务数据验证](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/10-Business_Logic_Testing/01-Test_Business_Logic_Data_Validation/)
- [OWASP WSTG v4.2 · 完整性检查](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/10-Business_Logic_Testing/03-Test_Integrity_Checks/)
- [Trail of Bits Skills · FUNCTION_MICRO_ANALYSIS_EXAMPLE.md](https://github.com/trailofbits/skills/blob/149d7b21f4067765b82e67029730b42d228ef4b4/plugins/audit-context-building/skills/audit-context-building/resources/FUNCTION_MICRO_ANALYSIS_EXAMPLE.md)
- [版本、许可证及改写说明](../SOURCES.md)
