# JavaScript 与 TypeScript 审计语义

遇到类型断言、动态派发、解构、深合并或 Promise 管理的控制时。

## 运行时值和对象

TypeScript 类型注解与断言在运行时不校验请求。读取真正执行的解码器、schema 或检查，并跟踪经检查的值是否被继续采用。区分可选字段、空值、空数组和默认值。解构、扩展、合并及类实例会改变字段来源。涉及字典或安全开关时，查清自有属性、默认原型和属性存取语义。

## 模块与绑定

ESM 具名或默认导入与 CommonJS 的 `module.exports` 是不同绑定方式。定位实际文件和重导出、适用运行构建或编译路径。源码含路径别名、条件导出、动态导入或混合构建时，读取适用配置和源码；工具只提供定义和候选位置。闭包或回调可能使用注册时的捕获值，也可能读取执行时共享状态，需按代码确认。

## 异步边界和反证

查清 `await`、返回 Promise、回调登记和错误分支与持久化操作的顺序。已等待且在拒绝路径终止的校验，与只创建 Promise 或仅日志记录的分支有不同语义。静态上看到校验函数要继续阅读实现，测试使用的替身或编译路径也要区分。代码片段 `const input = schema.parse(raw)` 只有 parse 在当前路径执行且后续使用 input 时才建立运行时解析证据。

## 缩窄对象和控制的实际语义

对安全字段记录运行时的最终来源。`??` 仅在 null 或 undefined 时使用回退，`||` 会对其他 falsy 值回退。若布尔值或零有业务语义，读默认值和实际分支。`in` 可命中继承属性，`Object.hasOwn` 只检查自有属性。对象扩展以可枚举的自有属性构造对象，随后对结果的普通属性读取仍有继承语义。动态字典转换为普通对象后，应重新确认键和值的保障。

例如，`req.body as Update` 只是让编译器接受类型。控制器实际消费 `schema.parse(req.body)` 的输出并显式选择可改字段时，可以用这两处源码证明运行时约束。若 Promise 回调创建后未返回给外层，查看验证与副作用有没有可靠时序。以当前入口的装配和绑定作为判断依据，测试替身可用于识别需核实的路径。

## References

- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [CodeQL · JavaScript 和 TypeScript 数据流指南](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)
- [TypeScript Handbook · 类型断言](https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions)
- [OWASP · Input Validation](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Input_Validation_Cheat_Sheet.md)
- [版本、许可证及改写说明](../SOURCES.md)
