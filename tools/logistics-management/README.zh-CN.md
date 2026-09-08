# 物流管理

这个目录存放 Polaris 业务工具使用的通用物流模板，不绑定某个 workspace。

模板包括：

- `templates/carrier-rate-card.template.csv`：承运商报价卡；
- `templates/shipment-record.template.json`：发货记录；
- `templates/reconciliation.template.json`：物流对账记录。

模板只是输入/记录格式。涉及订单写入、外部承运商请求或状态变更的操作，
必须通过 Polaris 的 durable action 边界执行；业务工具在 integrated mode
不会直接执行这些副作用。
