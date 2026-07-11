import { useEffect, useState } from "react";
import {
  ArrowRight,
  BadgeCheck,
  Boxes,
  Building2,
  ChevronRight,
  CircleUserRound,
  Command,
  DoorOpen,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Mail,
  Network,
  ShieldCheck,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./components/ui/accordion";
import { Avatar, AvatarFallback } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Separator } from "./components/ui/separator";

type Language = "zh" | "en";

type LandingCopy = {
  nav: {
    personal: string;
    enterprise: string;
    faq: string;
    signIn: string;
  };
  hero: {
    badge: string;
    title: string;
    subtitle: string;
    primaryCta: string;
    secondaryCta: string;
    socialProof: string[];
  };
  media: {
    kicker: string;
    title: string;
    description: string;
    panels: Array<{ label: string; value: string }>;
    rows: Array<[string, string]>;
  };
  benefits: {
    personalTitle: string;
    enterpriseTitle: string;
    personalBody: string;
    enterpriseBody: string;
    personalItems: Array<{ title: string; body: string; icon: typeof Sparkles }>;
    enterpriseItems: Array<{ title: string; body: string; icon: typeof Boxes }>;
  };
  testimonials: {
    title: string;
    items: Array<{ quote: string; name: string; role: string; initials: string }>;
  };
  faq: {
    title: string;
    items: Array<{ question: string; answer: string }>;
  };
  finalCta: {
    title: string;
    description: string;
    emailPlaceholder: string;
    primaryCta: string;
    secondaryCta: string;
  };
  footer: {
    contactTitle: string;
    contactBody: string;
    body: string;
    email: string;
    legal: string[];
    pillars: string[];
  };
};

