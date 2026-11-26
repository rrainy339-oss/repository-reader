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

## 从对象选择追到操作

- **读取、修改和批次的约束位置不同。** 读取需要核对响应或下载的是哪条记录。修改需要看真正的更新谓词与受影响行数。批处理要确认每个对象均落入主体的授权范围及失败如何提交。批次允许部分成功还是必须全量授权，需要项目规则支撑。
- **先还原主体与域。** 控制器里的 `req.user` 可能来自网关、中间件或适配器。用 `get_file_symbols` 看路由、服务和仓储，在实际装配处确认注入过程。租户如可由请求选择，要另外证明会话主体有该租户的成员关系。管理员与委托访问应核对动作、租户和对象范围，与普通用户的路径分开读。
- **资源授权可以落在仓储。** 按 ID 读取本身可以是服务内部步骤。如果写入按同一个主体的 `tenantId` 和角色约束重查，且未在检查前返回内容或产生效果，应作为反证。若数据库 RLS 是控制，核对迁移中的策略、运行连接角色、主体注入和对象操作。仅看到 RLS 声明无法确定当前执行角色和生产环境确实受其约束。

~~~ts
async function readInvoice(ctx: VerifiedContext, invoiceId: InvoiceId) {
  return invoices.findVisible({
    id: invoiceId,
    tenantId: ctx.membership.tenantId,
    viewerId: ctx.principal.id,
  });
}
~~~

继续读 `findVisible`，确认租户和可见关系都进入同一查询，并且序列化用的是该查询返回的发票。若列表受租户约束，而详情在独立路由里以不同仓储调用读取并直接返回，列表约束不适用于这一分支。还应读实际挂载与数据库策略。候选需要受保护对象、可达主体、实际动作、项目要求，以及缺少有效的同对象授权的源码。

## References

- [OWASP · Authorization](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Authorization_Cheat_Sheet.md)
- [OWASP · REST Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/REST_Security_Cheat_Sheet.md)
- [MITRE · CWE-862](https://cwe.mitre.org/data/definitions/862.html)
- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [OWASP WSTG v4.2 · 访问控制](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/05-Authorization_Testing/02-Testing_for_Bypassing_Authorization_Schema/)
- [版本、许可证及改写说明](../SOURCES.md)
