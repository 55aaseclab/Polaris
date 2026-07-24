import { useEffect } from "react";
import {
  ArrowRight,
  Check,
  LockKeyhole,
  Network,
  ShieldCheck,
} from "lucide-react";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./components/ui/accordion";

const copy = {
    nav: ["产品能力", "安全与隔离", "常见问题"],
    signIn: "进入 Polaris",
    trial: "申请团队试点",
    heroKicker: "AI 工作空间",
    heroTitle: "让团队 AI 工作始终安全可控",
    heroBody:
      "把 AI 开发工具、运行环境、权限与项目上下文放进一个可管理的工作空间。成员更快开始，团队更安心交接。",
    heroPrimary: "进入 Polaris",
    heroSecondary: "申请团队试点",
    proof: ["成员、环境与凭证分离", "可选容器、Pod 或 VM 隔离", "项目经验留在团队，不留在个人机器"],
    scenariosKicker: "它为实际工作而设计",
    scenariosTitle: "不仅是一个聊天入口，还是团队的 AI 工作面",
    scenarios: [
      ["开发自动化", "在独立环境中运行 Codex、Claude Code 与团队工具，减少本机配置和环境漂移。"],
      ["团队工作空间", "把成员、工作区、凭证与工具配置组织在一起，新成员不用从零搭建。"],
      ["安全交接", "交接的是可继续运行的上下文与环境，而不是一份难以复现的说明文档。"],
    ],
    flowKicker: "从工作开始，到经验留下",
    flowTitle: "四步进入稳定的团队工作方式",
    flow: [
      ["01", "创建", "为项目创建独立工作空间，明确成员与归属，让责任更清楚。"],
      ["02", "配置", "按需连接 AI 工具、凭证和团队基础能力，减少重复配置。"],
      ["03", "运行", "在受控运行时中执行开发、自动化与协作任务，降低环境偏差。"],
      ["04", "沉淀", "保留项目上下文、交接快照与可复用的团队经验，方便后续复用。"],
    ],
    trustKicker: "安全不是附加项",
    trustTitle: "把权限和运行边界，\n放在产品默认路径里",
    trustBody: "Polaris 不要求所有团队使用同一种基础设施。你可以根据任务、数据与风险级别选择合适的隔离方式。",
    trust: [
      ["权限与凭证", "凭证按用户和工作空间管理，避免散落在个人设备。"],
      ["运行时隔离", "支持容器、Pod 与 VM 等隔离模型，按团队要求选择。"],
      ["操作可追溯", "把关键工作状态和交接信息留在可管理的产品边界内。"],
    ],
    audienceKicker: "适合从明确问题开始",
    audienceTitle: "先解决一个团队的真实阻塞点。",
    audience: [
      ["小团队试点", "正在把 AI 工具引入日常开发或运营，但不想让配置、权限和经验失控。", "申请团队试点"],
      ["已有 AI 工作流的团队", "已经在使用 AI 开发工具，希望把环境隔离、成员接入和交接做成标准能力。", "进入 Polaris"],
    ],
    faqKicker: "常见问题",
    faqTitle: "开始之前，先明确边界",
    faq: [
      ["数据在哪里？", "数据和运行环境由部署方式决定。Polaris 将用户、工作空间与凭证的归属关系显式化，方便团队按自己的基础设施和安全要求管理。"],
      ["如何做隔离？", "可按任务选择容器、Kubernetes Pod 或 VM 等运行时模型。隔离不是统一开关，而是与实际风险相匹配的部署选择。"],
      ["团队如何接入？", "从一个具体工作空间开始：确定成员、运行环境与所需工具，再逐步把可复用配置沉淀到团队。"],
      ["需要迁移现有工作方式吗？", "不需要一次性迁移。先把一个开发或自动化场景放进 Polaris，验证工作方式后再逐步扩展。"],
    ],
    finalTitle: "从一个线上的AI工作空间开始",
    finalBody: "告诉我们你希望团队先解决什么问题，我们一起确定合适的试点边界。",
    company: "简小弈科技",
    footer: "面向团队的可控 AI 工作空间",
};

function polarisSignInUrl(): string {
  const baseUrl = import.meta.env.VITE_POLARIS_PUBLIC_BASE_URL?.trim()
    || "https://polaris.jianxiaoyitech.com";
  return new URL("/sign-in", baseUrl).toString();
}

