import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const htmlSource = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const cssSource = readFileSync(new URL("./index.css", import.meta.url), "utf8");

test("user page keeps session as a peer section beside profile and credentials", () => {
  assert.match(appSource, /account-tabs/u);
  assert.match(appSource, /activeTab === "session"/u);
  assert.match(appSource, /role="tabpanel"/u);
  assert.doesNotMatch(appSource, /className="peer-section"/u);
  assert.doesNotMatch(appSource, /<Card>\s*<CardHeader>\s*<CardTitle>会话/u);
  assert.doesNotMatch(appSource, /<p className="eyebrow">ACCOUNT<\/p>/u);
  assert.doesNotMatch(appSource, /<h1>账户<\/h1>/u);
  assert.doesNotMatch(appSource, /身份、凭证和当前会话。/u);
  assert.doesNotMatch(appSource, /className="brand-caption"/u);
  assert.doesNotMatch(appSource, /className="connection-badge"/u);
  assert.doesNotMatch(appSource, />实时<|>离线</u);
});

test("Portal declares and owns a light color scheme", () => {
  assert.match(htmlSource, /<meta name="color-scheme" content="light" \/>/u);
  assert.doesNotMatch(htmlSource, /color-scheme" content="dark"/u);
  assert.match(cssSource, /color-scheme:\s*light;/u);
  assert.doesNotMatch(cssSource, /color-scheme:\s*dark;/u);
  assert.match(cssSource, /--portal-surface-0:\s*#f7faf8;/u);
});

test("Portal exposes the host-first work journey", () => {
  for (const route of ["/work", "/setup", "/settings/workflows", "/work/runs/"]) {
    assert.match(appSource, new RegExp(route.replace("/", "\\/"), "u"));
  }
  assert.match(appSource, /PortalLayout active="workflows" session=\{session\} navigate=\{navigate\}><ProvisioningPage/u);
  for (const action of ["discover", "批准继续", "取消运行", "重试", "打开结果"]) {
    if (action === "discover") {
      assert.match(appSource, /settings-tabs/u);
    } else {
      assert.match(appSource, new RegExp(action, "u"));
    }
  }
  assert.doesNotMatch(appSource, /workflowExecutionModeLabel/u);
  assert.doesNotMatch(appSource, /Polaris host · Literature Review/u);
  assert.doesNotMatch(appSource, /VAULT DIRECTORY/u);
  assert.doesNotMatch(appSource, /<h1>主机<\/h1>/u);
  assert.doesNotMatch(appSource, /管理当前账户拥有的隔离运行时，并进入已授权的工作面。/u);
  assert.doesNotMatch(appSource, /WORKFLOW SETTINGS/u);
  assert.doesNotMatch(appSource, /<h1>工作流设置<\/h1>/u);
  assert.doesNotMatch(appSource, /工作流定义在 Vault 外部管理；每次运行时再选择执行 Vault。/u);
  assert.match(appSource, /vault-filter-tabs/u);
  assert.match(appSource, /处理中/u);
  assert.match(appSource, /未运行/u);
  assert.doesNotMatch(appSource, /metric-strip/u);
  assert.match(appSource, /onClick=\{\(\) => setCreateOpen\(true\)\}/u);
  assert.match(appSource, /aria-label="新建 Vault"/u);
  assert.match(appSource, /className="vault-toolbar-button"/u);
  assert.doesNotMatch(appSource, /刷新 Vaults/u);
  assert.doesNotMatch(appSource, /handleRefresh/u);
  assert.match(appSource, /function CreateHostModal/u);
  assert.match(appSource, /await refreshHosts\(\)/u);
  assert.match(appSource, /onClose\(\);/u);
  assert.doesNotMatch(appSource, /const \[loading, setLoading\]/u);
  assert.match(appSource, /settings-tabs/u);
  assert.match(appSource, /完成首次设置/u);
  assert.match(appSource, /activeTab === "enabled"/u);
  assert.match(appSource, /activeTab === "available"/u);
  assert.match(appSource, /className="settings-provision-button"/u);
  assert.match(appSource, /navigate\("\/setup\?returnTo=\/settings\/workflows"\)/u);
  assert.doesNotMatch(appSource, /activeTab === "runtime"/u);
  assert.match(appSource, /执行位置/u);
  assert.doesNotMatch(appSource, /FIRST-TIME SETUP/u);
  assert.doesNotMatch(appSource, /设置只需要一次/u);
  assert.doesNotMatch(appSource, /STEP \{step \+ 1\} \/ 3/u);
  assert.match(appSource, /aria-label="新建工作"/u);
  assert.doesNotMatch(appSource, /aria-label="回到工作台"/u);
});

test("work filters keep the new-work action beside the tabs", () => {
  assert.match(appSource, /className="work-filter-toolbar"/u);
  assert.match(appSource, /className="filter-tabs work-filter-tabs"/u);
  assert.match(appSource, /className="work-new-button"/u);
  assert.match(appSource, /className="work-new-button"[\s\S]*size="icon"/u);
  assert.match(cssSource, /\.work-filter-toolbar\s*\{[\s\S]*display:\s*flex;[\s\S]*justify-content:\s*space-between;/u);
  assert.match(cssSource, /\.work-filter-tabs\s*\{[\s\S]*flex:\s*1;/u);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.work-filter-toolbar\s*\{[\s\S]*align-items:\s*flex-start;[\s\S]*gap:\s*\.4rem;/u);
  assert.doesNotMatch(cssSource, /\.work-filter-toolbar\s*\{[\s\S]*flex-direction:\s*column-reverse;/u);
  assert.match(cssSource, /\.work-new-button\s*\{[\s\S]*width:\s*2rem;[\s\S]*height:\s*2rem;/u);
});

test("run detail presents a copyable run id without a workflow prefix", () => {
  assert.doesNotMatch(appSource, /WORKFLOW RUN · \{run\.id\}/u);
  assert.match(appSource, /className="run-id-row"/u);
  assert.match(appSource, /className="run-id"/u);
  assert.match(appSource, /aria-label="复制 run-id"/u);
  assert.match(appSource, /copyTextToClipboard\(run\.id\)/u);
  assert.match(appSource, /role="status"/u);
  assert.match(cssSource, /\.run-id-row\s*\{[\s\S]*display:\s*flex;[\s\S]*align-items:\s*center;/u);
  assert.match(cssSource, /\.run-id-copy\s*\{[\s\S]*width:\s*2rem;[\s\S]*height:\s*2rem;/u);
});

test("run detail shows the creation date and time", () => {
  assert.match(appSource, /formatRunDateTime\(run\.createdAt\)/u);
  assert.doesNotMatch(appSource, /<dt>创建时间<\/dt><dd>\{run\.createdAt\.slice\(11, 16\)\}<\/dd>/u);
});

test("run detail does not render an empty action divider", () => {
  assert.match(appSource, /\(canCancel \|\| canRetry\) && <div className="run-detail-actions"/u);
});

test("artifact preview supports text, structured data, and media files", () => {
  assert.match(appSource, /function ArtifactPreviewContent/u);
  assert.match(appSource, /kind === "image" && source/u);
  assert.match(appSource, /kind === "video" && source/u);
  assert.match(appSource, /kind === "audio" && source/u);
  assert.match(appSource, /kind === "pdf" && source/u);
  assert.match(appSource, /formatJsonArtifact\(content\)/u);
  assert.match(appSource, /artifactPreviewKind\(artifact\.name\)/u);
  assert.match(appSource, /if \(redacted\)/u);
  assert.match(cssSource, /\.artifact-modal\s*\{[\s\S]*overflow:\s*hidden;/u);
  assert.match(cssSource, /\.artifact-content\s*\{[\s\S]*overflow:\s*auto;/u);
  assert.match(cssSource, /\.artifact-pdf-content iframe\s*\{/u);
});

test("debug tab exposes the server run projection as a live inspector", () => {
  assert.match(appSource, /path === "\/debug"/u);
  assert.match(appSource, /link\("\/debug", "Debug", Bug, "debug"\)/u);
  assert.match(appSource, /function DebugPage/u);
  assert.match(appSource, /function DebugInspector/u);
  assert.match(appSource, /事件日志/u);
  assert.match(appSource, /运行事件轨道/u);
  assert.match(appSource, /refreshWorkflowRuns/u);
  assert.match(cssSource, /\.debug-layout\s*\{[\s\S]*grid-template-columns/u);
  assert.match(cssSource, /\.debug-flow-rail\s*\{/u);
  assert.match(cssSource, /\.debug-log-list\s*\{[\s\S]*overflow:\s*auto/u);
});

test("daily work surface is card-first and touch-aware", () => {
  assert.match(appSource, /className="card-first-layout"/u);
  assert.match(appSource, /function DeckPreview/u);
  assert.match(appSource, /className="work-grid-view"/u);
  assert.match(appSource, /layout="grid"/u);
  assert.match(appSource, /className="work-deck-view"/u);
  assert.match(appSource, /onPointerDown=\{isDeck \? handlePointerDown : undefined\}/u);
  assert.doesNotMatch(appSource, /className="deck-control deck-control-(skip|heart|accept)"/u);
  assert.match(appSource, /cn\("swipe-hint"/u);
  assert.match(appSource, /swipe-hint-skip/u);
  assert.match(appSource, /swipe-hint-detail/u);
  assert.match(appSource, />跳过</u);
  assert.match(appSource, />详情</u);
  assert.match(cssSource, /\.swipe-hint\s*\{[\s\S]*top:\s*50%;[\s\S]*left:\s*50%;[\s\S]*transform:\s*translate\(-50%,\s*-50%\)/u);
  assert.match(cssSource, /\.deck-card\.is-dragging::before/u);
  assert.match(cssSource, /filter:\s*grayscale\(1\)/u);
  assert.match(cssSource, /\.filter-tab\s*\{[\s\S]*font-size:\s*\.75rem;[\s\S]*line-height:\s*1rem;[\s\S]*white-space:\s*nowrap;/u);
  assert.doesNotMatch(appSource, /<aside className="card-support-column">/u);
  assert.doesNotMatch(appSource, /<CardTitle>可用工作流<\/CardTitle>/u);
  assert.doesNotMatch(appSource, /<CardTitle>执行中的 Vault<\/CardTitle>/u);
  assert.doesNotMatch(appSource, /aria-label="管理工作流"/u);
  assert.doesNotMatch(appSource, /POLARIS · WORK DECK/u);
  assert.doesNotMatch(appSource, />今天<\/strong>/u);
  assert.doesNotMatch(appSource, />工作卡片<\/h1>/u);
  assert.doesNotMatch(appSource, /className="deck-count"/u);
  assert.doesNotMatch(appSource, /className="deck-position"/u);
  assert.match(appSource, /className="filter-tab-count"/u);
  assert.doesNotMatch(cssSource, /\.card-deck-toolbar\s*\{[\s\S]*padding-bottom:\s*\.35rem;/u);
  assert.match(cssSource, /\.card-deck\s*\{[\s\S]*height:\s*calc\(100svh\s*-/u);
  assert.doesNotMatch(cssSource, /\.card-deck\s*\{[\s\S]*min-height:\s*(?:26|30)rem/u);
  assert.match(cssSource, /\.work-grid-view\s*\{[\s\S]*display:\s*grid;/u);
  assert.match(cssSource, /\.work-deck-view\s*\{[\s\S]*display:\s*none;/u);
  assert.match(cssSource, /\.grid-work-card\s*\{[\s\S]*height:\s*calc\(100svh\s*-\s*13rem\);[\s\S]*height:\s*calc\(100dvh\s*-\s*13rem\);/u);
  assert.match(appSource, /<CardContent className="work-card-content">/u);
  assert.match(cssSource, /\.grid-work-card\s*>\s*\.work-card-content\s*\{[\s\S]*overflow:\s*auto;/u);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.work-grid-view\s*\{[\s\S]*display:\s*none;/u);
  assert.match(cssSource, /@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.work-deck-view\s*\{[\s\S]*display:\s*block;/u);
});

test("workflow setup keeps Domain Pack and internal flow selection separate", () => {
  assert.match(appSource, /domainPackId/u);
  assert.match(appSource, /enabledWorkflowKeys/u);
  assert.match(appSource, /选择一个 Domain Pack 作为工作场景/u);
  assert.match(appSource, /groupWorkflowFlows\(selectedPack\.flows\)/u);
  assert.match(appSource, /groupTitle/u);
  assert.match(appSource, /groupWorkflowFlows/u);
  assert.match(cssSource, /\.workflow-group-heading\s*\{/u);
  assert.match(appSource, /settings-pack-tabs/u);
  assert.match(appSource, /const visibleFlows/u);
  assert.doesNotMatch(appSource, /toggleWorkflowPack/u);
  assert.doesNotMatch(appSource, /settings-pack-grid/u);
});

test("workflow setup scopes enabled keys to the selected Domain Pack", () => {
  assert.match(appSource, /const \[flowsInitialized, setFlowsInitialized\] = useState\(false\)/u);
  assert.match(appSource, /const existingKeys = enabledWorkflowKeys\.filter\(\(key\) => selectedPackFlowKeys\.includes\(key\)\)/u);
  assert.match(appSource, /const existingNextKeys = current\.filter\(\(key\) => nextKeys\.includes\(key\)\)/u);
  assert.match(appSource, /enabledWorkflowKeys: selectedPackEnabledFlowKeys/u);
});

test("workflow setup returns to its entry surface", () => {
  assert.match(appSource, /function setupReturnPath\(\): "\/work" \| "\/settings\/workflows"/u);
  assert.match(appSource, /get\("returnTo"\) === "\/settings\/workflows"/u);
  assert.match(appSource, /ProvisioningPage navigate=\{navigate\} returnPath=\{setupReturnPath\(\)\}/u);
  assert.match(appSource, /navigate\("\/setup\?returnTo=\/settings\/workflows"\)/u);
  assert.match(appSource, /navigate\(returnPath, true\)/u);
});
