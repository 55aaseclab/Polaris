# Polaris DSL · 设计认知（v0.4）

> 目标：一门**与行业无关**的业务描述语言。  
> 电商、ERP、科研流水线、制造执行——都是**业务包**，不是语言本身。  
> Tool **不是**流程里的「又一种 step 形态」，而是 **FFI（对外接口）**。

本文是设计立场，不是任何现有实现的翻译稿。

---

## 0. 一句话

**DSL 描述「业务在说什么、数据怎么变、允许对外界做什么」；  
Host 负责「外界具体是谁、怎么连、产物落在哪」。**

把 CLI 路径、env、sha256、prompt 原文塞进内核，语言会立刻塌成「又一个 YAML」。

---

## 1. 三个世界（核心分层）

任何可长期演进的业务系统，其实都在三个世界之间搬运：

```
┌──────────────────────────────────────────────────────────┐
│  ① 意义世界  Meaning                                       │
│     实体 · 状态 · 规则 · 事件 · 模块边界                      │
│     「订单已发货」「采集已完成」「质检不合格」                  │
├──────────────────────────────────────────────────────────┤
│  ② 计算世界  Computation                                   │
│     input → step(uses/out) → flow.output                  │
│     黑板（ctx）上的确定性数据变换                              │
├──────────────────────────────────────────────────────────┤
│  ③ 外界世界  World (via FFI)                               │
│     文件系统 · 进程 · HTTP · 模型 · 人工闸门 · 设备           │
│     只能通过「端口 Port」进出，禁止 step 直接摸路径            │
└──────────────────────────────────────────────────────────┘
```

| 世界 | 语言回答的问题 | 不该回答的问题 |
|------|----------------|----------------|
| 意义 | 有哪些东西、何为合法、状态如何迁 | 二进制在哪、用什么框架 |
| 计算 | 数据从哪来到哪去、依赖是否闭合 | 磁盘路径、MIME、容器挂载 |
| 外界 | **允许**调用哪些能力、类型契约 | 具体实现、重试策略、密钥 |

**当前 demo 已覆盖 ① 的一部分 + ②。**  
**抬高设计高度的关键：把 ③ 显式建模为 FFI，而不是把 tool 写成 step 的属性。**

---

## 2. Tool = FFI，不是 Step

### 2.1 错误心智（配置系统常见）

```text
step:
  id: collect
  tool: data-collection      ← 把外界实现揉进步骤
  command: run
  args: [--input, "{{x}}"]   ← 语言变成 shell 模板
```

这让 DSL 变成 **进程编排器的皮肤**，失去：

- 跨 Host 可移植（换 HTTP/嵌入库/ mock 全要改业务描述）
- 可验证的数据流（args 是字符串汤）
- 安全边界（任意 step 可拼任意命令）

### 2.2 正确心智（语言 + 宿主）

```text
┌─ 语言内 ─────────────────────────────────────┐
│  port LiteratureCollect                      │
│    in  : CollectRequest                      │
│    out : CollectResult                       │
│    effect: impure                            │
│                                              │
│  step collect {                              │
│    uses { request }                          │
│    call LiteratureCollect                    │  ← 只点名端口
│    output { result : CollectResult }         │
│  }                                           │
└──────────────────────────────────────────────┘
                      │
                      ▼  Host Binding（语言外 / 部署档案）
┌──────────────────────────────────────────────┐
│  LiteratureCollect →                         │
│    exec clue-data-collection run …           │
│    或  http POST /v2/collect                 │
│    或  in-process mock                       │
└──────────────────────────────────────────────┘
```

**FFI 三定律：**

1. **端口有类型**（in/out 是领域类型或结构类型，不是 `string[] args`）  
2. **步骤只 `call` 端口名**，不写可执行路径  
3. **绑定可替换**：同一 `.ord` 可在解释器 demo、生产 CLI、测试 mock 上跑

类比：

| 领域 | 对应物 |
|------|--------|
| C | `extern` 声明 vs 链接哪个 `.so` |
| Elm | `port` vs JS 订阅 |
| 六边形架构 | Port vs Adapter |
| 能力安全 | capability token vs 系统调用 |

---

## 3. 语言内核（Kernel）长什么样

内核只保留**正交、少而硬**的构造。行业词不准进内核。

### 3.1 构造一览

| 构造 | 世界 | 作用 |
|------|------|------|
| `domain` | 包 | 版本化业务宇宙 |
| `module` | 意义 | 限界上下文 / 能力分区 |
| `enum` / `entity` / `type` | 意义 | 词汇表与形状 |
| `port` | 外界 | FFI 声明（能力） |
| `flow` | 意义+计算 | 一次业务事务：意图 → 结果 |
| `input` / `output` | 计算 | flow 的对外契约 |
| `require` | 意义 | 守卫（状态/谓词/能力） |
| `steps` | 计算 | 有序变换；可 `call` port |
| `transition` / `emit` | 意义 | 状态迁徙与领域事件 |
| `ui` | 呈现 | 可选投影，不进入语义核心 |

**刻意不进内核的：**