const copy: Record<Language, LandingCopy> = {
  zh: {
    nav: {
      personal: "个人",
      enterprise: "企业",
      faq: "常见问题",
      signIn: "登录",
    },
    hero: {
      badge: "AI 工作空间平台",
      title: "用上 AI，今天的活轻一点",
      subtitle:
        "聊天、写作、出图、做视频、处理文档，常做的事都能省点劲。",
      primaryCta: "个人开始使用",
      secondaryCta: "团队申请接入",
      socialProof: [
        "最新 GPT / Claude 模型",
        "支持 Codex / Claude Code",
        "云上内容 + 本地软件自动化",
      ],
    },
    media: {
      kicker: "产品表层",
      title: "打开页面，看到的就是工作如何被组织起来。",
      description:
        "这里不只展示聊天入口，而是把模型、专业 AI 开发工具、工作空间、凭证和交接放在同一块工作面里。",
      panels: [
        { label: "Workspace", value: "atlas-api / 准备就绪" },
        { label: "凭证", value: "用户级作用域 / 已激活" },
        { label: "隔离", value: "共享基础设施 / 已封闭" },
        { label: "交接", value: "交接快照 / 已保留" },
      ],
      rows: [
        ["新工作空间", "标准路径可直接进入"],
        ["身份归属", "用户与工作空间的归属关系分离"],
        ["凭证绑定", "默认 AI 工具绑定在运行时解析"],
        ["交接保留", "成员离开后团队上下文仍保留"],
      ],
    },
    benefits: {
      personalTitle: "个人路径：模型要新，工具要强，功能完备，真能解决问题。",
      enterpriseTitle: "团队接入：成员接入，环境隔离，反思进化，真能节约成本",
      personalBody:
        "",
      enterpriseBody:
        "",
      personalItems: [
        {
          title: "最新模型",
          body: "支持最新的 GPT 和 Claude 模型，模型能力更新不掉队。",
          icon: Sparkles,
        },
        {
          title: "专业 AI 开发工具",
          body: "支持 Codex、Claude Code 等专业 AI 开发工具，让 AI 从对话走向自主编程解决问题。",
          icon: CircleUserRound,
        },
        {
          title: "完整工作面",
          body: "支持云上聊天、生图、生短视频，也支持本地聊天、PS 自动化、剪辑软件自动化、办公软件自动化。",
          icon: UsersRound,
        },
      ],
      enterpriseItems: [
        {
          title: "成员接入",
          body: "支持新成员快速进入工作环境，共享团队的配置和工具。",
          icon: Boxes,
        },
        {
          title: "集群环境隔离",
          body: "支持多人共用集群环境，由 Docker container、k3s pod / kata-container 或 KubeVirt VM 保证隔离。",
          icon: ShieldCheck,
        },
        {
          title: "数据沉淀进化",
          body: "支持沉淀做过的事、踩过的坑和改出来的方法，让后续工作越做越顺，让工作交界变得简单。",
          icon: DoorOpen,
        },
        {
          title: "凭证与权限",
          body: "凭证可以集中管理、按需切换，而不是散落在每台机器上。",
          icon: KeyRound,
        },
        {
          title: "人走人留",
          body: "成员离开或轮岗后，项目上下文、环境经验和交接线索还能继续被团队使用。",
          icon: Fingerprint,
        },
      ],
    },
    testimonials: {
      title: "真正开始用之后，大家最在意的往往不是模型本身。",
      items: [
        {
          quote: "最有价值的不是“能不能聊”，而是模型、专业 AI 开发工具和工作流程能不能真的接到日常工作里。",
          name: "Mira Chen",
          role: "Platform engineering lead",
          initials: "MC",
        },
        {
          quote: "个人用户可以很快开始，团队接进来以后也不会因为凭证和环境问题一下子变乱。",
          name: "Jon Bell",
          role: "Engineering manager",
          initials: "JB",
        },
        {
          quote: "项目继续运转，不该靠某个人记得怎么配环境；交接本来就应该留在系统里。",
          name: "Leah Ortiz",
          role: "Delivery operations director",
          initials: "LO",
        },
      ],
    },
    faq: {
      title: "在开始之前，你大概会先问这些问题。",
      items: [
        {
          question: "Polaris 是不是另一个 coding assistant？",
          answer: "不是。它不只给你聊天或补全，而是把模型、专业 AI 开发工具、工作空间、凭证和交接一起接进日常工作。",
        },
        {
          question: "个人路径怎么理解？",
          answer: "你可以先一个人开始，先把聊天、写作、出图、做视频、处理文档这些常做的事做轻一点；需要协作时，再把队友和项目一起带进来。",
        },
        {
          question: "企业最看重什么？",
          answer: "团队更看重成员怎么接入、凭证和权限怎么保持清楚、环境怎么隔离，以及人员变化后项目还能不能顺畅接下去。",
        },
        {
          question: "这些 CTA 已经接到真实 auth 吗？",
          answer: "现在这些入口先保留为页面动作。后续认证会回到 Polaris 自己的产品入口里，而不是让用户跳到另一套站点。",
        },
        {
          question: "这会替代现在的 Polaris portal 吗？",
          answer: "不会。它更像 Polaris 的公开入口；登录后的工作空间与管理界面仍然会继续承接实际使用。",
        },
      ],
    },
    finalCta: {
      title: "自己先开始，或者一开始就按团队方式把这件事做对。",
      description: "个人可以先把常做的事做轻一点；团队可以同时把成员接入、凭证边界和项目交接一起规划好。",
      emailPlaceholder: "输入邮箱以获取企业介绍 / team@company.com",
      primaryCta: "个人开始使用",
      secondaryCta: "团队申请接入",
    },
    footer: {
      contactTitle: "联系与法务",
      contactBody: "无论你是先自己开始，还是准备把团队带进来，都可以从这里继续。",
      body: "最新、最强的模型，专业 AI 开发工具，更完整的日常工作入口。",
      email: "team@polaris-workspace.local",
      legal: ["隐私政策", "服务条款", "安全说明"],
      pillars: ["凭证控制", "工作空间隔离"],
    },
  },
  en: {
    nav: {
      personal: "Personal",
      enterprise: "Enterprise",
      faq: "FAQ",
      signIn: "Sign in",
    },
    hero: {
      badge: "AI workspace platform",
      title: "Use AI to make today’s work feel lighter.",
      subtitle:
        "Chat, write, make images, make short videos, and handle documents with less drag in the work you do every day.",
      primaryCta: "Start personal",
      secondaryCta: "Talk enterprise",
      socialProof: [
        "Latest GPT / Claude models",
        "Supports Codex / Claude Code",
        "Cloud creation + local automation",
      ],
    },
    media: {
      kicker: "Product surface",
      title: "The first thing you see is how work gets organized.",
      description:
        "This is not just a chat surface. It brings models, professional AI developer tools, workspaces, credentials, and continuity into the same working layer.",
      panels: [
        { label: "Workspace", value: "atlas-api / ready" },
        { label: "Credential", value: "user-scoped / active" },
        { label: "Isolation", value: "shared infra / sealed" },
        { label: "Handover", value: "snapshot retained" },
      ],
      rows: [
        ["new workspace", "Ready in the standard path"],
        ["identity", "user and workspace ownership separated"],
        ["credential", "default AI tool binding resolved at runtime"],
        ["handover", "team context preserved after member exit"],
      ],
    },
    benefits: {
      personalTitle: "Personal path: latest models, strongest capability, and professional AI developer tools that keep up.",
      enterpriseTitle: "Enterprise path: bring people in, keep environments separate, let the team keep learning.",
      personalBody:
        "The value is not another chat tab. It is one place where the latest, strongest models, professional AI developer tools, and everyday work actually connect.",
      enterpriseBody:
        "Teams need cleaner member entry, clearer environment boundaries, and a way for working knowledge to accumulate instead of resetting every time.",
      personalItems: [
        {
          title: "Latest models",
          body: "Use the latest GPT and Claude models without falling behind model capability updates.",
          icon: Sparkles,
        },
        {
          title: "Professional AI developer tools",
          body: "Support professional AI developer tools like Codex and Claude Code, so AI can move from conversation to autonomous coding problem solving.",
          icon: CircleUserRound,
        },
        {
          title: "Complete work surface",
          body: "Cover chat, writing, images, short video, documents, and local automation for creative and office tools.",
          icon: UsersRound,
        },
      ],
      enterpriseItems: [
        {
          title: "Member onboarding",
          body: "New members enter through the same workspace path instead of rebuilding setup from scratch.",
          icon: Boxes,
        },
        {
          title: "Environment isolation",
          body: "Even on shared infrastructure, project state and runtime boundaries stay easier to trust.",
          icon: ShieldCheck,
        },
        {
          title: "Reflect and evolve",
          body: "The problems you hit, the fixes you make, and the better ways you find can accumulate instead of being rediscovered every time.",
          icon: DoorOpen,
        },
        {
          title: "Credentials and access",
          body: "Reusable credentials can be managed and switched without turning every machine into a special case.",
          icon: KeyRound,
        },
        {
          title: "People move, work stays",
          body: "Project context, workspace knowledge, and handover trails stay with the organization when people leave or rotate.",
          icon: Fingerprint,
        },
      ],
    },
    testimonials: {
      title: "Once real work starts, the model is rarely the only question.",
      items: [
        {
          quote: "The hard part is not getting AI to respond once. The hard part is connecting models, professional AI developer tools, and work habits without losing control later.",
          name: "Mira Chen",
          role: "Platform engineering lead",
          initials: "MC",
        },
        {
          quote: "One person can start quickly, and the team still keeps order when adoption grows.",
          name: "Jon Bell",
          role: "Engineering manager",
          initials: "JB",
        },
        {
          quote: "Projects keep moving because handover is part of the workflow, not an emergency ritual after someone leaves.",
          name: "Leah Ortiz",
          role: "Delivery operations director",
          initials: "LO",
        },
      ],
    },
    faq: {
      title: "Before you start, these are probably the first questions you will ask.",
      items: [
        {
          question: "Is Polaris another coding assistant?",
          answer: "No. It gives you model access, but it also brings professional AI developer tools, workspaces, credentials, isolation, and handover into the same working model.",
        },
        {
          question: "How does the personal motion work?",
          answer: "You can start on your own by making everyday work lighter first, then bring teammates in later without changing the whole way you work.",
        },
        {
          question: "What matters most for enterprise teams?",
          answer: "Teams usually care most about how people enter, how credentials and access stay clear, how environments stay separated, and whether project context survives staffing changes.",
        },
        {
          question: "Are these CTAs wired to live auth?",
          answer: "Not yet. These entry points are designed so sign-in and sign-up can move into Polaris itself later, without changing the user-facing structure again.",
        },
        {
          question: "Does this replace the current Polaris portal?",
          answer: "No. This is the public entry layer. The authenticated portal still handles the actual workspace and management experience.",
        },
      ],
    },
    finalCta: {
      title: "Start on your own now, or bring your team in with a model that still works later.",
      description: "Start by making everyday work lighter for yourself, or plan the team rollout with cleaner access, boundaries, and handover from day one.",
      emailPlaceholder: "Enter your email for the enterprise brief",
      primaryCta: "Start personal",
      secondaryCta: "Talk enterprise",
    },
    footer: {
      contactTitle: "Contact and legal",
      contactBody: "Whether you want to start personally or plan a team rollout, you can continue from here.",
      body: "Strong models, strong professional AI developer tools, and a more complete way to get daily work done.",
      email: "team@polaris-workspace.local",
      legal: ["Privacy policy", "Terms of service", "Security notes"],
      pillars: ["Credential control", "Workspace isolation"],
    },
  },
};

