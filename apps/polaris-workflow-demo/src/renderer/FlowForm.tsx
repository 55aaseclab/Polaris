import { useMemo, useState } from 'react'
import { ArrowRight, Banknote, CheckCircle2, CircleAlert, PlusCircle, Truck, Workflow } from 'lucide-react'
import type { DocRecord, FlowView, RunInput, RunResult } from 'polaris-workflow'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const ICONS = {
  'plus-circle': PlusCircle,
  truck: Truck,
  banknote: Banknote,
  workflow: Workflow,
} as const

export type ExecMode = 'interpret' | 'compile'

interface FlowFormProps {
  flow: FlowView
  mode: ExecMode
  records: DocRecord[]
  onExecute: (flowName: string, input: RunInput) => RunResult
}

function defaultsFor(flow: FlowView): RunInput {
  const d: RunInput = {}
  for (const f of flow.fields) {
    if (f.inputKind === 'number' || f.inputKind === 'money') d[f.name] = f.min ?? 0
    else d[f.name] = ''
  }
  // demo seeds by field name（通用，不绑 flow 名）
  if ('customer' in d) d.customer = '上海星火贸易'
  if ('sku' in d) d.sku = 'SKU-10086'
  if ('qty' in d) d.qty = 2
  if ('amount' in d) d.amount = 1280
  if ('address' in d) d.address = '上海市浦东新区世纪大道 1 号'
  if ('warehouse' in d) d.warehouse = 'SH-01'
  if ('carrier' in d) d.carrier = '顺丰'
  if ('trackingNo' in d) d.trackingNo = 'SF20260807001'
  if ('method' in d) d.method = '银行转账'
  if ('reference' in d) d.reference = 'TXN-2026-0807-01'
  if ('material' in d) d.material = 'RM-铝材-6061'
  if ('supplier' in d) d.supplier = '苏南金属'
  // 摄影自动化
  if ('subject' in d) d.subject = '新品台灯 · 正面 45°'
  if ('targetPose' in d) d.targetPose = 'pose://rail-A/slot-3/front-0.85m'
  if ('speed' in d) d.speed = 35
  if ('exposure' in d) d.exposure = '1/125 f/5.6 ISO200'
  if ('focus' in d) d.focus = 'auto-center'
  if ('tags' in d) d.tags = 'product,hero,studio-auto'
  if ('preset' in d) d.preset = 'product-clean-v2'
  if ('screenId' in d) d.screenId = 'wall-led-01'
  return d
}

