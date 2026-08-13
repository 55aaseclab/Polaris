import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  Search,
  Wrench,
} from "lucide-react";
import type {
  PolarisToolPortalCatalogRow,
  PolarisToolPortalDetail,
} from "polaris-tools/source";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "./components/ui/card.js";
import {
  catalogRows,
  filterToolPortalCatalogRows,
  formatLiveState,
  parseToolPortalRoute,
  toolDetail,
  TOOL_PORTAL_BASE_PATH,
  type ToolPortalCatalogFilter,
  type ToolPortalScopeFilter,
} from "./tool-portal-model.js";
import {
  isToolPortalRequestError,
  readToolPortalCatalog,
} from "./tool-portal-client.js";

interface RequestState<T> {
  readonly data: T | null;
  readonly error: { status: number; message: string } | null;
  readonly loading: boolean;
}

function useToolPortalNavigation(): {
  path: string;
  navigate: (path: string) => void;
} {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const navigate = useCallback((nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setPath(window.location.pathname);
  }, []);
  return { path, navigate };
}

export default function App() {
  const { path, navigate } = useToolPortalNavigation();
  const route = useMemo(() => parseToolPortalRoute(path), [path]);
  const selectedTool = route.slug ? toolDetail(route.slug) : undefined;

  if (route.slug && !selectedTool) {
    return (
      <ToolPortalShell navigate={navigate}>
        <NotFoundPage navigate={navigate} />
      </ToolPortalShell>
    );
  }

  return (
    <ToolPortalShell navigate={navigate}>
      {selectedTool ? (
        <ToolDetailPage tool={selectedTool} navigate={navigate} />
      ) : (
        <CatalogPage navigate={navigate} />
      )}
    </ToolPortalShell>
  );
}

function ToolPortalShell({
  navigate,
  children,
}: {
  navigate: (path: string) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="tool-root">
      <header className="tool-topbar">
        <div className="tool-topbar-inner">
          <a
            href={TOOL_PORTAL_BASE_PATH}
            className="tool-brand"
            onClick={(event) => {
              event.preventDefault();
              navigate(TOOL_PORTAL_BASE_PATH);
            }}
          >
            <span>Polaris Tools</span>
          </a>
        </div>
      </header>
      <main className="tool-main">{children}</main>
    </div>
  );
}

function CatalogPage({ navigate }: { navigate: (path: string) => void }) {
  const { data, error, loading } = useCatalogData();
  const tools = data ?? catalogRows();
  const [filter, setFilter] = useState<ToolPortalCatalogFilter>({
    query: "",
    scope: "all",
    packId: "",
  });
  const packOptions = useMemo(() => listPackOptions(tools), [tools]);
  const filteredTools = useMemo(
    () => filterToolPortalCatalogRows(tools, filter),
    [tools, filter],
  );
  const totalCallCount = useMemo(() => countToolCalls(tools), [tools]);
  const filteredCallCount = useMemo(
    () => countToolCalls(filteredTools),
    [filteredTools],
  );
  return (
    <div className="page-stack">
      <h1 className="sr-only">Polaris tool registry</h1>
      <ToolRegistryFilters
        filter={filter}
        onFilterChange={setFilter}
        packOptions={packOptions}
        filteredCallCount={filteredCallCount}
        filteredFlowCount={filteredTools.length}
        loading={loading}
        totalCallCount={totalCallCount}
        totalFlowCount={tools.length}
      />
      {error ? <InlineNotice label="Live catalog unavailable. Showing first-party common tools only." /> : null}
      <ToolRegistryTable tools={filteredTools} navigate={navigate} />
    </div>
  );
}

