# 陌生仓库与跨文件源码阅读

入口只有地图记录、存在同名定义、跨文件目标不明时。

## 可选阅读路径

地图、任务起点和入口索引用于定位。先找到任务涉及的操作及入口文件，阅读入口注册、绑定、分派和关键调用周围的代码。`query_entries` 可按 `entryId` 或 `kind` 查看索引候选。`query_map` 仅在提供地图时可用。调用环境未在仓库中出现时，写明从哪个可见入口开始观察。

- `get_file_symbols(filePath)` 适合查看长文件结构。`search_symbols(name, scope, kind)` 可缩小候选定义，用 `get_symbol_code(symbolId)` 阅读定义本身。定义同名时，以导入来源、别名、接收者初始化及导出成员为依据。
- 对回调、动态成员、工厂返回值或局部遮蔽，优先阅读赋值与注册位置。可以用 `search_text(query, scope)` 搜索导入字符串、限定成员名、路由字面量或注册函数。它是区分大小写的字面搜索，使用 `nextCursor` 续查。符号搜不到时仍可浏览目录和直接阅读文件。
- 调用关系通常需要两侧证据。记录调用表达式上哪个实参绑定到被调用函数哪个参数，哪个返回值被继续消费。若包装器只传递引用，阅读调用者使用该引用的位置。

## 反证与输出

仓库中存在同名方法、测试替身、替代入口或未部署的实现时，按当前任务区分不同作用域。只读到调用点时，可以描述可见调用和缺少的定义。动态目标、生成代码和实际部署配置缺失时保留待查项；引用使用本轮完整读取的文件行范围。

## 把函数读成调用契约

当任务的关键操作藏在短包装器中，用 `get_symbol_code` 阅读调用者和被调用者，分别记下显式参数、隐式输入（闭包、`this`、环境开关、事务句柄）、成功与失败返回值、写入和队列等外部效果。对调用者依赖的性质，直接阅读提供该性质的函数。例如，`loadActiveMembership` 的名字只能定位定义。如果它从软删除表加载记录，读出角色字段仍不足以证明成员有效。需要同时核实查询的状态谓词、调用者何时检查结果和无记录分支。若符号返回分页，继续读取影响结论的分支。对分段行用 `read_lines` 的续读位置，完整显示的行方可引用。

## 补全绑定和派发

- 导入别名或 barrel 文件出现时，从调用文件的 `import` 或 `require` 定位所导入的模块，再追踪 `export { … } from`、`module.exports` 与工厂实例。索引里的同名函数只有定位价值。若实际绑定涉及 `tsconfig` 路径别名、构建器配置或 `package.json#exports` 的条件分支，需要读生产入口和配置。`paths` 存在本身无法证明部署运行时会按它解析。
- 对路由装配、Action 表、适配器和依赖注入，追踪注册点、构造器参数及部署选择条件。`search_symbols` 可尽快找到候选，`search_text` 以文件或目录为 `scope` 查导入名、注册调用、路由字符串或导出名。搜索是区分大小写的字面匹配，分支中更换了别名或拼写时，换成实际出现的字面值并分页。配置生成、动态组合或索引缺失时，可用 `list_files` 找启动、构建、函数部署目录，再读配置、生成器和调用者。完整构建产物缺失时，把部署绑定留作未知。
- 对回调、闭包和依赖包装器，找真正调用它的位置和传入值。例如 `makeHandler(policy)` 的声明只说明函数接收策略，实际约束来自注册点传入的实例、实例配置，以及包装器如何等待策略结果。

## 云函数中的同名订单处理器

入口 `cloudfunctions/orders/index.js` 从 `./handlers` 导入 `actions`，经 `exports.main` 依据 Action 选择处理器。符号搜索同时返回订单和后台管理代码中的 `getOrder`。先读 `./handlers/index.js` 的导出和注册表，确认客户端可到达的对象。再读订单服务内 `findVisibleOrder` 和确切数据库谓词。若生产配置还根据环境加载私有模块，结论仅覆盖仓库可确认的绑定。记录已读的入口、注册表、策略与写入位置，说明哪条动态边缺失了模块或选择条件。

## References

- [Trail of Bits Skills · FUNCTION_MICRO_ANALYSIS_EXAMPLE.md](https://github.com/trailofbits/skills/blob/149d7b21f4067765b82e67029730b42d228ef4b4/plugins/audit-context-building/skills/audit-context-building/resources/FUNCTION_MICRO_ANALYSIS_EXAMPLE.md)
- [CodeQL · JavaScript 和 TypeScript 数据流指南](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)
- [OWASP · Secure Code Review](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Secure_Code_Review_Cheat_Sheet.md)
- [Node.js · 条件导出](https://nodejs.org/api/packages.html#conditional-exports)
- [版本、许可证及改写说明](../SOURCES.md)
