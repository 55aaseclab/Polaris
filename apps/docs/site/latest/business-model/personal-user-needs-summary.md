# 个人 non-CS 用户需求汇总

这份说明只讨论 `personal non-CS user`。

这里不讨论个人开发者。
这里讨论的是不以代码工作为核心的个人用户。

## 总判断

这一类用户会比较很多工具。

他们不只会看通用聊天产品。
他们也会看任何能更快完成文件任务和内容任务的工具。

他们可能会比较：

- ChatGPT 网页版
- 豆包
- Kimi
- 元宝
- Claude 网页版
- VS Code
- 带文件上传的通用 AI 助手
- 可以处理文档和表格的桌面或网页工具
- 云盘协作工具里附带的 AI 能力

对他们来说，比较标准不是架构。
比较标准是：

- 能不能直接用
- 能不能处理真实文件
- 能不能更快得到结果
- 会不会比现有工具更麻烦

## 需求主题一：处理速度

这一项对两类个人用户都重要。

影响因素至少包括：

- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#e8f7ec; color:#166534; font-size:0.85em; font-weight:600;">checked</span> 不要缺基础工具
- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#eef2ff; color:#3730a3; font-size:0.85em; font-weight:600;">3rd-party</span> 网络访问是否稳定
- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#eef2ff; color:#3730a3; font-size:0.85em; font-weight:600;">3rd-party</span> CPU 性能是否足够
- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#e8f7ec; color:#166534; font-size:0.85em; font-weight:600;">checked</span> 工作空间是否已经预热
- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#eef2ff; color:#3730a3; font-size:0.85em; font-weight:600;">3rd-party</span> 文件挂载和 I/O 是否拖慢操作
- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#e8f7ec; color:#166534; font-size:0.85em; font-weight:600;">checked</span> 首次启动时间是否过长

## 需求主题二：对标 GPT 网页版

### personal non-CS user 真正会比较什么

他们会先问：

- 常用功能是不是基本一致，
  包括聊天、多轮对话、语音沟通、图片生成
- 如果不一致，为什么还值得用

### 我们已经实现的部分

严格按仓库当前能力说，我们已经有：

- 认证和用户范围控制
- 一个明显可对标 GPT 网页版的聊天主入口
- workspace 连续环境
- 文件上传和部分文件预览
- 后端已经能支撑工作空间持续运行

这些能力最多只能支撑下面这类潜在优势：

- 有连续环境
- 不只是一个纯聊天窗口

### 我们还没有实现的部分

从个人用户视角看，当前还没有直接实现：

- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#eef2ff; color:#3730a3; font-size:0.85em; font-weight:600;">3rd-party</span> `search chats`，也就是可搜索历史对话的能力
- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#fff4e5; color:#b45309; font-size:0.85em; font-weight:600;">fixing</span> `library`，也就是可回看、复用、管理历史内容和资产的入口
- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#fff4e5; color:#b45309; font-size:0.85em; font-weight:600;">fixing</span> 一个对个人用户友好的统一多轮对话产品面，
  并覆盖语音沟通、图片生成
- <span style="display:inline-block; padding:0.1rem 0.45rem; border-radius:999px; background:#fff4e5; color:#b45309; font-size:0.85em; font-weight:600;">fixing</span> `MCP apps` 和 `skills` 的产品化入口与安装使用路径

所以现在还不能把 Polaris 直接包装成
“面向 non-CS 用户的 GPT 网页版替代品”。

同时这里也已经有一个可成立的差异点：

- `ChatGPT` 不支持安装 `skills`
- Polaris 已经能支持 `skills` 的安装和使用路径
- 所以这部分已经可以作为对标 GPT 网页版时的差异化能力

## 需求主题三：文件处理和可视化

最新用户情报说明，这一类用户也会拿 Polaris 和 `VS Code` 比。

但他们比较的不是写代码体验。
他们比较的是文件处理范围、可视化能力、内容工作流和结果交付能力。

这里的文件范围主要包括：

- 文本
- 表格
- 幻灯片
- 图片
- 视频

他们会直接比较：

- 谁更能处理 Word、Excel、PPT、PDF
- 谁更适合多文件一起看
- 谁更适合导出和分享结果
- 谁更少在 IDE、聊天页、Office、网盘之间来回切换
- 谁能把前端直接做成 `Word`、`Slides`、`Sheets`、`PS`、视频制作插件
- 能不能把文字或图片直接变成视频
- 能不能快速做出短视频、讲解视频、演示视频
- 能不能和文档、图片、脚本材料串起来形成内容工作流
- 能不能少切几个工具就把视频初稿做出来

### 我们已经实现的部分

- 已有工作空间模型
- 已有受控的文件上传和部分文件预览
- 有连续 workspace 环境
- 有文件预览和资产承载基础

### 我们还没有实现的部分

- 面向 Office 文件的可用展示体验
- 面向非代码材料的产品化处理能力
- 一个明确强于 `VS Code` 和通用 AI 助手的文档和表格工作流
- 一套可直接挂到 `Word`、`Slides`、`Sheets`、`PS`、视频制作流程里的前端插件形态
- 面向个人用户的视频生成产品入口
- 文本、图片、脚本到视频的任务编排
- 视频预览、导出、交付链路
- 与文档、图片处理联动的内容生产工作流

当前这一块更准确的状态是：

- 有底层文件和资产能力
- 还没有形成面向 non-CS 用户的文件优势和视频制作产品能力

## 需求主题四：多文件传输与下载

### 用户关心什么

- 一次上传多个文件
- 批量下载结果
- 在本地和远端环境之间传资料
- 保存或分发生成结果

### 我们已经实现的部分

- 有 workspace 资产预览路径
- 有本地和远端 workspace 的概念基础
- 有本地部署方向上的架构基础

### 我们还没有实现的部分

- 多文件上传产品层
- 批量下载产品层
- 面向个人用户的文件收集与结果打包
- 云盘式同步或分发

这一块当前更准确的状态是：

- 有底座
- 没有成型的个人文件工作流产品

## 结论

按当前实现边界来看：

- 对 `personal non-CS user`，Polaris 目前还没有形成完整产品层
- 当前更接近工程控制面，而不是面向非技术个人用户的任务产品

因此更现实的判断是：

- 如果要进入这个市场，必须单独包装产品层
- 不能让用户直接面对 workspace、credential、runtime 这些概念

如果继续往前推进，优先级应该是：

1. 先补清楚个人用户主路径
2. 再补文件和下载体验
3. 再补 Office/PDF/多文件处理能力
4. 再评估视频制作这类内容生产能力是否进入主路径
5. 再决定是否真的进入 `personal non-CS user` 市场

因为当前对这类用户来说，
最大的风险不是能力不够深，
而是产品表面仍然过于接近工程控制面。