function useCatalogData(): RequestState<PolarisToolPortalCatalogRow[]> {
  const [state, setState] = useState<RequestState<PolarisToolPortalCatalogRow[]>>({
    data: null,
    error: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await readToolPortalCatalog();
        if (!cancelled) {
          setState({ data: response.tools, error: null, loading: false });
        }
      } catch (requestError) {
        if (cancelled) return;
        const status = isToolPortalRequestError(requestError) ? requestError.status : 500;
        const message = requestError instanceof Error ? requestError.message : String(requestError);
        setState({ data: null, error: { status, message }, loading: false });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

function ToolRegistryFilters({
  filter,
  onFilterChange,
  packOptions,
  filteredCallCount,
  filteredFlowCount,
  loading,
  totalCallCount,
  totalFlowCount,
}: {
  filter: ToolPortalCatalogFilter;
  onFilterChange: (filter: ToolPortalCatalogFilter) => void;
  packOptions: readonly { id: string; label: string }[];
  filteredCallCount: number;
  filteredFlowCount: number;
  loading: boolean;
  totalCallCount: number;
  totalFlowCount: number;
}) {
  const setScope = (scope: ToolPortalScopeFilter) => {
    onFilterChange({
      ...filter,
      scope,
      packId: scope === "common" ? "" : filter.packId,
    });
  };
  const setQuery = (query: string) => onFilterChange({ ...filter, query });
  const setPackId = (packId: string) => onFilterChange({ ...filter, packId });
  return (
    <section className="registry-filterbar" aria-label="Tool registry filters">
      <label className="registry-search">
        <Search className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">Search tools</span>
        <input
          value={filter.query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tools, flows, calls"
        />
      </label>
      <div className="scope-segments" aria-label="Tool scope">
        <FilterSegment label="All" active={filter.scope === "all"} onClick={() => setScope("all")} />
        <FilterSegment label="Common" active={filter.scope === "common"} onClick={() => setScope("common")} />
        <FilterSegment label="Pack flows" active={filter.scope === "domain-pack"} onClick={() => setScope("domain-pack")} />
      </div>
      <label className="pack-select">
        <span className="sr-only">Domain pack</span>
        <select
          value={filter.packId}
          disabled={packOptions.length === 0 || filter.scope === "common"}
          onChange={(event) => setPackId(event.target.value)}
        >
          <option value="">All packs</option>
          {packOptions.map((pack) => (
            <option value={pack.id} key={pack.id}>{pack.label}</option>
          ))}
        </select>
      </label>
      <span className="filter-count">
        {loading
          ? `${filteredFlowCount} (${totalFlowCount}) / ...`
          : `${filteredFlowCount} (${totalFlowCount}) / ${filteredCallCount} (${totalCallCount})`}
      </span>
    </section>
  );
}

function FilterSegment({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={active ? "is-active" : ""}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ToolRegistryTable({
  tools,
  navigate,
}: {
  tools: readonly PolarisToolPortalCatalogRow[];
  navigate: (path: string) => void;
}) {
  return (
    <>
      <div className="table-frame registry-table-frame">
        <table>
          <colgroup>
            <col className="tool-col" />
            <col className="scope-col" />
            <col className="calls-col" />
            <col className="effect-col" />
            <col className="state-col" />
          </colgroup>
          <thead>
            <tr>
              <th>Tool</th>
              <th>Scope</th>
              <th>Calls</th>
              <th>Effect</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.id}>
                <td>
                  <ToolNameCell tool={tool} navigate={navigate} />
                  <div className="table-subtitle mono">{tool.id}</div>
                  <div className="table-subtitle">{tool.summary}</div>
                </td>
                <td><ScopeCell tool={tool} /></td>
                <td><ToolCallsCell tool={tool} /></td>
                <td>{tool.effect}</td>
                <td><ReadinessBadge liveState={tool.liveState} /></td>
              </tr>
            ))}
            {tools.length === 0 ? <EmptyTableRow colSpan={5} label="No tools published" /> : null}
          </tbody>
        </table>
      </div>
      <MobileToolRegistryList tools={tools} navigate={navigate} />
    </>
  );
}

function MobileToolRegistryList({
  tools,
  navigate,
}: {
  tools: readonly PolarisToolPortalCatalogRow[];
  navigate: (path: string) => void;
}) {
  if (tools.length === 0) {
    return <div className="mobile-empty">No tools published</div>;
  }
  return (
    <div className="mobile-registry-list">
      {tools.map((tool) => (
        <section className="mobile-tool-row" key={tool.id}>
          <div className="mobile-tool-head">
            <div className="mobile-tool-name">
              <ToolNameCell tool={tool} navigate={navigate} />
              <div className="table-subtitle mono">{tool.id}</div>
            </div>
            <ReadinessBadge liveState={tool.liveState} />
          </div>
          <p className="mobile-tool-summary">{tool.summary}</p>
          <div className="mobile-tool-meta">
            <ScopeCell tool={tool} />
            <span>{tool.effect}</span>
          </div>
          <ToolCallsCell tool={tool} />
        </section>
      ))}
    </div>
  );
}

function listPackOptions(
  tools: readonly PolarisToolPortalCatalogRow[],
): readonly { id: string; label: string }[] {
  const packs = new Map<string, string>();
  for (const tool of tools) {
    if (!tool.domainPack) continue;
    packs.set(tool.domainPack.id, tool.scopeLabel);
  }
  return [...packs.entries()]
    .sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
    .map(([id, label]) => ({ id, label }));
}

function countToolCalls(tools: readonly PolarisToolPortalCatalogRow[]): number {
  return tools.reduce((total, tool) => total + tool.toolCalls.length, 0);
}

function ToolDetailPage({
  tool,
  navigate,
}: {
  tool: PolarisToolPortalDetail;
  navigate: (path: string) => void;
}) {
  return (
    <div className="page-stack">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate(TOOL_PORTAL_BASE_PATH)}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Registry
        </Button>
      </div>
      <PageHeading title={tool.name} detail={`${tool.id} · ${formatLiveState(tool.liveState)}`} />
      <div className="detail-grid">
        <Card>
          <CardHeader>
            <CardTitle>Contract</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="fact-list">
              <Fact label="Action" value={tool.actionId} mono />
              <Fact label="Port" value={`${tool.port}@${tool.portVersion}`} mono />
              <Fact label="Effect" value={tool.effect} />
              <Fact label="Risk" value={tool.risk} />
              <Fact label="Adapter" value={tool.adapter} />
              <Fact label="Credentials" value={tool.credentialPolicy} />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Live Gates</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="gate-list">
              {tool.requiredGates.map((gate) => (
                <Badge key={gate} variant="outline">{gate}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
      <div className="schema-grid">
        <SchemaPanel title="Input" schema={tool.inputSchema} />
        <SchemaPanel title="Output" schema={tool.outputSchema} />
      </div>
      <details className="example-details">
        <summary>
          <FileCode2 className="h-4 w-4" aria-hidden="true" />
          Workflow example
        </summary>
        <div className="example-stack">
          {tool.examples.map((example) => (
            <div key={example.title} className="example-block">
              <div className="example-title">{example.title}</div>
              <pre className="code-block"><code>{example.workflowSnippet}</code></pre>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function ScopeCell({
  tool,
}: {
  tool: Pick<PolarisToolPortalCatalogRow, "scope" | "scopeLabel" | "domainPack">;
}) {
  if (tool.scope !== "domain-pack" || !tool.domainPack) {
    return <span className="scope-pill">{tool.scopeLabel}</span>;
  }
  return (
    <div className="scope-cell">
      <span className="scope-pill is-domain-pack">{tool.scopeLabel}</span>
      <span className="table-subtitle mono">{tool.domainPack.id}@{tool.domainPack.version}</span>
    </div>
  );
}

function ToolNameCell({
  tool,
  navigate,
}: {
  tool: PolarisToolPortalCatalogRow;
  navigate: (path: string) => void;
}) {
  if (tool.scope !== "common") {
    return <div className="table-title">{tool.name}</div>;
  }
  return (
    <a
      href={tool.href}
      className="table-title tool-name-link"
      onClick={(event) => {
        event.preventDefault();
        navigate(tool.href);
      }}
    >
      {tool.name}
    </a>
  );
}

function ToolCallsCell({ tool }: { tool: PolarisToolPortalCatalogRow }) {
  if (tool.toolCalls.length === 0) {
    return <span className="muted-text">none</span>;
  }
  return (
    <div className="call-list">
      {tool.toolCalls.map((call) => (
        <span
          key={`${call.id}:${call.port}:${call.version}`}
          className="call-token mono"
          title={formatToolCallTitle(call)}
        >
          {call.port}
        </span>
      ))}
    </div>
  );
}

function formatToolCallTitle(
  call: PolarisToolPortalCatalogRow["toolCalls"][number],
): string {
  const target = call.unresolved
    ? "unresolved"
    : call.mappedToolId ?? call.builtin ?? call.effect;
  return `${call.port}@${call.version} -> ${target}`;
}

function SchemaPanel({
  title,
  schema,
}: {
  title: string;
  schema: Readonly<Record<string, { type: string; required?: boolean; description: string }>>;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="schema-list">
        {Object.entries(schema).map(([name, field]) => (
          <div key={name} className="schema-row">
            <div>
              <span className="mono schema-name">{name}</span>
              <span className="schema-type">{field.type}{field.required ? " · required" : ""}</span>
            </div>
            <p>{field.description}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PageHeading({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <section className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      {action ? <div className="heading-action">{action}</div> : null}
    </section>
  );
}

function InlineNotice({ label }: { label: string }) {
  return (
    <section className="inline-notice">
      <Wrench className="h-5 w-5" aria-hidden="true" />
      <p>{label}</p>
    </section>
  );
}

function ReadinessBadge({ liveState }: { liveState: string }) {
  const mocked = liveState === "mock-only";
  return (
    <span className={`readiness-badge${mocked ? "" : " is-blocked"}`}>
      {mocked
        ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        : <Wrench className="h-3.5 w-3.5" aria-hidden="true" />}
      {formatLiveState(liveState)}
    </span>
  );
}

function EmptyTableRow({ colSpan, label }: { colSpan: number; label: string }) {
  return (
    <tr>
      <td className="empty-cell" colSpan={colSpan}>{label}</td>
    </tr>
  );
}

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd className={mono ? "mono" : ""}>{value}</dd>
    </div>
  );
}

function NotFoundPage({ navigate }: { navigate: (path: string) => void }) {
  return (
    <div className="page-stack narrow-page">
      <PageHeading
        title="Tool not found"
        detail="The requested slug is not present in the Polaris tool catalog."
      />
      <Button variant="outline" onClick={() => navigate(TOOL_PORTAL_BASE_PATH)}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Registry
      </Button>
    </div>
  );
}
