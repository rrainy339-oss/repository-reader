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

## 选择调查方向

- 起点明确而消费者未知时，从解析、认证上下文或回调的可信结果正向跟踪。确认每次赋值、解构、参数位置、字段覆盖和闭包捕获，尤其关注同名字段是否换了来源。`{ ...session, ...options }` 的最终字段来自最后一次写入。需要分别核实 `options` 的实际构造者与可写字段。
- 副作用明确时，从写入、文件句柄、对外客户端或响应序列化反查。跟随该调用消费的具体参数，沿返回值进入仓储函数或适配器，再在调用点反查实参。参数经过 `String` 转换、序列化或校验时，记录调用者能否控制任何结果，还是能选择某个特定语义值。可控性与实际业务效果是不同问题。
- 遇到库边界，先从导入和依赖版本确认实际模块，再核对路径中对应的配置。CodeQL 将参数、返回、属性、调用与库内传播分别建模。自定义包装器或安全包装不在现有模型里时，规则输出只提示从哪里读源码。对无法看到的服务端或者库内动态边，记录已确认的实参、API 契约与待确认效果。

## 检查副作用必经的条件

从实际效果反问每一条可到达路径是否经过同一个主体、对象和动作的检查。分别看 `return`、短路、`catch` 的回退值、`finally` 是否写入状态、事件是否排队、Promise 是否被等待，以及事务何时提交。`response.status(403).send(...)` 会发送响应，函数仍需有明确控制流保证后续写入不可达。`finally` 里的审计日志和业务发货要分开记录。事务回滚可以撤销同一事务中的数据库操作，已经发送的消息通常需要另外的设计保证一致性。

~~~ts
async function closeOrder(ctx: RequestContext, id: OrderId) {
  await policy.require(ctx.principal, 'order:close', id);
  return orderStore.closeIfPending(ctx.principal.tenantId, id);
}
~~~

这里的支持证据还包括 `require` 在拒绝时抛错、路由没有吞掉错误后重试写入、`closeIfPending` 确实使用租户和订单条件，以及策略要求锁定的状态被原子检查。若包装器调用异步策略后立即继续，或只检查了 Promise 对象的真假，需要把实际控制流纳入判断。命中一个 `await` 只能证明调用被等待。还要读拒绝是抛错、返回假值还是返回有字段的决策对象，并确认这些值如何控制副作用。

## References

- [Trail of Bits Skills · FUNCTION_MICRO_ANALYSIS_EXAMPLE.md](https://github.com/trailofbits/skills/blob/149d7b21f4067765b82e67029730b42d228ef4b4/plugins/audit-context-building/skills/audit-context-building/resources/FUNCTION_MICRO_ANALYSIS_EXAMPLE.md)
- [CodeQL · JavaScript 和 TypeScript 数据流指南](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)
- [OWASP · Secure Code Review](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Secure_Code_Review_Cheat_Sheet.md)
- [CodeQL · JavaScript 库模型](https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-javascript/)
- [版本、许可证及改写说明](../SOURCES.md)
