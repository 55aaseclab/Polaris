# 域包（Domain Pack）

**域包** = 用 Business DSL 描述的、可版本化的业务宇宙切片。  
语言内核不变；行业词只出现在域包内容里。

## 约定

| 项 | 说明 |
|----|------|
| 文件 | 一个域包 ≈ 一个 `.ord`（或 monorepo 下 `packs/<id>/main.ord`） |
| 名称 | `domain <PascalOrUnicode> version "x.y"` |
| 内容 | `enum` / `entity` / `port` / `flow`（可选 `module`） |
| FFI | 只声明 `port`；Host binding 在语言外 |
| 标识符 | **Unicode**：`任务单`、`分拣臂`、`ReserveStock` 均可 |
| **import** | `import OtherDomain version "^1.2" [as Alias]` |
| **port 版本** | `port Foo version "2.0.0" { … }`；`call Foo@2.0.0` / `needs { Foo@2.0.0 }` |

### 跨域包 import

```text
// 能力域包（可无 flow）
domain Inventory version "1.2.0"
port ReserveStock version "2.0.0" { in {…} out {…} effect ffi }

// 业务域包
domain SalesFulfillment version "1.0.0"
import Inventory version "^1.2"
import Notify version "1.0" as N

flow Place {
  needs { ReserveStock@2.0.0, N.PushMessage }
  steps {
    r { uses {…} call ReserveStock@2.0.0 output {…} }
    n { uses {…} call N.PushMessage output {…} }
  }
}
```

规则：

- import **不合并对方的 flow**（只合并 enum/entity/port）
- `as Alias` → 符号变为 `Alias.Name`
- 同名 port 多版本可并存；无 `@ver` 时取**最高版本**
- 域版本约束：精确 / `1.2`（当作 ^）/ `^1.2.0`
- 能力域包可以只有 port（无 flow）

示例：`apps/polaris-workflow-demo/src/examples/packs/{inventory,notify,sales-fulfillment}.ord`

## 手写样例

| 域包 | 路径 |
|------|------|
| 销售记录 | `apps/polaris-workflow-demo/src/examples/sales-record.ord` |
| 摄影自动化 | `apps/polaris-workflow-demo/src/examples/photo-automation.ord` |
| ERP 全景素描 | `apps/polaris-workflow-demo/src/examples/erp-panorama.ord` |

## 压测集

```bash
# 生成 1000 个合成域包
pnpm gen:packs          # 或 pnpm exec tsx scripts/generate-domain-packs.mts 1000

# 全量 parse → validate → compile → interpret → compile-run
pnpm stress:packs

# 对抗集（期望 pass / validate_fail / parse_fail）
pnpm gen:adv
pnpm stress:adv
```

产物：

- `generated/domain-packs/*.ord` — 合成域包  
- `generated/adversarial-packs/` — 对抗用例  
- `generated/reports/stress-report.json`  
- `generated/reports/adversarial-report.json`  

## 压测发现的弱点与修复

| 弱点 | 现象 | 修复 |
|------|------|------|
| **标识符仅 ASCII** | 中文 `entity 任务单` / `port 分拣臂` 解析失败 | Unicode `\p{L}` ID |
| **能力域包被拒** | 仅有 port、无 flow 时 parse 失败，无法作 import 库 | 允许 port/entity-only 域包 |
| 合成包过「乖」 | 1000 包全绿但挖不深 | adversarial 套件 |
| 非 create 的 uses 环境字段 | 单据字段仅 warning | 运行时从 record.data 注入 |

## 设计原则（再强调）

1. 域包可成千上万，**内核关键字不随行业膨胀**  
2. 压测要同时有 **随机广度** 与 **对抗深度**  
3. 修复必须带回对抗用例，避免回归  
