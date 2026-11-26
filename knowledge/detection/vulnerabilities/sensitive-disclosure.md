# 敏感信息暴露与硬编码凭据

任务涉及日志、异常、响应映射、构建常量、源代码中的凭据或客户端缓存。

## 安全属性与成立条件

只有获准接收者和必要的处理环节可以看到敏感字段。硬编码值需要结合用途、有效环境、分发范围和引用位置判断。常量名、格式或扫描标签本身只是敏感线索。

## 源码调查

定位数据持有处和可见输出，例如响应 DTO、异常、日志对象、客户端打包配置、存储和下载。追踪实际字段选择、脱敏顺序及错误回退。区分服务端环境变量的名称、实际值、公开的应用 ID、测试数据和需要保密的凭据。检查同一内容是否在其他边界被再次序列化。

## 控制、证据与误报

正例显式选择允许返回的字段，日志在写入前结构化脱敏，密钥由适用的服务端配置提供且不随客户端包分发。记录字段角色、来源、暴露点和受众，不在结论复制凭据值，也不尝试向服务证明其有效。测试占位、只限已授权系统的日志、确实省略字段的 DTO 或运行时注入可以限制猜测。

## 核对实际可见表示

沿记录、DTO、序列化、响应或日志输出确认最终字段。仓储取全列不一定对外泄露，如果控制器只返回显式允许的字段。调试接口或异常处理可能直接序列化 ORM 对象、请求 headers 或上传元信息。审查日志级别、结构化 logger 的子级 redaction、错误因果链及收集端可见范围。配置文件中有脱敏键需要与实际 logger 初始化关联。前端读取配置项用于显示与构建过程将密钥内联到发布包是不同路径。

例如，`memberStore` 返回完整记录，`toPublicMember` 构造 `{ id, displayName }`，随后视图使用 DTO。查同一 fetch 是否还流向错误响应、下载、WebView 与客户端缓存，并确认这些路径的消费者。仅命中 `TOKEN` 字段时，写清看到的是环境变量名、占位符还是实际凭据。审计输出中避免原值。若嵌入确切敏感信息但部署可见范围未知，分别报告源码事实与待核实范围。

## References

- [OWASP · Logging](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Logging_Cheat_Sheet.md)
- [OWASP · Secrets Management](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Secrets_Management_Cheat_Sheet.md)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [版本、许可证及改写说明](../SOURCES.md)