function DataflowPanel({ flow }: { flow: FlowView }) {
  return (
    <div className="rounded-lg border border-border bg-slate-50/80 p-3 space-y-3">
      <p className="text-xs font-semibold text-foreground flex items-center gap-2">
        数据流
        <span className="font-normal text-muted-foreground">input → step(uses/out) → flow.output</span>
      </p>

      {/* inputs */}
      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Input</p>
        <div className="flex flex-wrap gap-1.5">
          {flow.fields.length === 0 && <span className="text-xs text-muted-foreground">∅</span>}
          {flow.fields.map((f) => (
            <Badge key={f.name} variant="secondary" className="font-mono text-[10px]">
              {f.name}: {f.type}
            </Badge>
          ))}
        </div>
      </div>

      {/* steps */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Steps</p>
        {flow.steps.map((s) => (
          <div
            key={s.id}
            className="rounded-md border border-border bg-card px-3 py-2 text-xs space-y-1.5"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant="outline" className="font-mono text-[10px]">
                {s.index + 1}
              </Badge>
              <span className="font-medium">{s.label}</span>
              <span className="font-mono text-muted-foreground text-[10px]">{s.id}</span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 pl-1">
              <span className="text-[10px] text-amber-800 font-medium">uses</span>
              {s.uses.length === 0 ? (
                <span className="text-[10px] text-muted-foreground">—</span>
              ) : (
                s.uses.map((u) => (
                  <Badge key={u} variant="warning" className="font-mono text-[10px] font-normal">
                    {u}
                  </Badge>
                ))
              )}
              {s.call && (
                <>
                  <ArrowRight className="h-3 w-3 text-muted-foreground mx-0.5" />
                  <span className="text-[10px] text-indigo-800 font-medium">call</span>
                  <Badge variant="default" className="font-mono text-[10px] font-normal bg-indigo-600">
                    {typeof s.call === 'string' ? s.call : String(s.call)}
                  </Badge>
                </>
              )}
              <ArrowRight className="h-3 w-3 text-muted-foreground mx-0.5" />
              <span className="text-[10px] text-emerald-800 font-medium">out</span>
              {s.outputs.length === 0 ? (
                <span className="text-[10px] text-muted-foreground">—</span>
              ) : (
                s.outputs.map((o) => (
                  <Badge key={o.name} variant="success" className="font-mono text-[10px] font-normal">
                    {o.name}: {o.type}
                  </Badge>
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {/* flow outputs */}
      <div>
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Flow output</p>
        <div className="flex flex-wrap gap-1.5">
          {flow.outputs.length === 0 && (
            <span className="text-xs text-amber-700">未声明 output（校验会警告）</span>
          )}
          {flow.outputs.map((o) => (
            <Badge key={o.name} variant="default" className="font-mono text-[10px] font-normal">
              {o.name}: {o.type}
              {o.from ? ` ← ${o.from}` : ''}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  )
}

export function FlowForm({ flow, mode, records, onExecute }: FlowFormProps) {
  const Icon = ICONS[flow.icon as keyof typeof ICONS] ?? Workflow
  const [values, setValues] = useState<RunInput>(() => defaultsFor(flow))
  const [last, setLast] = useState<RunResult | null>(null)
  const [busy, setBusy] = useState(false)

  const needsRecord = !flow.create
  const entity = flow.on
  const selectable = useMemo(() => {
    let list = entity ? records.filter((r) => r.entity === entity) : records
    if (!flow.requireExpr || flow.requireExpr === 'true') return list
    const eq = flow.requireExpr.match(/^status\s*==\s*([A-Za-z_]\w*)$/)
    if (eq) return list.filter((o) => o.status === eq[1])
    const inn = flow.requireExpr.match(/^status\s+in\s*\[([^\]]+)\]$/)
    if (inn) {
      const allowed = inn[1].split(',').map((s) => s.trim())
      return list.filter((o) => allowed.includes(o.status))
    }
    return list
  }, [records, flow.requireExpr, entity])

  function setField(name: string, raw: string) {
    const field = flow.fields.find((f) => f.name === name)
    if (field && (field.inputKind === 'number' || field.inputKind === 'money')) {
      setValues((v) => ({ ...v, [name]: raw === '' ? '' : Number(raw) }))
    } else {
      setValues((v) => ({ ...v, [name]: raw }))
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    const input = { ...values }
    if (needsRecord && selectable[0] && !input.recordId) {
      input.recordId = selectable[0].id
    }
    if (flow.fields.some((f) => f.name === 'paidAmount') && input.recordId) {
      const o = records.find((x) => x.id === String(input.recordId))
      const amt = o?.data.amount
      if (typeof amt === 'number' && (input.paidAmount === 0 || input.paidAmount === '' || input.paidAmount === undefined)) {
        input.paidAmount = amt
      }
    }
    const result = onExecute(flow.name, input)
    setLast(result)
    setBusy(false)
    if (result.ok && flow.create) setValues(defaultsFor(flow))
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-gradient-to-br from-slate-50 to-indigo-50/40 border-b border-border">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="flex items-center gap-2 flex-wrap">
              {flow.title}
              <Badge variant="secondary" className="font-mono text-[10px]">
                {flow.name}
              </Badge>
              {flow.on && (
                <Badge variant="outline" className="font-mono text-[10px]">
                  on {flow.on}
                </Badge>
              )}
              <Badge variant={mode === 'interpret' ? 'warning' : 'success'} className="font-normal">
                {mode === 'interpret' ? '解释执行' : '编译执行'}
              </Badge>
            </CardTitle>
            <CardDescription className="mt-1">{flow.description}</CardDescription>
          </div>
        </div>
        {flow.requireExpr && (
          <div className="mt-3 rounded-md bg-card/80 border border-border px-3 py-2 text-xs font-mono text-muted-foreground">
            require {'{'} {flow.requireExpr} {'}'}
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-5 space-y-4">
        <DataflowPanel flow={flow} />

        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {flow.fields.map((field) => {
              if (field.name === 'recordId' || field.name === 'orderId') {
                return (
                  <div key={field.name} className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor={`${flow.name}-${field.name}`}>
                      {field.label}
                      {field.required && <span className="text-destructive"> *</span>}
                    </Label>
                    <select
                      id={`${flow.name}-${field.name}`}
                      className="flex h-9 w-full rounded-md border border-border bg-card px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                      value={String(values[field.name] ?? values.recordId ?? '')}
                      onChange={(e) => {
                        setField(field.name, e.target.value)
                        if (field.name !== 'recordId') setField('recordId', e.target.value)
                      }}
                      required={field.required}
                    >
                      <option value="">选择单据…</option>
                      {selectable.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.id} · {String(o.data.customer ?? o.data.sku ?? o.entity)} · {o.status}
                        </option>
                      ))}
                    </select>
                    {selectable.length === 0 && (
                      <p className="text-xs text-amber-700">暂无满足守卫的单据，请先跑上游 flow。</p>
                    )}
                  </div>
                )
              }
              return (
                <div key={field.name} className="space-y-1.5">
                  <Label htmlFor={`${flow.name}-${field.name}`}>
                    {field.label}
                    {field.required && <span className="text-destructive"> *</span>}
                  </Label>
                  <Input
                    id={`${flow.name}-${field.name}`}
                    type={field.inputKind === 'text' ? 'text' : 'number'}
                    min={field.min}
                    step={field.inputKind === 'money' ? '0.01' : undefined}
                    placeholder={field.placeholder}
                    value={values[field.name] === undefined || values[field.name] === null ? '' : String(values[field.name])}
                    onChange={(e) => setField(field.name, e.target.value)}
                    required={field.required}
                  />
                </div>
              )
            })}
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={busy || (needsRecord && selectable.length === 0)}>
              {flow.primaryAction}
              <span className="opacity-70 text-xs font-normal">
                ({mode === 'interpret' ? 'interpret' : 'program.run'})
              </span>
            </Button>
          </div>
        </form>

        {last && (
          <div
            className={cn(
              'rounded-lg border p-3 space-y-3',
              last.ok ? 'border-emerald-200 bg-emerald-50/60' : 'border-red-200 bg-red-50/60',
            )}
          >
            <div className="flex items-center gap-2 text-sm font-medium flex-wrap">
              {last.ok ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              ) : (
                <CircleAlert className="h-4 w-4 text-red-600" />
              )}
              {last.message}
              <Badge variant={last.mode === 'interpret' ? 'warning' : 'success'}>{last.mode}</Badge>
              {last.event && (
                <Badge variant="outline">emit {last.event}</Badge>
              )}
            </div>

            {/* 运行时：每步 uses → out 实际值 */}
            {last.stepLog.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Step 运行轨迹</p>
                {last.stepLog.map((s) => (
                  <div key={s.id} className="rounded-md bg-white/70 border border-border/60 px-2.5 py-2 text-xs font-mono space-y-1">
                    <div className="flex gap-2 items-center">
                      <span className={s.ok ? 'text-emerald-700' : 'text-red-700'}>[{s.ok ? 'ok' : 'fail'}]</span>
                      <span className="font-sans font-medium">{s.label}</span>
                      <span className="text-muted-foreground">{s.id}</span>
                    </div>
                    {s.used && Object.keys(s.used).length > 0 && (
                      <div className="text-[11px] text-amber-900/90">
                        uses{' '}
                        {Object.entries(s.used)
                          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                          .join(' · ')}
                      </div>
                    )}
                    {s.call && (
                      <div className="text-[11px] text-indigo-900/90">
                        call {s.call}
                        {s.ffi ? ' · via Host (FFI)' : ''}
                      </div>
                    )}
                    {s.produced && Object.keys(s.produced).length > 0 && (
                      <div className="text-[11px] text-emerald-900/90">
                        out{' '}
                        {Object.entries(s.produced)
                          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                          .join(' · ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* flow output */}
            {last.outputs && Object.keys(last.outputs).length > 0 && (
              <div>
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Flow output 结果</p>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(last.outputs).map(([k, v]) => (
                    <Badge key={k} variant="default" className="font-mono text-[10px] font-normal">
                      {k} = {v === undefined ? '∅' : JSON.stringify(v)}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {last.record && (
              <p className="text-xs text-muted-foreground">
                单据 <span className="font-mono">{last.record.id}</span> · {last.record.entity} ·{' '}
                <Badge variant="secondary">{last.record.status}</Badge>
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
