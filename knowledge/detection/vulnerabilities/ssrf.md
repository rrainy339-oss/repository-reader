# 服务端出站请求与目的地约束

服务端处理器、代理、Webhook、预览或下载任务会访问变动 URL 时。

## 安全属性与成立条件

服务端只向该业务允许的目的地、协议和服务访问。关键证据是调用者可影响实际服务端访问的位置并超出允许范围。浏览器或小程序客户端自己发出的请求，与服务器代为访问应分开。

## 源码调查

从 HTTP 客户端或抓取器回溯 URL 来源，区分服务端主机常量和仅用于资源选择的可变字段。读取解析、标准化、认证信息、重定向以及代理与出站策略配置。控制若在封装中，要核对当前调用是否确实使用该封装及其有效选项。DNS 与网络层类结论需要实际配置依据。

## 控制、证据与反证

可固定服务注册表，由允许的服务 ID 选择预配置客户端，再传已检查的业务参数。确需可选目的地时，由相同的解释语义校验最终地址并覆盖重定向路径，结合网络层控制。记录输入、实际服务端请求、目的地选择、控制和缺失的部署证据。固定目标、只变更经构造的资源字段或封装层拒绝非法目标均可提供反证。

## 确认实际目的地及跳转策略

用 `search_text` 找 HTTP 客户端 import、调用入口和公共请求包装器，再读实际传给客户端的已解析 URL、`hostname`、端口、协议和代理选项。WHATWG URL 的 `origin` 包含协议、主机及端口信息，`hostname` 本身不带端口。相对 URL 的解释依赖解析基址。要核对验证对象与实际请求对象一致。传入固定目的地上的查询字段通常只影响请求内容。对路径的影响还需看客户端路由、签名和服务具体能力。

对于 Fetch，核对 `redirect`，以及封装器是否在返回重定向后自己再次发请求。正向跟踪响应中的下一目的地时，每个实际外联决策都需要已有策略覆盖。使用代理、出站网关或自定义 dispatcher 的项目应阅读初始化。部署网络不可见时，分开记录应用准许的目的地与运行环境是否可达。Semgrep 的 Express 规则覆盖指定的输入属性和客户端形状。为其增加包装器后的调用关系需要仓库源码。命中 `fetch` 本身只说明存在客户端请求。

~~~ts
const CATALOG_ENDPOINT = 'https://catalog.example.com/api/search';
async function lookupCatalog(query: CatalogQuery) {
  const url = new URL(CATALOG_ENDPOINT);
  url.searchParams.set('term', query.term);
  return fetch(url, { redirect: 'error' });
}
~~~

该对照依赖实际客户端使用这个 URL，且上游初始化没有替换目的地的逻辑。若任务显示预览接口直接把调用者提供的地址交给出站封装器，保留 URL 校验、跳转、路由方式和可能的返回/副作用证据。网络能否到达特定资源属于待查条件。响应未回传也可能有外联副作用，仍需按任务范围证明调用和实际影响。

## References

- [OWASP · Server Side Request Forgery Prevention](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.md)
- [Semgrep · express-ssrf.yaml](https://github.com/semgrep/semgrep-rules/blob/a5ad1714f00c9f7fde980cab0ea1d6dc6d414fd2/javascript/express/security/audit/express-ssrf.yaml)
- [Node.js · WHATWG URL](https://nodejs.org/api/url.html#the-whatwg-url-api)
- [WHATWG Fetch · Redirect mode](https://fetch.spec.whatwg.org/#concept-request-redirect-mode)
- [版本、许可证及改写说明](../SOURCES.md)
