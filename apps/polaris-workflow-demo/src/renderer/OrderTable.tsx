import type { DocRecord } from 'polaris-workflow'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

const statusVariant: Record<string, 'secondary' | 'success' | 'warning' | 'default' | 'muted'> = {
  Draft: 'muted',
  Created: 'secondary',
  Accepted: 'secondary',
  Planned: 'secondary',
  Shipped: 'warning',
  Paid: 'success',
  Closed: 'default',
  Ordered: 'secondary',
  Stocked: 'success',
  Released: 'secondary',
  InProgress: 'warning',
  Done: 'success',
  // 摄影自动化
  Positioned: 'secondary',
  Captured: 'warning',
  InGallery: 'secondary',
  Retouched: 'warning',
  OnScreen: 'success',
  Failed: 'default',
}

export function OrderTable({ records }: { records: DocRecord[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>业务单据（DocStore）</CardTitle>
        <CardDescription>通用文档存储；entity 由 flow.on 决定，与电商无绑定</CardDescription>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            暂无单据。执行带 <code className="text-xs bg-muted px-1 rounded">create</code> 的 flow 后出现在此。
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">ID</th>
                  <th className="px-3 py-2 font-medium">Entity</th>
                  <th className="px-3 py-2 font-medium">摘要</th>
                  <th className="px-3 py-2 font-medium">状态</th>
                  <th className="px-3 py-2 font-medium">最近 flow</th>
                </tr>
              </thead>
              <tbody>
                {records.map((o) => (
                  <tr key={o.id} className="border-t border-border hover:bg-muted/30">
                    <td className="px-3 py-2.5 font-mono text-xs">{o.id}</td>
                    <td className="px-3 py-2.5 font-mono text-xs">{o.entity}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground max-w-[280px] truncate">
                      {Object.entries(o.data)
                        .slice(0, 4)
                        .map(([k, v]) => `${k}=${v}`)
                        .join(' · ')}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={statusVariant[o.status] ?? 'outline'}>{o.status}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-xs">
                      {o.history[0] ? (
                        <span className="inline-flex items-center gap-1">
                          {o.history[0].flow}
                          <Badge
                            variant={o.history[0].mode === 'interpret' ? 'warning' : 'success'}
                            className="text-[10px]"
                          >
                            {o.history[0].mode}
                          </Badge>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
