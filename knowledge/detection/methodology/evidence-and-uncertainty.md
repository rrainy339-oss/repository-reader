# 源码证据、反证与不确定性

证据来自不同文件、存在规则命中、源码不足或准备移交 Validator 时。

## 证据如何成立

`read_lines` 与 `get_symbol_code` 返回本轮实际展示的源码行。分页时按 `nextCursor.line` 和 `nextCursor.column` 续读，只有完整展示、落在一次读取范围内且文件内容仍一致的行可引用。模型输出提交 `path/startLine/endLine`，宿主附加文件 SHA-256。源码知识文档、Semgrep 命中、地图、搜索预览和其他任务的旧引用可用于定位。

## 报告结构

- 对每项 `expectedEvidence`，用原有从 1 起的 `index` 记录 `addressed` 或 `unresolved`。每项观察应对应可核验范围，且解释行中的实际语义。必要时多条证据分别支持入口、绑定、控制和副作用。
- `candidates` 区分源码支持的现象、待确认的业务规则、反证及问题。`evidenceIds`、`counterevidenceIds` 和 `leads` 只用本轮已经得到的有效证据 ID。控制不存在难以用空搜索断言，引用已覆盖的处理器、包装器、策略和可见边界。
- `no_issue_observed` 描述已审查范围。缺少服务端、调用关系或政策来源时注明具体缺口。Validator 会独立重读，支持结论需要可追溯的适用规则，知识库不能替代仓库规范或维护者确认。

## 静态线索的反证

规则可能按语法、库模型或启发式匹配，警告级别和规则置信度不能解释项目行为。核对实际调用点和依赖包装器，以及参数是否来自可信来源。记录版本、部署或运行时缺口，给出源文件层面的下一项核对事项。

例如路径规则可能在路径构造处标记匹配，实际文件操作及授权还需读取对应消费者。框架相关规则的适用性取决于它能识别的处理器和库。CodeQL 将本地传播、跨调用传播与阻断条件建模，源码复核时可借用这些概念，结论以读到的绑定、检查作用的具体值和实际消费为准。

## 让证据支撑确切论断

把论断拆成适用规则、可达入口、实际对象、关键控制、可观察副作用。每条 `observation` 对应本轮工具实际展示的完整源码行范围，优先选能说明哪一个实参、谓词或提交分支的行范围。长行或符号分页返回下一位置时继续阅读，尚未显示完整的部分保留为缺口。跨文件的关系由两侧源码共同支持，记录导入、注册或调用位置和对应实现。外部 API 契约注明适用版本。库手册和检测规则均不能登记成目标仓库的源码证据。

举例说，支付通知入口调用 `settle(order, event)`，源码已经显示验签通过才进入服务。若结算服务在另一个未提供的包中，可记录入口的成功守卫及传入的订单字段，归属一致性与幂等提交留作未知。若读到了服务端按商户与订单联合查找、只在成功状态变更后写入履约记录，分别引用这两处代码作为相关假设的反证。对同一包下的另一个路由，必须重新确认绑定和守卫覆盖。

## 处理工具提示和相反信息

结构规则可能仅看到动态属性、进程 API 或路由参数形状。先确认规则匹配的是 API 形状还是建模的数据路径，再按实际导入、运行时选项、控制和副作用逐项核实。命中时可有固定服务目标、严格输出投影、受限对象字典等有效控制。未命中时仍需考虑包装器、间接调用、平台生成规则和未检索目录。缺少部署配置、锁文件或真实函数体时，把需要核实的事实写成可回答的问题，例如「生产云函数是否使用此账号初始化服务端 SDK」，比「可能有权限问题」更便于 Validator 验证。

同一份输出可以包含已观察实现、条件性解释和开放问题。若保护覆盖可见路径，说明适用入口及仍未覆盖的外部路径。若问题需要未确认的可达性、版本或业务规则才能成立，把该条件放入 `unresolved`。

## References

- [Trail of Bits Skills · SKILL.md](https://github.com/trailofbits/skills/blob/149d7b21f4067765b82e67029730b42d228ef4b4/plugins/static-analysis/skills/semgrep/SKILL.md)
- [OWASP · Secure Code Review](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Secure_Code_Review_Cheat_Sheet.md)
- [CodeQL · JavaScript 和 TypeScript 数据流指南](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)
- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [版本、许可证及改写说明](../SOURCES.md)
