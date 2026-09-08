/**
 * Built-in SEO ops playbook (code, not a skill).
 *
 * Structure follows the canonical Wanghai SEO reference in the documentation
 * site (AI 工具站 SEO 小册子：图解入门).
 *
 * Tasks are checklists the portal mutates per site under site.json playbook.task_states.
 */

export type SeoPlaybookSectionId =
  | "foundation"
  | "onpage_tech"
  | "content"
  | "backlinks"
  | "advanced";

export type SeoTaskStatus = "todo" | "doing" | "done" | "blocked" | "skipped";

export type SeoPlaybookTask = {
  id: string;
  section: SeoPlaybookSectionId;
  title: string;
  description: string;
  /** Rough priority for sorting (lower = sooner). */
  order: number;
};

export const SEO_PLAYBOOK_VERSION = "ai-tool-site-seo.v1";

export const SEO_PLAYBOOK_SECTIONS: Record<
  SeoPlaybookSectionId,
  { title: string; blurb: string }
> = {
  foundation: {
    title: "一、基石：认知打底",
    blurb: "ICP、Last-Click、竞争工程、竞品与官网 SEO 定位",
  },
  onpage_tech: {
    title: "二、站内基建",
    blurb: "SEO 基建、On-page 执行、Technical 自查",
  },
  content: {
    title: "三、内容创作",
    blurb: "搜索意图 → 页面类型匹配、工具页规范、关键词任务",
  },
  backlinks: {
    title: "四、外链建设",
    blurb: "外链常识、目录/导航/评测站 0→1",
  },
  advanced: {
    title: "五、高级实践",
    blurb: "pSEO 慎用：先硬内容样本，再字段化扩量",
  },
};

/** Canonical task list — extend carefully; ids must stay stable. */
export const SEO_PLAYBOOK_TASKS: SeoPlaybookTask[] = [
  {
    id: "foundation.icp",
    section: "foundation",
    order: 10,
    title: "写清 ICP（理想用户画像）",
    description: "谁在搜、什么场景、付费/试用动机；写入站点 positioning.icp。",
  },
  {
    id: "foundation.last_click",
    section: "foundation",
    order: 20,
    title: "定义 Last-Click 转化",
    description: "搜索用户最终要完成的交付结果（试用/注册/询盘/购买）。",
  },
  {
    id: "foundation.system_view",
    section: "foundation",
    order: 30,
    title: "按系统四层拆 SEO",
    description: "产品层 Search-Fit、内容层、结构层、信任/外链层；不是零散技巧。",
  },
  {
    id: "foundation.competitors",
    section: "foundation",
    order: 40,
    title: "建立 SEO 竞品档案",
    description: "至少 3 个竞品：主词、页面类型、外链来源、内容差距。",
  },
  {
    id: "foundation.site_vs_seo",
    section: "foundation",
    order: 50,
    title: "官网信息架构 vs SEO 内容架构对齐",
    description: "区分品牌官网叙事与可收录的搜索交付页面。",
  },
  {
    id: "onpage_tech.basics",
    section: "onpage_tech",
    order: 110,
    title: "完成 SEO 基建",
    description: "域名/HTTPS、Search Console、sitemap、robots、基础追踪（GA4）。",
  },
  {
    id: "onpage_tech.onpage",
    section: "onpage_tech",
    order: 120,
    title: "On-page SEO 执行逻辑上线",
    description: "Title/H1/描述/内链/主词与一句话价值主张一致；可按页面模板检查。",
  },
  {
    id: "onpage_tech.technical_checklist",
    section: "onpage_tech",
    order: 130,
    title: "Technical SEO 自查（踩坑清单）",
    description: "索引、canonical、速度、移动端、重复内容、软 404 等；逐项打勾。",
  },
  {
    id: "onpage_tech.url_structure",
    section: "onpage_tech",
    order: 140,
    title: "URL / 内容架构草案",
    description: "像一本书：栏目清晰、可扩展，避免随意堆页。",
  },
  {
    id: "content.intent_mapping",
    section: "content",
    order: 210,
    title: "搜索意图 → 页面类型匹配表",
    description: "信息/商业/交易/功能意图对应教程、对比、定价、Demo 等页面类型。",
  },
  {
    id: "content.keyword_backlog",
    section: "content",
    order: 220,
    title: "关键词与页面任务 backlog",
    description: "主词/长尾进任务列表；一页一意图，避免品牌词误用。",
  },
  {
    id: "content.tool_page_spec",
    section: "content",
    order: 230,
    title: "工具页 SEO 内容规范",
    description: "功能说明、步骤、FAQ、对比表、Schema 等可抽取信息增量。",
  },
  {
    id: "content.hard_ten",
    section: "content",
    order: 240,
    title: "先打磨 10 个硬内容页",
    description: "能被选进答案的样本页；有效收录后再考虑扩量。",
  },
  {
    id: "backlinks.fundamentals",
    section: "backlinks",
    order: 310,
    title: "外链策略与禁区对齐",
    description: "质量优先；记录可做/不可做渠道。",
  },
  {
    id: "backlinks.directories",
    section: "backlinks",
    order: 320,
    title: "目录站 / 导航站 / 评测站 0→1",
    description: "提交清单、物料（文案/封面/视频）、付费与 CPC 监控。",
  },
  {
    id: "backlinks.trust_modules",
    section: "backlinks",
    order: 330,
    title: "官网露出信任见证",
    description: "被导航站推荐后，反向在官网展示信任模块。",
  },
  {
    id: "advanced.pseo_guardrails",
    section: "advanced",
    order: 410,
    title: "pSEO 护栏（默认关闭）",
    description: "禁止换词堆页；仅在字段化信息增量 + 小样本验证后扩量。",
  },
  {
    id: "advanced.geo_light",
    section: "advanced",
    order: 420,
    title: "GEO / AI 引用轻量监控",
    description: "可选：Clarity 等行为数据 + 品牌在 AI 答案中的露出观察。",
  },
];

export function playbookTaskById(id: string): SeoPlaybookTask | undefined {
  return SEO_PLAYBOOK_TASKS.find((task) => task.id === id);
}

export function defaultTaskStates(
  nowIso: string,
): Record<string, { status: SeoTaskStatus; updated_at: string; note: string | null }> {
  const states: Record<string, { status: SeoTaskStatus; updated_at: string; note: string | null }> = {};
  for (const task of SEO_PLAYBOOK_TASKS) {
    states[task.id] = { status: "todo", updated_at: nowIso, note: null };
  }
  return states;
}

export function playbookProgress(
  taskStates: Record<string, { status: string } | undefined>,
): { total: number; done: number; doing: number; blocked: number; percent: number } {
  const total = SEO_PLAYBOOK_TASKS.length;
  let done = 0;
  let doing = 0;
  let blocked = 0;
  for (const task of SEO_PLAYBOOK_TASKS) {
    const status = taskStates[task.id]?.status ?? "todo";
    if (status === "done" || status === "skipped") done += 1;
    else if (status === "doing") doing += 1;
    else if (status === "blocked") blocked += 1;
  }
  return {
    total,
    done,
    doing,
    blocked,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}