- 可执行文件路径、Docker、env 名  
- prompt 长文（那是 **Intelligence Port 的输入内容**，或 Host 侧模板）  
- 文件 sha256、具体 `outputs/output.json` 路径（那是 **适配器的寻址**）  
- 页面布局框架名（shadcn 是 Renderer，不是语言）

### 3.2 Flow 的本质

```text
flow = 带契约的业务事务

  前置：require（何时允许）
  输入：input（外界/人提供什么）
  过程：steps（ctx 上的变换 + 可选 FFI）
  后置：transition / emit（意义世界如何更新）
  输出：output（对外保证返回什么）
```

**Flow 不是「阶段配置块」，是可验证的函数 + 效应边界。**

- 解释器：每次 walk AST，动态 FFI  
- 编译器：烘焙闭包，`program.run` 仍通过 **同一组 port 符号** 调 Host

### 3.3 Step 的本质

```text
step = 命名的 ctx 变换

  uses   : 从 ctx 读取哪些名字   （依赖可见）
  call?  : 可选，调用一个 port   （效应显式）
  output : 写回 ctx 的哪些名字   （产物可见）
```

规则：

- 无 `call` → **纯计算**（或内置原语）  
- 有 `call` → **效应步骤**；`uses` 映射到 port.in，`output` 来自 port.out  
- 禁止「隐式读全局文件」——要读外界，必须经过 port

这比「step 里塞 tool/command/args」高一层：**数据流闭合可静态检查，效应可审计。**

---

## 4. 效应与能力（把「副作用」说清楚）

引入极简效应标签（设计层，实现可分阶段）：

| 效应 | 含义 | 例子 |
|------|------|------|
| `pure` | 只动 ctx | 校验、拼装、映射 |
| `read` | 读外界 | 查询库存端口 |
| `write` | 写外界 | 持久化、发消息 |
| `ffi` | 通用对外调用 | 采集、分析 CLI |
| `human` | 等待人 | 审批、人工闸门 |
| `time` | 延时/定时 | 到期、SLA |

`port` 声明默认效应；`flow` 可声明 **所需能力集**：

```text
flow ShipOrder
  needs { Inventory.read, Carrier.book, Order.write }
```

Host 若未提供能力 → 拒绝加载（比跑到一半 shell 失败更早）。

---

## 5. 与「配置型工作流」的关系（认知切割）

以某类自动化平台的 yaml 为**参照物**（不是摹本）：

| 它们常混在一处的东西 | 我们放哪 |
|----------------------|----------|
| 模板 / 阶段拓扑 | `module` + 多个 `flow` 或显式 `pipeline` 编排（可选糖） |
| 步骤调 CLI | `port` + `call` + **Host binding** |
| `{{var}}` 字符串模板 | ctx 名字与类型化映射；适配器再渲染 CLI args |
| `depends_on` + path/sha256 | **类型化** `needs OutputType`；哈希是适配器证据 |
| `input_prompt` 长指令 | `port` 的一种：`Intelligence.derive` / 或 Host 在绑定时注入 |
| 空 steps 复用已有产物 | `flow` 允许仅 `require`+人工 port，或 `import` 已有 output |

**编排可以存在，但编排描述的是 flow 之间的契约，不是 argv。**

可选的高阶糖（仍不污染内核）：

```text
pipeline LiteratureReview {
  DataCollection -> IntelligenceAnalysis -> ReportWriting
  // 自动把上游 flow.output 接到下游 input（按名字/类型）
}
```

糖 = 展开成多个 flow + 显式映射；语义仍落在内核。

---

## 6. 业务包（Pack）怎么长

```text
domain  = 版本化宇宙
pack    = 一组 module +  entites + ports 的发布单元

例：
  pack sales.ops      — 订单/发货/汇款
  pack erp.plan       — 需求计划
  pack research.lit   — 文献采集分析（若要做）
  pack factory.mes    — 工单执行
```

**Pack 可依赖 Pack**（只依赖意义类型与 port 符号，不依赖 Host 路径）。

Renderer / AI：

- AI 生成 **pack 文本**（受 schema/校验约束）  
- 人审 **意义与数据流**  
- Host 团队维护 **binding 档案**（与业务描述分库分权）

---

## 7. 解释与编译（已定，再升一层）

```text
          .ord 源码
             │
          Parser
             │
            AST ── Validator（闭合：uses/out/port/能力）
             │
      ┌──────┴──────┐
      │             │
 Interpreter    Compiler
 动态 walk       烘焙 Program
 可热替换 AST     可发布、可缓存
      │             │
      └──────┬──────┘
             │
        Port Host（FFI 实现表）
             │
           World
```

编译产物 **仍然携带 port 符号**，不内联具体 CLI——  
否则「编译」变成「把部署细节焊死」，假编译。

真编译优化点：

- 纯 step 内联 / 常量折叠  
- 数据流死代码消除  
- 生成的 UI IR、测试桩、OpenAPI for ports  

---

## 8. 设计原则（可用来否决烂需求）

