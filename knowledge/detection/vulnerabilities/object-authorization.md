# 对象级、角色级与租户授权

读取、修改、删除、批量处理或导出使用外部资源 ID 时。

## 安全属性与成立条件

服务端按照经认可的策略约束主体对目标资源的动作。资源 ID 来自请求属于正常接口设计，关键是作用于该资源的操作是否受主体、租户、角色与共享政策限制。缺少业务策略时，将合理边界标为待确认的要求。

## 源码调查

阅读主体的可信来源、资源选择和实际查询或写入条件。区分“拥有该资源”“可以读”和“可以改”。如果策略位于共享服务、查询范围或云规则，确认本次入口、操作和全部对象经过它。批量请求要确认约束覆盖每个资源。核对失败分支是否停止副作用。

## 控制与安全对照

示例使用示意查询 `records.findOne({ id, tenantId: principal.tenantId })`，其中 `principal` 由可信验证建立。租户过滤只能证明租户边界，同租户私有资源还需要项目实际规定的所有权或共享规则。管理权限的例外应由政策明确限定。

## 证据与误报

引用入口、主体、策略、资源范围与实际副作用。上游强制授权、存储层租户策略和限定共享资源都可能提供反证。未定位策略时不能由可见字段名断言越权；移交时说明最小待查策略和路径。

## References

- [OWASP · Authorization](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Authorization_Cheat_Sheet.md)
- [OWASP · REST Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/REST_Security_Cheat_Sheet.md)
- [MITRE · CWE-862](https://cwe.mitre.org/data/definitions/862.html)
- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [版本、许可证及改写说明](../SOURCES.md)
