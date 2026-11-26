# 密码学用途、完整性与密钥管理

涉及口令、签名、加密存储、Token、随机数或密钥生命周期时。

## 安全属性与成立条件

控制应满足其真实目标，例如保护机密性、验证完整性或产生不可预测的凭据。弱控制的判定依赖实际算法、参数、密钥来源和保护对象。校验和与保密加密是不同需求。

## 源码调查

从调用点确认算法与 API 参数如何选择，密钥由谁生成、读取、轮换、撤销和访问。检查加密模式需要的 nonce/IV 约束、认证标签或签名的实际验证，以及验证失败时的行为。身份凭据还需结合会话用途、签发方和过期条件。避免按算法字符串直接跨项目定性。

## 控制、证据与误报

对照例使用经过核实的密码学随机源生成安全令牌，口令采用适用的口令派生方案，完整性验证失败时拒绝采纳数据。算法与密钥约束以目标 Node 版本和已采用的规范为准。引用真实用途、参数、密钥来源和消费分支。非安全用途的哈希、测试向量、被安全封装覆盖的默认值都可构成反证。

## References

- [OWASP · Cryptographic Storage](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Cryptographic_Storage_Cheat_Sheet.md)
- [Node.js · Crypto](https://nodejs.org/api/crypto.html)
- [版本、许可证及改写说明](../SOURCES.md)
