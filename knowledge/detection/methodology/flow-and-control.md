# 数据传播、分支与信任边界

需要确认某个控制是否覆盖敏感操作，或跨文件传播是否真实时。

## 选择分析模型

对输入相关的任务，用一条可追溯的数据链记录来源、解包或转换、参数、实际危险操作和检查点。对授权和业务任务，则记录主体、资源、动作、状态及策略。每次跨文件都核对导入、参数、返回值或异步回调的绑定。如果值只在字符串拼接、对象属性、包装器或队列参数中间接出现，引用相应赋值与消费位置。用 `read_lines` 或 `get_symbol_code` 获取代码。

## 分支与有效控制

- 阅读校验失败分支、提前返回、异常处理和副作用位置。控制有效时，核对成功分支是否确实约束了随后使用的那个值和对象。日志、包装函数名字、条件表达式中出现检查都只能定位候选控制。
- 保护操作可能发生在回调、Promise、错误回退或批量路径中。把每条可见的路径条件与相关副作用分别记下。存在外部注册或动态分派时，记录可证实的分支和缺失的上下文。
- 看清跨边界的数据从哪里获得权威。客户端展示值与服务端派生值、返回状态与持久化状态、访问身份和业务主体是不同事实。

## 反证与输出

优先找可信常量、有效上游校验、只用于显示的数据和仅限测试的路径。记录哪些是读到的事实，哪些依赖库行为、部署配置或未确认的业务要求。保持对本次任务的范围限制；一个分支的结论不能自动覆盖其他入口。

## References

- [Trail of Bits Skills · FUNCTION_MICRO_ANALYSIS_EXAMPLE.md](https://github.com/trailofbits/skills/blob/149d7b21f4067765b82e67029730b42d228ef4b4/plugins/audit-context-building/skills/audit-context-building/resources/FUNCTION_MICRO_ANALYSIS_EXAMPLE.md)
- [CodeQL · JavaScript 和 TypeScript 数据流指南](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)
- [OWASP · Secure Code Review](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Secure_Code_Review_Cheat_Sheet.md)
- [版本、许可证及改写说明](../SOURCES.md)
