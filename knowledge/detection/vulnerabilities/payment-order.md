# 订单、支付、价格与通知一致性

任务涉及下单、价格、支付、第三方通知、退款或积分流水时。

## 安全属性与成立条件

资金及订单状态依赖服务端可核验的交易和业务规则。分别追踪订单基准金额与币种、账户或商户归属、外部支付状态和本地持久化状态。支付、取消、退款和积分变化的适用规则可能各不相同。

## 源码调查

找到下单、支付通知处理、必要的服务端查单及最终状态更新。核对由可信的价格或商品来源计算的金额，以及通知真实性、交易与本地订单对应关系、金额与币种和旧状态约束。查重复通知与并发情形是否由数据层或实际幂等逻辑覆盖。小程序回调仅描述客户端体验，需定位真正写入状态的后端路径。

## 控制、证据与反证

对照例为核验通过且匹配本地订单的通知执行条件状态更新，然后才发出业务副作用。事件载荷可见、验签函数名或“收到成功回调”均需阅读实际实现与失败分支。引用金额来源、通知验证、校验条件、订单写入和相关规范。由账务服务完成重核、客户端只展示结果等情况是应确认的反证。

## 沿订单、付款和退款的独立状态追踪

- 从定价、下单、持久化到微信预支付读取实际字段，区分显示金额、服务端价格快照和平台金额。字段单位、币种、折扣适用条件以订单模型和对接版本为准。`wx.requestPayment` 回调属于客户端支付体验。确认服务端如何依据经过验证的支付通知或查单更新状态。
- APIv3 的通知验签与解密有各自输入，核对路由是否保留签名所需原始内容、采用正确商户配置和可信平台验证材料、验证失败能否继续进入业务服务。验证成功后仍要核对商户范围、商户订单号、平台交易标识、预期状态、金额和币种。合作伙伴和普通商户字段不同，以真实接口为准。
- 退款申请同步响应说明已受理。核对后续退款通知或查单的状态处理。小程序退款通知将 `out_trade_no`、`transaction_id`、`out_refund_no` 和 `refund_id` 分开。对部分退款检查每笔退款归属、金额和确切可退总量的约束，退款成功与支付成功各有状态和写入。

案例中，`notify.ts` 验证并解析事件，`orders.ts` 以商户和本地订单号加载价格快照，`settlement.ts` 在事务中执行状态变更与唯一履约记录写入。读重复事件返回路径和实际唯一键，确认回调、主动查单、恢复任务使用同一约束。事务外投递需核对可靠重试与共享计量。验签对跨商户或金额一致性只能提供事件来源方面的证据。若代码已比较受信金额并在原子成功后触发一次履约，分别作为反证。所需约束包括受信事件路径、本地订单映射以及导致错误履约、金额或退款状态的实际条件。

审核普通商户 APIv3 小程序支付成功通知时，核对 `appid`、`mchid`、`out_trade_no`、`transaction_id`、`trade_state` 以及 `amount`。订单总额 `total` 与付款人实付 `payer_total` 语义有别，金额比较要用符合业务以及平台字段定义的值。跨文件反查 `verifyPaymentNotification` 的实际返回类型后，用下面的方式理解结算契约。该示意中的比较函数需读取真实实现，唯一发货由事务和履约约束共同保证。

~~~ts
const notification = await verifyPaymentNotification(rawBody, headers);
await transaction(async (tx) => {
  const order = await tx.orders.requireMerchantOrder(notification.merchant, notification.orderNo);
  assertExpectedPayment(order, notification);
  const applied = await tx.orders.markPaidIfPending(order.id, notification.transactionId);
  if (applied) await tx.outbox.insertFulfillment(order.id);
});
~~~

若查单处理在另一个任务中直接调用履约，继续核对它是否经过同一条件写和队列约束。读取回调应答时确认应答发生在接收器能恢复处理之后。如果项目先持久化经验证的事件再异步结算，应查看待处理事件如何可靠领取与重试。

## References

- [OWASP · Business Logic Security](https://github.com/OWASP/CheatSheetSeries/blob/05861f28ed88269db390afeb67486abc0adfc076/cheatsheets/Business_Logic_Security_Cheat_Sheet.md)
- [OWASP WSTG v4.2 · 完整性检查](https://wstg.owasp.org/v4.2/4-Web_Application_Security_Testing/10-Business_Logic_Testing/03-Test_Integrity_Checks/)
- [微信支付官方 · 支付回调和查单实现指引](https://pay.wechatpay.cn/doc/v3/partner/4012082568)
- [微信支付官方 · 小程序支付成功通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791902)
- [miniapp-audit-skills · 身份与会话](https://github.com/bx33661/miniapp-audit-skills/blob/854f9a0dfe4a356f2d62133e68ddd07bf75f6b12/skills/miniapp-audit/references/platform-identity-session.md)
- [微信支付官方 · 小程序退款结果通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791906)
- [微信支付官方 · 订单退款业务示例](https://pay.wechatpay.cn/doc/v3/merchant/4015217336)
- [微信官方 API 类型定义](https://github.com/wechat-miniprogram/api-typings/blob/e5dc50ccea71e7999a8aa8a942a6f68045e141ca/types/wx/lib.wx.api.d.ts)
- [版本、许可证及改写说明](../SOURCES.md)
