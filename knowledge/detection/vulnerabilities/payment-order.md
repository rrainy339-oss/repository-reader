# 订单、支付、价格与通知一致性

任务涉及下单、价格、支付、第三方通知、退款或积分流水时。

## 安全属性与成立条件

资金及订单状态依赖服务端可核验的交易和业务规则。分别追踪订单基准金额与币种、账户或商户归属、外部支付状态和本地持久化状态。支付、取消、退款和积分变化的适用规则可能各不相同。

## 源码调查

找到下单、支付通知处理、必要的服务端查单及最终状态更新。核对由可信的价格或商品来源计算的金额，以及通知真实性、交易与本地订单对应关系、金额与币种和旧状态约束。查重复通知与并发情形是否由数据层或实际幂等逻辑覆盖。小程序回调仅描述客户端体验，需定位真正写入状态的后端路径。

## 控制、证据与反证

对照例为核验通过且匹配本地订单的通知执行条件状态更新，然后才发出业务副作用。事件载荷可见、验签函数名或“收到成功回调”均需阅读实际实现与失败分支。引用金额来源、通知验证、校验条件、订单写入和相关规范。由账务服务完成重核、客户端只展示结果等情况是应确认的反证。

## References

- [OWASP · Business Logic Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Business_Logic_Security_Cheat_Sheet.md)
- [OWASP WSTG v4.2 · 业务数据验证与完整性](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/10-Business_Logic_Testing/03-Test_Integrity_Checks/)
- [微信支付官方 · 支付回调和查单实现指引](https://pay.wechatpay.cn/doc/v3/partner/4012082568)
- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [版本、许可证及改写说明](../SOURCES.md)
