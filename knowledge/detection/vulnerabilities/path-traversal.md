# 路径穿越、受限目录与文件对象

文件处理、下载、模板、归档或对象存储使用外部路径或文件标识时。

## 安全属性与成立条件

实际访问的文件或对象必须在该事务与主体授权的边界内。风险来自外部字段可影响实际对象且缺少有效的目录或对象约束。目录隔离、文件拥有权与进程权限分别核对。

## 源码调查

定位最终读写、解包、下载或删除点，追踪原始名称、解码、绝对路径处理、规范化和根目录选择。阅读目标平台路径语义、链接处理与真正打开的对象。若安全判断与打开之间可改变对象，另参见[TOCTOU](race-toctou.md)。对象存储键需要结合具体 SDK 和授权模型理解，不能套用本地路径规则。

## 控制、证据与反证

对照例由经过授权的数据库记录映射到服务端生成的固定存储键，再执行该记录允许的操作。文件路径检查需确认规范化后确实处于根目录的分段边界，必要时核对真实对象及生命周期。引用输入、实际路径推导、控制顺序与操作。仅出现 `path.join` 或 `path.resolve`，或路径样式的字符串，不能证明访问越界。

## 字符串路径、真实路径与文件句柄

先读 API 的消费语义。`path.join`/`path.resolve` 构造路径，`fs.realpath` 解析当前文件系统中的链接，`open` 建立文件句柄。字符前缀匹配不足以建立目录边界，目录同名前缀、“规范化”前后的两种路径和链接要依实际调用分开核对。下载文件、读取模板、解包、写入导出文件及删除需要分别看其根目录、身份和目标对象。如果存在用户可修改的目录、链接或者共享挂载，取到真实路径与真正打开文件之间的修改风险需要单独分析。单个终点上的不跟随链接标志不足以说明所有父目录安全。

例如，服务接收附件 ID，在带业务所有者条件的表里查找内部存储键，再由只读服务读取预建、禁止不可信主体改动的目录。源码需要支持 ID 到键的映射、路径根和实际使用方式，部署需要支持目录写权限。若读到控制器只验证了附件记录，而写入或下载另以请求路径打开文件，分别引用对象查询和实际 I/O 目标。补足符号链接、写权限与运行平台等前提。Express 规则能帮助定位拼接后交给响应或文件 API 的位置，API、固定根目录与隔离是判断的直接证据。

## References

- [MITRE · CWE-22](https://cwe.mitre.org/data/definitions/22.html)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [Semgrep · express-path-join-resolve-traversal.yaml](https://github.com/semgrep/semgrep-rules/blob/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/javascript/express/security/audit/express-path-join-resolve-traversal.yaml)
- [Node.js · File system（22.x）](https://nodejs.org/docs/latest-v22.x/api/fs.html)
- [版本、许可证及改写说明](../SOURCES.md)
