# 域包（Domain Pack）

**域包** = 用 Polaris DSL 描述的、可版本化的业务宇宙切片。
语言内核不变；行业词只出现在域包内容里。

## 约定

| 项 | 说明 |
|----|------|
| 文件 | 一个域包 ≈ 一个 `.ord`（或 monorepo 下 `packs/<id>/main.ord`） |
| 名称 | `domain <PascalOrUnicode> version "x.y"` |
| 展示元数据 | 可选 `title`、`description`、`category`、`accent "green|blue|amber"` |
| 内容 | `enum` / `entity` / `port` / `flow`（可选 `module`） |
| 输入控件 | flow input 可加 `control text` 或 `control textarea` |
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
category "Ecommerce"
accent "blue"
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

## Polaris 安装存储

Domain Pack 是 Polaris 控制面的发布对象，不属于任何 Vault，也不写入
Vault 的 `vault-data`、运行时状态或用户身份挂载。安装后的 canonical
位置是：

```text
$POLARIS_DATA_ROOT/
└── control/
    └── domain-packs/
        └── <domain>/
            └── <version>/
                ├── main.ord
                └── manifest.json
```

`manifest.json` 保存 pack 标识、版本、安装时间和 `main.ord` 的 SHA-256。
CLI 列表会重新计算摘要并将被修改的安装标为 `drifted`；运行时不会把
这种安装作为 import 依赖。这里不增加新的环境变量，根目录仍只由
`POLARIS_DATA_ROOT` 决定。

安装、查看和删除都通过 Polaris CLI 完成：

```bash
pnpm --dir apps/polaris run polaris -- pack add <file.ord|pack-directory>
pnpm --dir apps/polaris run polaris -- pack list
pnpm --dir apps/polaris run polaris -- pack remove <domain> \
  [--version <x.y.z>]
```

`add` 在原子写入前执行 `parse → resolve(import) → validate → compile`。
被引用的 pack 必须已经安装。多版本同时存在时，删除必须明确版本；
删除不影响任何 Vault 数据。

第一方业务域包从仓库根目录 `packs/` 自动发现，不必先 `pack add` 才会出现在
Workflow 设置里。`pack add` 只用于额外版本或覆盖安装：

```bash
pnpm --dir apps/polaris run polaris -- pack list
pnpm --dir apps/polaris run polaris -- pack add <file.ord|pack-directory>
```

| 域包 | 路径 | 作用 |
|------|------|------|
| AutoResearch | `packs/autoresearch/main.ord` | 第一方文献收集、分析和报告 |
| Vision kernel | `packs/vision-kernel/main.ord` | 内核素描，非全部已被 parser 实现 |

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
