# 物流管理

这个目录放通用物流管理工具，不绑定某个 workspace。

当前提供的内容：

- `templates/shipment-record.template.json`：单票发货记录模板
- `templates/reconciliation.template.json`：物流费用与对账模板
- `templates/carrier-rate-card.template.csv`：物流商报价表模板

使用原则：

- 订单级物流记录仍建议放在各 workspace 的 `订单管理/<订单号>/发货/`
- 这里的文件用于沉淀通用结构、模板、检查清单和工具脚本
- 如果后续需要脚本化处理物流资料，也优先加在这个目录下
