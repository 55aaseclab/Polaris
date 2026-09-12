# Polaris DSL × Polaris 0.4.0

完整对接设计（任务推送 / 学习 / 控制面边界）写在文档站：

**[Polaris DSL](../../../apps/docs/site/polaris/dsl.md)**

（站点路径：`/polaris/dsl`）

## 本地一句话

| 能力 | 谁做主 | DSL 角色 |
|------|--------|----------|
| **任务推送** | Polaris `WorkEnvelope` + outbox 卡片 | 可选：卡片上的 recipe/dry-run 提示 |
| **学习** | 仅 server-confirmed `WorkEvent` | 产出 **域包草稿** `.ord`，校验后给人审 |
| **执行** | Durable `WorkflowRun` + effect receipt | `call port@ver` → Host → action catalog |
| **复用** | 租户内域包版本 | `import` + port 多版本 |

## 实验 IR 现状（polaris-workflow）

已具备并对齐 0.4 叙事的部分：

- 三世界：意义 / 计算 / FFI  
- `port` + `call` + `needs` + MockHost  
- `import` + `port version` + `@ver` 钉扎  
- `pipeline` 糖（主路径元数据）  
- 千级域包压测 + Unicode 标识  

尚未替代 Polaris 的部分（有意为之）：

- 租户 / Vault / 能力租约  
- 事件账本 / outbox 推送  
- wait/approval/compensate 运行时表  
- 真实 action catalog 与 effect 对账  


## 推荐落地顺序

1. **A** 契约对齐：草稿/定义 body = DSL 或同构 AST（可先不跑自动）  
2. **B** Co-pilot：从 session 生成 `.ord` 草稿 + dry-run  
3. **C** 委托低风险 step（feature flag）  
4. **D** 有界自动（0.4 实验档，门控关闭则不上）  
