# Express 路由、中间件与错误路径

索引或源码显示 Express app、Router、中间件、统一错误处理时。

## 找到有效挂载

确定项目用的是哪个 Express 主版本，阅读实际启动入口和 `app.use`、Router 挂载、HTTP 方法、路径前缀及处理器链。相同 handler 可能有多个挂载点。用导入关系和直接读取确认中间件与处理器属于同一有效链。框架版本影响路由匹配、Promise 拒绝和错误处理，查该版本文档或封装实现。

## 核对中间件行为

看认证中间件如何验证凭据并设置可信上下文，授权在哪一处绑定实际资源。身份检查、JSON 解析和错误日志各有作用。只有错误路径真正停止后续链或由可证实的错误中间件处理时，才把它当成阻止条件。检查 router、应用级中间件和最终处理器的调用顺序。代理设置、请求来源和头部信任需要结合部署配置核实。

## 误报与证据

路由中看不到检查时核对上层挂载；声明里存在中间件时核对是否仅挂在不同路径、方法或控制器。关注成功、异常和回退路径是否都消费一致的身份和输入。记录挂载、控制与副作用三处源码，代理和运行时路由配置缺失时标明限制。

## References

- [Express · 中间件与挂载](https://expressjs.com/en/guide/using-middleware/)
- [Express · 错误处理](https://expressjs.com/en/guide/error-handling/)
- [OWASP · REST Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/REST_Security_Cheat_Sheet.md)
- [Node.js · Child process](https://nodejs.org/api/child_process.html)
- [版本、许可证及改写说明](../SOURCES.md)
