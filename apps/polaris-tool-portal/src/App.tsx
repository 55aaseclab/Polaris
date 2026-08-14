import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  FileCode2,
  Search,
  Route,
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
  domainPackToolRow,
  filterToolPortalCatalogRows,
  formatLiveState,
  parseToolPortalRoute,
  toolDetail,
  TOOL_PORTAL_BASE_PATH,
  type ToolPortalCatalogFilter,
  type ToolPortalRoute,
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
      ) : route.packId && route.packSlug ? (
        <DomainPackFlowRoute route={route} navigate={navigate} />
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
                  <RegistryIdLine tool={tool} />
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

function DomainPackFlowRoute({
  route,
  navigate,
}: {
  route: ToolPortalRoute;
  navigate: (path: string) => void;
}) {
  const { data, error, loading } = useCatalogData();
  const tools = data ?? catalogRows();
  const flowTool = domainPackToolRow(tools, route);

  if (flowTool) {
    return <DomainPackFlowPage tool={flowTool} navigate={navigate} />;
  }

  if (loading) {
    return (
      <div className="page-stack narrow-page">
        <PageHeading title="Loading pack flow" detail="Reading the Polaris tool catalog." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-stack narrow-page">
        <Button variant="ghost" size="sm" onClick={() => navigate(TOOL_PORTAL_BASE_PATH)}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Registry
        </Button>
        <InlineNotice label="Live catalog unavailable. Domain Pack flow details require the Polaris catalog." />
      </div>
    );
  }

  return <NotFoundPage navigate={navigate} />;
}

function DomainPackFlowPage({
  tool,
  navigate,
}: {
  tool: PolarisToolPortalCatalogRow;
  navigate: (path: string) => void;
}) {
  const pack = tool.domainPack;
  const flowId = domainPackFlowId(tool);
  return (
    <div className="page-stack">
      <div>
        <Button variant="ghost" size="sm" onClick={() => navigate(TOOL_PORTAL_BASE_PATH)}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Registry
        </Button>
      </div>
      <PageHeading
        title={tool.name}
        detail={`${pack?.name ?? tool.scopeLabel} · ${flowId} · ${tool.toolCalls.length} call${tool.toolCalls.length === 1 ? "" : "s"} · ${formatLiveState(tool.liveState)}`}
      />
      <div className="detail-grid">
        <Card>
          <CardHeader>
            <CardTitle>Pack Flow</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="fact-list">
              <Fact label="Pack" value={pack ? `${pack.id}@${pack.version}` : tool.scopeLabel} mono />
              <Fact label="Flow" value={flowId} mono />
              <Fact label="Effect" value={tool.effect} />
              <Fact label="Risk" value={tool.risk} />
              <Fact label="State" value={formatLiveState(tool.liveState)} />
              <Fact label="Digest" value={pack?.digest ?? "unavailable"} mono wide />
              <Fact label="Registry ID" value={tool.id} mono wide />
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Mapped Tools</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mapped-call-list">
              {tool.toolCalls.map((call) => {
                const mapped = call.mappedToolId ? toolDetail(call.mappedToolId) : undefined;
                return (
                  <div className="mapped-call-row" key={`${call.id}:${call.port}:${call.version}`}>
                    <Route className="h-4 w-4" aria-hidden="true" />
                    <div>
                      <strong className="mono">{call.port}@{call.version}</strong>
                      <span>{call.unresolved ? "Unresolved" : mapped?.id ?? call.builtin ?? call.effect}</span>
                    </div>
                    {mapped ? (
                      <Button variant="outline" size="sm" onClick={() => navigate(mapped.href)}>
                        Open
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Inputs</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="field-token-list">
            {(tool.fields ?? []).map((field) => (
              <Badge key={field.id} variant="outline" title={formatFieldTitle(field)}>
                {field.label ?? field.id}{field.required ? " required" : ""}
              </Badge>
            ))}
            {tool.fields?.length ? null : <span className="muted-text">No inputs declared</span>}
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Call Effects</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="field-token-list">
            {tool.toolCalls.length > 0
              ? tool.toolCalls.map((call) => (
                <Badge key={`${call.id}:${call.port}`} variant="outline">
                  {call.id}: {call.effect}
                </Badge>
              ))
              : null}
            {tool.toolCalls.length === 0 ? <span className="muted-text">No tool calls declared</span> : null}
          </div>
        </CardContent>
      </Card>
    </div>
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
              <RegistryIdLine tool={tool} />
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
              <Fact label="Executor family" value={tool.adapter} />
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
      <span className="table-subtitle mono" title={`${tool.domainPack.id}@${tool.domainPack.version}`}>
        v{tool.domainPack.version}
      </span>
    </div>
  );
}

function RegistryIdLine({ tool }: { tool: PolarisToolPortalCatalogRow }) {
  return (
    <div className="table-subtitle mono registry-id-line" title={tool.id}>
      {tool.scope === "domain-pack" ? `flow: ${domainPackFlowId(tool)}` : tool.id}
    </div>
  );
}

function domainPackFlowId(tool: PolarisToolPortalCatalogRow): string {
  if (!tool.domainPack) return tool.id;
  const prefix = `domain-pack:${tool.domainPack.id}:`;
  return tool.id.startsWith(prefix) ? tool.id.slice(prefix.length) : tool.id;
}

function ToolNameCell({
  tool,
  navigate,
}: {
  tool: PolarisToolPortalCatalogRow;
  navigate: (path: string) => void;
}) {
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

function formatFieldTitle(
  field: NonNullable<PolarisToolPortalCatalogRow["fields"]>[number],
): string {
  return [
    field.id,
    field.type,
    field.placeholder ? `placeholder: ${field.placeholder}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
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
  wide = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "fact-wide" : undefined}>
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
