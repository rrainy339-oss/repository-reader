# XSS 与输出语境

任务涉及模板、DOM、富文本、HTML 响应或小程序 WebView 页面。

## 安全属性与成立条件

经不可信数据派生的内容在目标渲染语境里保持数据语义。对持久化内容，分别确认存储与显示端；对前端路径，确认数据进入可解释内容的 API。显示的是普通文本、URL、HTML 或脚本取决于消费点和框架行为。

## 源码调查

从 DOM 写入、模板插值、原始 HTML 或响应写入位置反查字段来源。核对模板引擎、版本、自动转义范围及显式路径。语境对应的编码才是相关控制，富文本需要适用的清理器和其处理后的渲染路径。查清理之后是否有新的拼接或不同的消费语境。

## 控制、证据与误报

普通文本优先采用 `element.textContent = displayName` 或模板中的标准文本绑定。富文本对照例使用经确认的 HTML 清理边界和确实存在的策略。引用输入、渲染语境、实际写入、编码或清理位置。纯 JSON 或纯文本响应、默认文本插值与固定可信模板是可能的反证。CSP 属于额外防护，不能单独证明每个渲染点正确。

## References

- [OWASP · Cross Site Scripting Prevention](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.md)
- [Tencent SecGuide · JavaScript 安全指南](https://github.com/Tencent/secguide/blob/bfda087142e3bb3f5840cbc6af82c1982d1d14e4/JavaScript%E5%AE%89%E5%85%A8%E6%8C%87%E5%8D%97.md)
- [Semgrep · dom-based-xss.yaml](https://github.com/semgrep/semgrep-rules/blob/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/javascript/browser/security/dom-based-xss.yaml)
- [版本、许可证及改写说明](../SOURCES.md)