function App() {
  const [language, setLanguage] = useState<Language>("zh");
  const t = copy[language];

  useEffect(() => {
    const stored = window.localStorage.getItem("landing-page-language");
    if (stored === "zh" || stored === "en") {
      setLanguage(stored);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("landing-page-language", language);
    document.documentElement.lang = language;
  }, [language]);

  return (
    <div className="min-h-screen bg-[var(--page-background)] text-[var(--color-ink)]">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-10 px-4 py-4 sm:px-6 lg:px-8">
        <header className="sticky top-0 z-30 rounded-[1.75rem] border border-[color:var(--color-line)] bg-[rgba(245,249,250,0.86)] px-4 py-4 backdrop-blur-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <a className="inline-flex items-center gap-3 font-bold tracking-[-0.03em]" href="/">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--color-cyan),var(--color-coral))] text-white shadow-[0_0_0_8px_rgba(92,186,214,0.14)]">
                <Command size={18} aria-hidden="true" />
              </span>
              <span className="font-display text-lg">Polaris</span>
            </a>
            <nav className="flex flex-wrap items-center gap-4 text-sm font-medium text-[rgba(24,35,33,0.72)]">
              <a href="#personal">{t.nav.personal}</a>
              <a href="#enterprise">{t.nav.enterprise}</a>
              <a href="#faq">{t.nav.faq}</a>
            </nav>
            <div className="flex flex-wrap items-center gap-3">
              <div className="inline-flex items-center rounded-full border border-[color:var(--color-line-strong)] bg-white/70 p-1">
                <button
                  type="button"
                  onClick={() => setLanguage("zh")}
                  className={language === "zh" ? "rounded-full bg-[var(--color-ink)] px-3 py-2 text-xs font-bold text-white" : "rounded-full px-3 py-2 text-xs font-bold"}
                >
                  中文
                </button>
                <button
                  type="button"
                  onClick={() => setLanguage("en")}
                  className={language === "en" ? "rounded-full bg-[var(--color-ink)] px-3 py-2 text-xs font-bold text-white" : "rounded-full px-3 py-2 text-xs font-bold"}
                >
                  EN
                </button>
              </div>
              <Button asChild variant="outline">
                <a href="/sign-in">
                  {t.nav.signIn}
                  <ChevronRight size={16} aria-hidden="true" />
                </a>
              </Button>
            </div>
          </div>
        </header>

        <section className="grid gap-6 lg:min-h-[78vh] lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div className="flex flex-col gap-5">
            <Badge variant="subtle" className="w-fit">
              {t.hero.badge}
            </Badge>
            <h1 className="font-display text-[clamp(3rem,7vw,6.25rem)] leading-[0.94] tracking-[-0.06em]">
              {t.hero.title}
            </h1>
            <p className="max-w-[44rem] text-base leading-8 text-[rgba(24,35,33,0.8)] sm:text-lg">
              {t.hero.subtitle}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <a href="/sign-up?motion=personal">
                  {t.hero.primaryCta}
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href="/enterprise">
                  {t.hero.secondaryCta}
                  <Building2 size={18} aria-hidden="true" />
                </a>
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {t.hero.socialProof.map((item) => (
                <Card key={item} className="rounded-[1.35rem]">
                  <CardContent className="p-4 text-sm font-semibold leading-6">
                    {item}
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>

          <Card className="overflow-hidden rounded-[2rem] bg-[linear-gradient(180deg,#15211f_0%,#101816_100%)] text-white shadow-[var(--shadow-hard)]">
            <CardHeader>
              <div className="flex items-center justify-between gap-3 text-[0.72rem] uppercase tracking-[0.08em] text-white/70">
                <span>{language === "zh" ? "工作空间 / 控制面" : "workspace/control"}</span>
                <Badge variant="inverse">{language === "zh" ? "运行中" : "live"}</Badge>
              </div>
              <CardTitle className="text-white">atlas-api</CardTitle>
              <CardDescription className="text-white/70">
                {language === "zh" ? "由 team-platform 拥有" : "team-platform"}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                {t.media.panels.map((panel) => (
                  <div
                    key={panel.label}
                    className="rounded-[1.3rem] border border-white/10 bg-white/5 p-4"
                  >
                    <div className="text-[0.72rem] uppercase tracking-[0.08em] text-white/60">
                      {panel.label}
                    </div>
                    <div className="mt-2 text-sm font-semibold leading-6 text-white/92">
                      {panel.value}
                    </div>
                  </div>
                ))}
              </div>
              <div className="rounded-[1.3rem] border border-white/10 bg-white/5 p-4">
                <div className="flex items-start gap-3">
                  <BadgeCheck className="mt-0.5 h-5 w-5 text-[var(--color-cyan)]" />
                  <div className="grid gap-1">
                    <div className="font-semibold">
                      {language === "zh" ? "交接快照已保留" : "Handover snapshot retained"}
                    </div>
                    <div className="text-sm leading-7 text-white/72">
                      {language === "zh"
                        ? "项目上下文留在工作空间里，而不是留在某一台机器上的个人习惯里。"
                        : "Project context stays with the workspace instead of living in one local machine ritual."}
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 md:grid-cols-3" aria-label="Proof">
          {t.media.panels.slice(0, 3).map((panel, index) => (
            <Card key={panel.label}>
              <CardHeader className="gap-2">
                <Badge variant="default" className="w-fit">
                  {index + 1}
                </Badge>
                <CardTitle className="text-xl">{panel.label}</CardTitle>
                <CardDescription>{panel.value}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-[0.42fr_0.58fr]" aria-labelledby="media-title">
          <div className="flex flex-col gap-4">
            <Badge variant="default" className="w-fit">
              {t.media.kicker}
            </Badge>
            <h2 id="media-title" className="font-display text-[clamp(2rem,4vw,3.3rem)] leading-[0.98] tracking-[-0.05em]">
              {t.media.title}
            </h2>
            <p className="text-base leading-8 text-[rgba(24,35,33,0.78)]">
              {t.media.description}
            </p>
          </div>
          <Card className="rounded-[2rem]">
            <CardContent className="grid gap-4 p-6">
              {t.media.rows.map(([label, value]) => (
                <div key={label}>
                  <div className="flex flex-col gap-3 rounded-[1.25rem] border border-[color:var(--color-line)] bg-white/80 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <span className="text-[0.72rem] font-bold uppercase tracking-[0.08em] text-[rgba(24,35,33,0.56)]">
                      {label}
                    </span>
                    <strong className="text-sm leading-6">{value}</strong>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-5 lg:grid-cols-2" aria-labelledby="motion-title">
          <div className="lg:col-span-2">
            <Badge variant="default" className="mb-4 w-fit">
              {language === "zh" ? "双路径" : "Two motions"}
            </Badge>
            <h2 id="motion-title" className="font-display text-[clamp(2rem,4vw,3.3rem)] leading-[0.98] tracking-[-0.05em]">
              {language === "zh"
                ? "从一个人开始，也能按团队方式严肃落地。"
                : "Start with one seat, then grow into a serious team model."}
            </h2>
          </div>

          <Card id="personal" className="rounded-[2rem]">
            <CardHeader>
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[rgba(92,186,214,0.12)]">
                <Sparkles size={22} />
              </div>
              <Badge variant="subtle" className="w-fit">
                {t.nav.personal}
              </Badge>
              <CardTitle>{t.benefits.personalTitle}</CardTitle>
              <CardDescription>{t.benefits.personalBody}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {t.benefits.personalItems.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="flex gap-3 rounded-[1.2rem] border border-[color:var(--color-line)] bg-white/75 p-4">
                    <Icon className="mt-1 h-5 w-5 shrink-0 text-[var(--color-cyan)]" />
                    <div>
                      <div className="font-semibold">{item.title}</div>
                      <div className="mt-1 text-sm leading-7 text-[rgba(24,35,33,0.76)]">
                        {item.body}
                      </div>
                    </div>
                  </div>
                );
              })}
              <Button asChild className="mt-1 w-fit">
                <a href="/sign-up?motion=personal">
                  {t.hero.primaryCta}
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
              </Button>
            </CardContent>
          </Card>

          <Card id="enterprise" className="rounded-[2rem] bg-[linear-gradient(180deg,#15211f_0%,#101816_100%)] text-white">
            <CardHeader>
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
                <Building2 size={22} />
              </div>
              <Badge variant="inverse" className="w-fit">
                {t.nav.enterprise}
              </Badge>
              <CardTitle className="text-white">{t.benefits.enterpriseTitle}</CardTitle>
              <CardDescription className="text-white/72">{t.benefits.enterpriseBody}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              {t.benefits.enterpriseItems.slice(0, 3).map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="flex gap-3 rounded-[1.2rem] border border-white/10 bg-white/5 p-4">
                    <Icon className="mt-1 h-5 w-5 shrink-0 text-[var(--color-cyan)]" />
                    <div>
                      <div className="font-semibold text-white">{item.title}</div>
                      <div className="mt-1 text-sm leading-7 text-white/72">
                        {item.body}
                      </div>
                    </div>
                  </div>
                );
              })}
              <Button asChild variant="ghost" className="mt-1 w-fit">
                <a href="/enterprise">
                  {t.hero.secondaryCta}
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
              </Button>
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-5" aria-labelledby="testimonials-title">
          <div className="max-w-[52rem]">
            <Badge variant="default" className="mb-4 w-fit">
              {language === "zh" ? "客户反馈" : "Testimonials"}
            </Badge>
            <h2 id="testimonials-title" className="font-display text-[clamp(2rem,4vw,3.3rem)] leading-[0.98] tracking-[-0.05em]">
              {t.testimonials.title}
            </h2>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            {t.testimonials.items.map((item) => (
              <Card key={item.name}>
                <CardContent className="grid gap-5 p-6">
                  <div className="flex items-center gap-1 text-[var(--color-coral)]">
                    <BadgeCheck size={18} />
                    <BadgeCheck size={18} />
                    <BadgeCheck size={18} />
                    <BadgeCheck size={18} />
                    <BadgeCheck size={18} />
                  </div>
                  <p className="font-display text-xl leading-8 tracking-[-0.03em]">
                    {item.quote}
                  </p>
                  <Separator />
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarFallback>{item.initials}</AvatarFallback>
                    </Avatar>
                    <div className="grid gap-0.5">
                      <div className="font-semibold">{item.name}</div>
                      <div className="text-sm text-[rgba(24,35,33,0.62)]">{item.role}</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section id="faq" className="grid gap-5" aria-labelledby="faq-title">
          <div className="max-w-[52rem]">
            <Badge variant="default" className="mb-4 w-fit">
              {t.nav.faq}
            </Badge>
            <h2 id="faq-title" className="font-display text-[clamp(2rem,4vw,3.3rem)] leading-[0.98] tracking-[-0.05em]">
              {t.faq.title}
            </h2>
          </div>
          <Accordion type="single" collapsible className="grid gap-3">
            {t.faq.items.map((item, index) => (
              <AccordionItem key={item.question} value={`item-${index}`}>
                <AccordionTrigger>{item.question}</AccordionTrigger>
                <AccordionContent>{item.answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </section>

        <section className="rounded-[2rem] bg-[linear-gradient(180deg,#15211f_0%,#101816_100%)] p-6 text-white shadow-[var(--shadow-hard)]">
          <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
            <div className="grid gap-4">
              <Badge variant="inverse" className="w-fit">
                {language === "zh" ? "最终 CTA" : "Final CTA"}
              </Badge>
              <h2 className="font-display text-[clamp(2rem,4vw,3.2rem)] leading-[0.98] tracking-[-0.05em]">
                {t.finalCta.title}
              </h2>
              <p className="max-w-[40rem] text-base leading-8 text-white/72">
                {t.finalCta.description}
              </p>
            </div>
            <Card className="rounded-[1.8rem] border-white/10 bg-white/6 text-white shadow-none">
              <CardHeader>
                <CardTitle className="text-white">{t.footer.contactTitle}</CardTitle>
                <CardDescription className="text-white/70">{t.footer.contactBody}</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Input
                    type="email"
                    placeholder={t.finalCta.emailPlaceholder}
                    className="border-white/12 bg-white/95 text-[var(--color-ink)]"
                  />
                  <Button className="sm:min-w-[11rem]">{t.finalCta.primaryCta}</Button>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Button asChild variant="ghost" className="sm:min-w-[11rem]">
                    <a href="/enterprise">
                      {t.finalCta.secondaryCta}
                      <Network size={18} aria-hidden="true" />
                    </a>
                  </Button>
                  <Button asChild variant="outline" className="border-white/18 bg-transparent text-white hover:text-white sm:min-w-[11rem]">
                    <a href={`mailto:${t.footer.email}`}>
                      <Mail size={18} aria-hidden="true" />
                      {t.footer.email}
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <footer className="grid gap-6 pb-6 lg:grid-cols-[1fr_auto_auto] lg:items-end">
          <div className="grid gap-3">
            <a className="inline-flex items-center gap-3 font-bold tracking-[-0.03em]" href="/">
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-[linear-gradient(135deg,var(--color-cyan),var(--color-coral))] text-white shadow-[0_0_0_8px_rgba(92,186,214,0.14)]">
                <Command size={18} aria-hidden="true" />
              </span>
              <span className="font-display text-lg">Polaris</span>
            </a>
            <p className="max-w-[40rem] text-sm leading-7 text-[rgba(24,35,33,0.72)]">
              {t.footer.body}
            </p>
          </div>
          <div className="flex flex-wrap gap-3 text-sm font-medium text-[rgba(24,35,33,0.72)]">
            <a href="/sign-up?motion=personal">{t.nav.personal}</a>
            <a href="/enterprise">{t.nav.enterprise}</a>
            <a href="/sign-in">{t.nav.signIn}</a>
            {t.footer.legal.map((item) => (
              <a key={item} href={`/${item.toLowerCase().replace(/\s+/g, "-")}`}>
                {item}
              </a>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <Badge variant="default">{t.footer.pillars[0]}</Badge>
            <Badge variant="default">{t.footer.pillars[1]}</Badge>
            <Badge variant="subtle">
              <LockKeyhole size={14} aria-hidden="true" />
              {language === "zh" ? "平台治理" : "Governed shell"}
            </Badge>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default App;
