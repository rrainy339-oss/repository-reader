# 路径穿越、受限目录与文件对象

文件处理、下载、模板、归档或对象存储使用外部路径或文件标识时。

## 安全属性与成立条件

实际访问的文件或对象必须在该事务与主体授权的边界内。风险来自外部字段可影响实际对象且缺少有效的目录或对象约束。目录隔离、文件拥有权与进程权限分别核对。

## 源码调查

定位最终读写、解包、下载或删除点，追踪原始名称、解码、绝对路径处理、规范化和根目录选择。阅读目标平台路径语义、链接处理与真正打开的对象。若安全判断与打开之间可改变对象，另参见[TOCTOU](race-toctou.md)。对象存储键需要结合具体 SDK 和授权模型理解，不能套用本地路径规则。

## 控制、证据与反证

对照例由经过授权的数据库记录映射到服务端生成的固定存储键，再执行该记录允许的操作。文件路径检查需确认规范化后确实处于根目录的分段边界，必要时核对真实对象及生命周期。引用输入、实际路径推导、控制顺序与操作。仅出现 `path.join` 或 `path.resolve`，或路径样式的字符串，不能证明访问越界。

## References

- [MITRE · CWE-22](https://cwe.mitre.org/data/definitions/22.html)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [Semgrep · express-path-join-resolve-traversal.yaml](https://github.com/semgrep/semgrep-rules/blob/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/javascript/express/security/audit/express-path-join-resolve-traversal.yaml)
- [Node.js · Child process](https://nodejs.org/api/child_process.html)
- [Node.js · File system（22.x）](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- [版本、许可证及改写说明](../SOURCES.md)