1. **行业词不准进内核** — 只有 entity/flow/port…  
2. **Tool 是 port，不是 step 字段**  
3. **凡数据必有名** — uses/out 可见，禁止隐形全局  
4. **凡效应必声明** — call/human/write 可审计  
5. **凡绑定可替换** — 同一描述多 Host  
6. **配置不是语言** — 路径/密钥/副本数放 binding  
7. **UI 是投影** — 可换渲染，不改语义  
8. **AI 写模型，不写任意代码** — 生成 .ord + 校验，不直接生成不可治理脚本  

---

## 9. 演进路线（务实）

| 阶段 | 交付 | 高度 |
|------|------|------|
| **P0**（已有） | entity/flow/input/steps uses·out/output；解释+编译；UI 数据流 | 计算世界可见 |
| **P1**（已有） | `port` + `call` + `needs`；MockHost.invoke；摄影/销售域包 | FFI 边界立住 |
| **P1.1**（已有） | **1000 域包压测**；Unicode 标识符；对抗集回归 | 内核可规模化 |
| **P2**（已有） | **`import` 跨域包**；**port version / @ver**；能力库无 flow | 组合升格 |
| **P2.1** | pipeline 糖；跨 flow 输出接线 | 编排糖 |
| **P3** | registry/API projection；port schema 导出；真实 CLI/HTTP Host adapter | 可上生产宿主 |
| **P4** | human port；时间；补偿/saga 叙事 | 长事务 |

### v0.4（当前实验范围）

v0.4 当前只扩展普通 `flow` 的数据处理能力，包括可执行的 `map` step。
条件路由、反馈回边、重试、checkpoint/resume 和执行限制仍是后续设计，
暂不属于 DSL 语言面。

---

## 10. 我们与「照搬」的差别（自我定位）

| | 配置流水线思维 | 本 DSL 思维 |
|--|----------------|-------------|
| 中心 | 跑通命令 | 说清业务与边界 |
| Tool | step 的实现细节 | **FFI 端口** |
| 文件路径 | 写在模板里 | Adapter 寻址 |
| 校验 | 跑了才知道 | 静态 uses/out/port |
| 多行业 | 复制 yaml | **换 pack** |
| AI | 生成脚本 | 生成可验证描述 |

不是否定配置流水线——**Host 侧仍然需要它**。  
只是：**别让业务语言沦为流水线的方言。**

---

## 11. 最小语言素描（目标态，非均已实现）

```text
domain Example version "0.3"

// ── 意义 ──
enum OrderStatus { Draft, Created, Shipped, Paid }

entity Order {
  id     : ID
  status : OrderStatus
  amount : Money
}

// ── FFI（只声明契约）──
port ReserveStock {
  in  { sku: String, qty: Number }
  out { reservationId: String }
  effect ffi
}

port Notify {
  in  { to: String, body: String }
  out { notifyRef: String }
  effect ffi
}

// ── 事务 ──
flow CreateOrder title "创建订单" on Order {
  create
  needs { ReserveStock, Notify }

  input {
    customer : String required
    sku      : String required
    qty      : Number required min 1
    amount   : Money  required
  }

  steps {
    reserve "预留库存" {
      uses { sku, qty }
      call ReserveStock
      output { reservationId : String }
    }
    write "落单" {
      uses { customer, sku, qty, amount, reservationId }
      output { orderId : ID }
    }
    ping "通知" {
      uses { customer, orderId }
      call Notify
      output { notifyRef : String }
    }
  }

  output {
    orderId : ID from orderId
    reservationId : String from reservationId
    status : OrderStatus from record.status
  }

  transition status -> Created
  emit OrderCreated
}
```

Host binding（**不是** .ord 内核，示例）：

```yaml
# host.bindings.yaml  — 部署档案
ports:
  ReserveStock: { kind: mock }           # dev
  Notify:       { kind: exec, path: ... } # prod
```

---

## 12. 总结

- **高度**来自分层：意义 / 计算 / 外界，而不是堆更多业务关键字。  
- **Tool = FFI port**：类型化、可替换、可审计。  
- **Step** 负责数据流可见性；**Flow** 负责业务事务；**Module/Pack** 负责边界。  
- **不照搬**任何一家的 yaml：它们是优秀的 **Host 实践**，不是语言本体。  
- 现有实现已在 **计算世界（uses/out）** 站住；下一跃迁是 **port/call + Host**，不是继续加电商/ERP 词表。

---

## 13. 与 Polaris 0.4.0（任务推送 / 学习）

Polaris 负责 **WorkEnvelope、事件账本、策略、WorkflowRun**；  
本 DSL 负责 **可校验的域包 IR**（Agent 生成草稿、人发布定义）。  

对接专文：

- 文档站：`apps/docs/site/polaris/dsl.md`
- 本地索引：`docs/POLARIS-0.4-BRIDGE.md`

原则不变：学习只吃 server-confirmed 事件；执行只经 `port@ver` Host；  
任务推送以 Envelope/卡片为主路径，DSL 是可选自动化附着，不是第二控制面。

---

*文档版本与代码 demo 同步演进；实现以 P0→P2 为已交付，wait/approval 等运行时仍属 Polaris。*
