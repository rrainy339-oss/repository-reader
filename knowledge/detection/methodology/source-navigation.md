# 陌生仓库与跨文件源码阅读

入口只有地图记录、存在同名定义、跨文件目标不明时。

## 可选阅读路径

地图、任务起点和入口索引用于定位。先找到任务涉及的操作及入口文件，阅读入口注册、绑定、分派和关键调用周围的代码。`query_entries` 可按 `entryId` 或 `kind` 查看索引候选。`query_map` 仅在提供地图时可用。调用环境未在仓库中出现时，写明从哪个可见入口开始观察。

- `get_file_symbols(filePath)` 适合查看长文件结构。`search_symbols(name, scope, kind)` 可缩小候选定义，用 `get_symbol_code(symbolId)` 阅读定义本身。定义同名时，以导入来源、别名、接收者初始化及导出成员为依据。
- 对回调、动态成员、工厂返回值或局部遮蔽，优先阅读赋值与注册位置。可以用 `search_text(query, scope)` 搜索导入字符串、限定成员名、路由字面量或注册函数。它是区分大小写的字面搜索，使用 `nextCursor` 续查。符号搜不到时仍可浏览目录和直接阅读文件。
- 调用关系通常需要两侧证据。记录调用表达式上哪个实参绑定到被调用函数哪个参数，哪个返回值被继续消费。若包装器只传递引用，阅读调用者使用该引用的位置。

## 反证与输出

仓库中存在同名方法、测试替身、替代入口或未部署的实现时，按当前任务区分不同作用域。只读到调用点时，可以描述可见调用和缺少的定义。动态目标、生成代码和实际部署配置缺失时保留待查项；引用使用本轮完整读取的文件行范围。

## References

- [Trail of Bits Skills · FUNCTION_MICRO_ANALYSIS_EXAMPLE.md](https://github.com/trailofbits/skills/blob/149d7b21f4067765b82e67029730b42d228ef4b4/plugins/audit-context-building/skills/audit-context-building/resources/FUNCTION_MICRO_ANALYSIS_EXAMPLE.md)
- [CodeQL · JavaScript 和 TypeScript 数据流指南](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)
- [OWASP · Secure Code Review](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Secure_Code_Review_Cheat_Sheet.md)
- [版本、许可证及改写说明](../SOURCES.md)
