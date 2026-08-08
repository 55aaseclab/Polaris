import { useMemo, useState } from 'react'
import { Boxes, Sparkles, GitBranch } from 'lucide-react'
import salesSource from './examples/packs/sales-fulfillment.ord?raw'
import inventorySource from './examples/packs/inventory.ord?raw'
import notifySource from './examples/packs/notify.ord?raw'
import {
  createMockHost,
  DslInterpreter,
  DocStore,
  flattenDomain,
  flowsFromAst,
  flowsFromProgram,
  mapLoader,
  runPipeline,
  type DocRecord,
  type FfiCallLog,
  type RunInput,
  type RunResult,
} from 'polaris-workflow'
import { PipelinePanel } from './renderer/PipelinePanel'
import { FlowForm, type ExecMode } from './renderer/FlowForm'
import { OrderTable } from './renderer/OrderTable'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './components/ui/tabs'
import { Badge } from './components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './components/ui/card'
import { Separator } from './components/ui/separator'
import { Button } from './components/ui/button'
import { cn } from './lib/utils'

export default function App() {
  const loader = useMemo(
    () =>
      mapLoader({
        Inventory: inventorySource,
        Notify: notifySource,
      }),
    [],
  )

  const pipeline = useMemo(() => runPipeline(salesSource, { loader }), [loader])
  const store = useMemo(() => new DocStore(), [])
  const host = useMemo(() => {
    const ports = pipeline.ast ? flattenDomain(pipeline.ast).ports : []
    return createMockHost(ports)
  }, [pipeline.ast])
  const interpreter = useMemo(() => {
    if (!pipeline.ast) return null
    return new DslInterpreter(pipeline.ast, store, host)
  }, [pipeline.ast, store, host])

  const [mode, setMode] = useState<ExecMode>('interpret')
  const [records, setRecords] = useState<DocRecord[]>([])
  const [ffiLog, setFfiLog] = useState<FfiCallLog[]>([])
  const [tick, setTick] = useState(0)

  const flowViews = useMemo(() => {
    if (mode === 'interpret' && pipeline.ast) return flowsFromAst(pipeline.ast)
    if (mode === 'compile' && pipeline.program) return flowsFromProgram(pipeline.program)
    return []
  }, [mode, pipeline.ast, pipeline.program])

  function execute(flowName: string, input: RunInput): RunResult {
    let result: RunResult
    if (mode === 'interpret') {
      if (!interpreter) {
        return { ok: false, message: '解释器未就绪', mode: 'interpret', stepLog: [] }
      }
      result = interpreter.interpret(flowName, input)
    } else {
      if (!pipeline.program) {
        return { ok: false, message: 'Program 未编译', mode: 'compile', stepLog: [] }
      }
      result = pipeline.program.run(flowName, input, store, host)
    }
    setRecords(store.list())
    setFfiLog([...host.log])
    setTick((t) => t + 1)
    return result
  }

  const ready =
    pipeline.ok &&
    ((mode === 'interpret' && interpreter) || (mode === 'compile' && pipeline.program))

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card/80 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Boxes className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
                销售履约
                <Badge variant="secondary" className="font-normal">
                  跨域包
                </Badge>
              </h1>
              <p className="text-xs text-muted-foreground">
                import Inventory + Notify · port@ver · pipeline 糖
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-border bg-muted p-1">
              <Button
                type="button"
                size="sm"
                variant={mode === 'interpret' ? 'default' : 'ghost'}
                className={cn('h-8', mode === 'interpret' && 'shadow-sm')}
                onClick={() => setMode('interpret')}
              >
                解释执行
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === 'compile' ? 'default' : 'ghost'}
                className={cn('h-8', mode === 'compile' && 'shadow-sm')}
                onClick={() => setMode('compile')}
              >
                编译执行
              </Button>
            </div>
            <Badge variant="outline" className="hidden sm:inline-flex gap-1">
              <Sparkles className="h-3 w-3" />
              demo #{tick}
            </Badge>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6 space-y-6">
        <section className="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50/80 via-white to-emerald-50/50 p-5 space-y-3">
          <h2 className="text-base font-semibold">三联域包演示</h2>
          <p className="text-sm text-foreground/80 leading-relaxed max-w-3xl">
            <strong>SalesFulfillment</strong> import{' '}
            <code className="text-xs bg-muted px-1 rounded">Inventory^1.2</code> 与{' '}
            <code className="text-xs bg-muted px-1 rounded">Notify as N</code>；
            钉扎 <code className="text-xs bg-muted px-1 rounded">call ReserveStock@2.0.0</code>，
            通知走 <code className="text-xs bg-muted px-1 rounded">N.PushMessage</code>。
            <code className="text-xs bg-muted px-1 rounded">pipeline</code> 声明主路径元数据。
          </p>
          <div className="flex flex-wrap gap-2 text-xs items-center">
            <Badge variant="outline">Inventory（能力库）</Badge>
            <span className="text-muted-foreground">+</span>
            <Badge variant="outline">Notify as N</Badge>
            <span className="text-muted-foreground">→</span>
            <Badge variant="default">SalesFulfillment</Badge>
          </div>
          {pipeline.importGraph && pipeline.importGraph.length > 0 && (
            <div className="flex flex-wrap gap-2 text-xs font-mono text-muted-foreground">
              {pipeline.importGraph.map((g, i) => (
                <span key={i} className="rounded-md border border-border bg-card px-2 py-1">
                  {g.from} —import({g.versionRange})→ {g.to}
                </span>
              ))}
            </div>
          )}
          {pipeline.program?.pipelines?.map((p) => (
            <div
              key={p.name}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/80 px-3 py-2 text-sm"
            >
              <GitBranch className="h-4 w-4 text-primary" />
              <span className="font-medium">{p.title ?? p.name}</span>
              <Badge variant="secondary" className="font-mono text-[10px]">
                pipeline
              </Badge>
              <span className="text-muted-foreground">·</span>
              {p.steps.map((s, i) => (
                <span key={s} className="inline-flex items-center gap-1 font-mono text-xs">
                  {i > 0 && <span className="text-muted-foreground">→</span>}
                  <Badge variant="outline">{s}</Badge>
                </span>
              ))}
            </div>
          ))}
          {pipeline.program && pipeline.program.ports.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {pipeline.program.ports.map((p) => (
                <Badge
                  key={`${p.qualifiedName ?? p.name}@${p.version}`}
                  variant="outline"
                  className="font-mono text-[10px] font-normal"
                >
                  {(p.qualifiedName ?? p.name)}@{p.version}
                  {p.originDomain ? ` ←${p.originDomain}` : ''}
                </Badge>
              ))}
            </div>
          )}
        </section>

        <PipelinePanel result={pipeline} source={salesSource} />

        <Separator />

        {!ready ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-sm text-red-800 space-y-2">
            <p>DSL 管线失败，无法执行。</p>
            {pipeline.parseErrors.map((e, i) => (
              <div key={i}>{e.message}</div>
            ))}
            {pipeline.issues
              .filter((x) => x.level === 'error')
              .map((e, i) => (
                <div key={i}>
                  {e.code}: {e.message}
                </div>
              ))}
          </div>
        ) : (
          <>
            <OrderTable records={records} />

            {ffiLog.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>FFI 调用日志（Host）</CardTitle>
                  <CardDescription>
                    含版本：ReserveStock@2 · N.PushMessage@1 · ReleaseStock@1
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-2 max-h-48 overflow-auto">
                  {ffiLog.slice(0, 12).map((e, i) => (
                    <div
                      key={i}
                      className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono"
                    >
                      <span className={e.ok ? 'text-emerald-700' : 'text-red-700'}>
                        [{e.ok ? 'ok' : 'fail'}]
                      </span>{' '}
                      <span className="text-indigo-700">
                        {e.port}
                        {e.version ? `@${e.version}` : ''}
                      </span>
                      {e.stepId && <span className="text-muted-foreground"> · step {e.stepId}</span>}
                      <div className="text-muted-foreground mt-0.5 truncate">
                        in {JSON.stringify(e.input)} → out {JSON.stringify(e.output)}
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            <Tabs defaultValue={flowViews[0]?.name}>
              <TabsList className="w-full justify-start flex-wrap h-auto gap-1">
                {flowViews.map((f) => (
                  <TabsTrigger key={f.name} value={f.name}>
                    {f.title}
                  </TabsTrigger>
                ))}
              </TabsList>
              {flowViews.map((f) => (
                <TabsContent key={f.name} value={f.name}>
                  <FlowForm flow={f} mode={mode} records={records} onExecute={execute} />
                </TabsContent>
              ))}
            </Tabs>
          </>
        )}

        <footer className="pb-10 pt-4 text-center text-xs text-muted-foreground">
          SalesFulfillment · import 图已展开 · Host=Mock · {mode}
        </footer>
      </main>
    </div>
  )
}
