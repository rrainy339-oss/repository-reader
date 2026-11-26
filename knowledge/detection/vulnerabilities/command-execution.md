# 命令与进程参数完整性

源码出现 child_process 或包装器，且入参来自任务设置、请求或资源元数据。

## 安全属性与成立条件

执行的程序、允许的参数语义和运行环境应落在设计范围内。先明确代码是调用 shell、直接创建子进程、调用一个纯 JS 实现还是只拼接日志。非 shell API 也仍需约束参数的含义。

## 源码调查

阅读实际模块导入、进程包装器、程序位置、参数拼装、`shell` 配置和工作目录。查输入值来自可信映射、受校验请求还是任意外部元数据。判断校验是在调用前阻止不允许的值，还是仅生成日志或返回提示。Windows 与 POSIX 的脚本启动机制以目标 Node 版本的文档和配置为据。

## 证据、控制与反证

优先考虑库 API。确需进程时使用固定可执行文件、分离参数、无 shell 的适用调用方式和明确的允许参数。固定映射到预先定义的操作是有效对照，仍应确认参数和程序行为都在已认可范围。引用真正的启动点、参数来源、解释模式和控制。符号名为 exec 或命中通用进程规则只提供阅读位置。

## References

- [OWASP · OS Command Injection Defense](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.md)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [Semgrep · detect-child-process.yaml](https://github.com/semgrep/semgrep-rules/blob/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/javascript/lang/security/detect-child-process.yaml)
- [Node.js · Child process](https://nodejs.org/api/child_process.html)
- [版本、许可证及改写说明](../SOURCES.md)
