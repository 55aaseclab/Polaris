import type { PipelineResult } from 'polaris-workflow'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Check, X, Minus } from 'lucide-react'

function Stage({ name, status }: { name: string; status: 'pass' | 'fail' | 'skip' }) {
  const icon =
    status === 'pass' ? (
      <Check className="h-3.5 w-3.5" />
    ) : status === 'fail' ? (
      <X className="h-3.5 w-3.5" />
    ) : (
      <Minus className="h-3.5 w-3.5" />
    )
  const v = status === 'pass' ? 'success' : status === 'fail' ? 'warning' : 'muted'
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <Badge variant={v} className="gap-1">
        {icon}
        {status}
      </Badge>
      <span className="text-sm font-medium">{name}</span>
    </div>
  )
}

export function PipelinePanel({ result, source }: { result: PipelineResult; source: string }) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>两条执行路径（角色已纠正）</CardTitle>
          <CardDescription>
            <strong>解释器</strong>动态 walk AST；<strong>编译器</strong>产出 Program，之后
            <code className="mx-1 text-xs bg-muted px-1 rounded">program.run()</code>
            不再读 DSL
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 text-sm space-y-2">
              <div className="font-semibold text-amber-900">Interpreter · 动态 DSL</div>
              <ol className="list-decimal list-inside text-amber-950/80 space-y-1 text-xs font-mono">
                <li>持有 live DomainAst</li>
                <li>interpret(flow) 时查找 AST 节点</li>
                <li>逐条求值 require / steps</li>
                <li>可 load(newAst) 热替换</li>
              </ol>
            </div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 text-sm space-y-2">
              <div className="font-semibold text-emerald-900">Compiler · 编译后直接跑</div>
              <ol className="list-decimal list-inside text-emerald-950/80 space-y-1 text-xs font-mono">
                <li>AST → Program（闭包 + jsSource）</li>
                <li>require/steps 烘焙进 execute()</li>
                <li>program.run() 零 AST 访问</li>
                <li>可落盘、可缓存、可发布</li>
              </ol>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Stage name="Parser" status={result.stages.parse} />
            <Stage name="Resolve import" status={result.stages.resolve} />
            <Stage name="Validator" status={result.stages.validate} />
            <Stage name="Compiler → Program" status={result.stages.compile} />
          </div>

          {result.importGraph && result.importGraph.length > 0 && (
            <div className="rounded-md bg-muted/40 p-3 text-xs space-y-1">
              <div className="font-medium text-muted-foreground mb-1">Import 图</div>
              {result.importGraph.map((g, i) => (
                <div key={i} className="font-mono">
                  {g.from} —[{g.versionRange}]→ {g.to}
                </div>
              ))}
            </div>
          )}

          {result.program?.pipelines && result.program.pipelines.length > 0 && (
            <div className="rounded-md bg-muted/40 p-3 text-xs space-y-1">
              <div className="font-medium text-muted-foreground mb-1">Pipeline 糖</div>
              {result.program.pipelines.map((p) => (
                <div key={p.name} className="font-mono">
                  {p.title ?? p.name}: {p.steps.join(' → ')}
                </div>
              ))}
            </div>
          )}

          {result.parseErrors.length > 0 && (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {result.parseErrors.map((e, i) => (
                <div key={i}>{e.message}</div>
              ))}
            </div>
          )}

          {result.issues.length > 0 && (
            <div className="space-y-1">
              {result.issues.map((issue, i) => (
                <div
                  key={i}
                  className={
                    issue.level === 'error'
                      ? 'rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-800'
                      : 'rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900'
                  }
                >
                  <span className="font-mono font-semibold">{issue.code}</span> {issue.message}
                </div>
              ))}
            </div>
          )}

          {result.program && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
              <div className="rounded-md bg-muted/50 p-3">
                <div className="text-xs text-muted-foreground">实体</div>
                <div className="mt-1 font-medium">{result.program.entityNames.length}</div>
              </div>
              <div className="rounded-md bg-muted/50 p-3">
                <div className="text-xs text-muted-foreground">Ports (FFI)</div>
                <div className="mt-1 font-medium">{result.program.ports.length}</div>
              </div>
              <div className="rounded-md bg-muted/50 p-3">
                <div className="text-xs text-muted-foreground">Flows</div>
                <div className="mt-1 font-medium">{result.program.flows.length}</div>
              </div>
              <div className="rounded-md bg-muted/50 p-3">
                <div className="text-xs text-muted-foreground mb-1">Port 符号</div>
                <div className="flex flex-wrap gap-1">
                  {result.program.ports.map((p) => (
                    <Badge
                      key={`${p.qualifiedName ?? p.name}@${p.version}`}
                      variant="outline"
                      className="font-mono text-[10px]"
                    >
                      {(p.qualifiedName ?? p.name)}@{p.version}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>源码 / 编译产物</CardTitle>
          <CardDescription>
            {result.program
              ? `${result.program.title} · v${result.program.version} · ${result.program.fingerprint}`
              : '未编译'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="ord">
            <TabsList>
              <TabsTrigger value="ord">DSL 源码 .ord</TabsTrigger>
              <TabsTrigger value="js">Compiler 输出 .js</TabsTrigger>
            </TabsList>
            <TabsContent value="ord">
              <pre className="max-h-[380px] overflow-auto rounded-lg bg-slate-950 p-4 text-[11px] leading-relaxed text-slate-100 font-mono">
                {source}
              </pre>
            </TabsContent>
            <TabsContent value="js">
              <pre className="max-h-[380px] overflow-auto rounded-lg bg-slate-950 p-4 text-[11px] leading-relaxed text-emerald-100 font-mono">
                {result.program?.jsSource ?? '// compile failed'}
              </pre>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
