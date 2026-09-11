---
name: polaris-business
description: >
  Orchestrate e-commerce automation RPA business workflows across market
  research, product management, and order management while keeping the current
  human-in-the-loop process runnable. Use when Codex needs to route or
  coordinate work across those business modules.
---

# Polaris business orchestration

`polaris-business` 是业务资料和流程的编排 skill。它的职责不是假装已经有一套成熟电商后台，而是把当前可用的人、脚本、模板、外部工具和半自动流程串起来，先把业务跑通。

## 定位

- 目标：电商自动化 RPA
- 当前阶段：human-in-the-loop
- 工作原则：先跑通，再固化，再自动化

## 你在什么时候用这个 skill

当用户要的不是单点技能，而是整条业务链的编排时，使用 `polaris-business`：

- 先调研，再整理商品，再准备交付
- 从订单管理一路串到开票、发货、归档
- 想把跨模块的业务资料整理成可运行的工作流
- 想判断下一步该调哪个 skill、哪个目录、哪个模板

## 编排原则

1. 先确认当前任务落在哪个模块。
2. 只为当前模块调最小必要 skill，不要无意义全链路展开。
3. 如果现有流程仍靠人工和文档推进，保持这个事实，不虚构系统能力。
4. 优先保留可追溯路径、原始资料和冻结快照。

## 数据边界

- 做销售市场分析或报告时，默认只能使用产品数据、公开资料和明确假设。
- 不要读取、引用或外推订单、客户、成交、收款、物流、发票、对账等业务数据，除非用户明确说可以用这些数据。
- 如果用户要求“只用产品数据”，必须把订单与客户数据视为不可用证据。
- 最终报告不得泄漏内部订单、客户名称、成交价格、成本测算过程、工作目录或对话内容。

## 产品 metadata 规则

- 产品 `meta.json` 的 `name` 字段不得包含颜色词。
- 颜色只能放在目录名、图片标签、材质/外观描述、`copy.title` 或其他说明字段中。
- 命名时使用品类和造型信息，例如 `荷叶耳环`、`双葫芦项链`、`养生锤`，不要写成 `墨绿荷叶耳环`、`粉金双葫芦项链`。

## 订单产品引用规则

- 订单、报价、报检、发货、开票等业务 metadata 只能用 `product_id` 引用产品，不要复制产品 `meta.json` 里的 `name`、`copy.title` 或标价。
- 客户可见单据生成时必须按 `product_id` 实时读取产品 metadata，再渲染当前产品名、标价和必要说明。
- 订单 metadata 只保存订单特有信息，例如数量、成交价、折扣、收款、发货、对账和归档状态。

## 工具型 skill

这些 skill 不拥有业务模块或 topic，只在具体工作流需要时被调用：

- `polaris-data-collection`：通用采集与归档工具，可服务市场调研下的不同 topic。
- `rc-draw`：产品宣传图生成工具，服务产品管理素材生产。
- `polaris-content-production`：内容制作（product-catalog / carousel / video）。
  实现为 `@polaris/content-production`（`tools/content-production`）；
  图册是 `content_kind=product-catalog`，不是独立包。