function App() {
  const t = copy;
  const signInUrl = polarisSignInUrl();

  useEffect(() => {
    const sections = Array.from(
      document.querySelectorAll<HTMLElement>("[data-section-hash]"),
    );
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      const hash = visible?.target.getAttribute("data-section-hash");
      if (!hash || window.location.hash === `#${hash}`) return;
      window.history.replaceState(null, "", `#${hash}`);
    }, { rootMargin: "-35% 0px -55%", threshold: [0, 0.1, 0.5] });
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="container header-inner">
          <a className="brand" href="#top" onClick={(event) => { event.preventDefault(); window.history.replaceState(null, "", "#top"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><span className="brand-mark">P</span>Polaris</a>
          <div className="header-actions"><a className="button button-secondary" href={signInUrl}>{t.signIn}</a></div>
        </div>
      </header>

      <main>
        <section className="hero-section" data-section-hash="top">
          <div className="container hero-grid">
            <div className="hero-copy">
              <h1>{t.heroTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h1>
              <p className="hero-body">{t.heroBody}</p>
              <div className="button-row">
                <a className="button button-primary" href={signInUrl}>{t.heroPrimary}<ArrowRight size={17} /></a>
                <a className="button button-secondary" href="mailto:contact@jianxiaoyitech.com">{t.heroSecondary}</a>
              </div>
              <ul className="proof-list">{t.proof.map((item) => <li key={item}><Check size={16} />{item}</li>)}</ul>
            </div>
            <figure className="product-frame" aria-label="Polaris workspace interface">
              <div className="product-bar"><span /><span /><span /><strong>polaris / workspace</strong></div>
              <div className="product-layout">
                <aside><b>POLARIS</b><span className="active">Workspace</span><span>Credentials</span><span>Members</span><span>Settings</span></aside>
                <div className="product-main"><div className="workspace-head"><div><small>WORKSPACE</small><h2>atlas-api</h2><p>team-platform · ready</p></div><span className="status">Running</span></div><div className="metric-grid"><div><small>Runtime</small><b>Container</b><em>Isolated</em></div><div><small>Credential</small><b>Scoped</b><em>Active</em></div><div><small>Handover</small><b>Snapshot</b><em>Retained</em></div></div><div className="activity"><small>RECENT ACTIVITY</small><p><i /> Workspace context retained for handover</p><p><i /> Runtime policy applied successfully</p></div></div>
              </div>
              <figcaption>Polaris 工作空间：把运行环境、凭证与交接状态放在一起。</figcaption>
            </figure>
          </div>
        </section>

        <section className="section" id="capabilities" data-section-hash="capabilities"><div className="container">
          <div className="section-heading"><p className="eyebrow">{t.scenariosKicker}</p><h2>{t.scenariosTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h2></div>
          <div className="three-up">{t.scenarios.map(([title, body], index) => <article className="feature-card" key={title}><span className="feature-number">0{index + 1}</span><h3>{title}</h3><p>{body}</p></article>)}</div>
        </div></section>

        <section className="section section-muted" id="security" data-section-hash="security"><div className="container security-grid">
          <div className="section-heading"><p className="eyebrow">{t.trustKicker}</p><h2>{t.trustTitle.split("\n").map((line) => <span key={line}>{line}</span>)}</h2><p>{t.trustBody}</p></div>
          <div className="trust-list">{t.trust.map(([title, body], index) => { const Icon = [LockKeyhole, Network, ShieldCheck][index]; return <article key={title}><Icon size={22} /><div><h3>{title}</h3><p>{body}</p></div></article>; })}</div>
        </div></section>

        <section className="section" id="workflow" data-section-hash="workflow"><div className="container">
          <div className="section-heading compact"><p className="eyebrow">{t.flowKicker}</p><h2>{t.flowTitle}</h2></div>
          <ol className="process-list">{t.flow.map(([number, title, body]) => <li key={number}><span>{number}</span><div><h3>{title}</h3><p>{body}</p></div></li>)}</ol>
        </div></section>

        <section className="section" id="faq" data-section-hash="faq"><div className="container narrow">
          <div className="section-heading compact"><p className="eyebrow">{t.faqKicker}</p><h2>{t.faqTitle}</h2></div>
          <Accordion type="single" collapsible className="faq-list">{t.faq.map(([question, answer], index) => <AccordionItem key={question} value={`faq-${index}`}><AccordionTrigger>{question}</AccordionTrigger><AccordionContent>{answer}</AccordionContent></AccordionItem>)}</Accordion>
        </div></section>

        <section className="final-cta" id="pilot" data-section-hash="pilot"><div className="container final-inner"><p className="eyebrow">POLARIS</p><h2>{t.finalTitle}</h2><p>{t.finalBody}</p><div className="final-button-row"><a className="button button-light" href={signInUrl}>{t.signIn}<ArrowRight size={17} /></a><a className="button button-light-outline" href="mailto:contact@jianxiaoyitech.com">{t.trial}</a></div></div></section>
      </main>

      <footer className="site-footer"><div className="container footer-inner"><div><a className="brand" href="#top" onClick={(event) => { event.preventDefault(); window.history.replaceState(null, "", "#top"); window.scrollTo({ top: 0, behavior: "smooth" }); }}><span className="brand-mark">P</span>Polaris</a><p>{t.footer}</p></div><div><p>{t.company}</p><a href="https://www.jianxiaoyitech.com">www.jianxiaoyitech.com</a></div></div></footer>
    </div>
  );
}

export default App;
