import {
  type PortAst,
  type TrialAst,
  type TrialNodeAst,
} from './ast.js'
import { resolvePort } from './resolve.js'

/** A named visual grouping for trial nodes. */
export interface TrialVisualizationGroup {
  id: string
  label: string
  nodeIds: readonly string[]
}

export interface TrialVisualizationOptions {
  /** Text shown in the graph header in addition to the trial metadata. */
  metadata?: readonly string[]
  /** Optional phase/role groupings rendered as Graphviz clusters. */
  groups?: readonly TrialVisualizationGroup[]
  /** Include input, execution-policy, and artifact contract notes. */
  includeContracts?: boolean
}

function dotString(value: string): string {
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replace(/\r?\n/gu, '\\n')}"`
}

function dotAttribute(name: string, value: string): string {
  return `${name}=${dotString(value)}`
}

function clusterKey(id: string, index: number): string {
  const safe = id.replace(/[^A-Za-z0-9_]/gu, '_') || 'group'
  return `cluster_${safe}_${index}`
}

function duration(ms: number): string {
  if (ms === 0) return '0s'
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1_000 === 0) return `${ms / 1_000}s`
  return `${ms}ms`
}

function fieldLabel(field: { name: string; type: string; optional?: boolean }): string {
  return `${field.name}: ${field.type}${field.optional ? '?' : ''}`
}

function nodeColor(node: TrialNodeAst): string {
  switch (node.role) {
    case 'validator':
      return '#e7f5ed'
    case 'developer':
      return '#fff3d6'
    case 'critic':
      return '#f0e8ff'
    case 'sink':
      return '#fbe9e7'
    case 'processor':
      return '#e8f1ff'
    default:
      return '#f1f5f9'
  }
}

function nodeLabel(node: TrialNodeAst, ports: readonly PortAst[]): string {
  const port = node.call
    ? resolvePort([...ports], node.call.name, node.call.version)
    : null
  const call = node.call?.raw ?? 'internal step'
  const effect = port?.effect ?? (node.call ? 'unresolved' : 'pure')
  const lines = [
    node.label,
    `role: ${node.role ?? 'node'}  |  ${call}  |  effect: ${effect}`,
    `uses: ${node.uses.length > 0 ? node.uses.join(', ') : '—'}`,
    `out: ${node.outputs.length > 0 ? node.outputs.map(fieldLabel).join(', ') : '—'}`,
    `retry max ${node.retry.maxAttempts}, backoff ${duration(node.retry.backoffMs)}`,
  ]
  if (node.timeoutMs !== undefined) lines.push(`timeout: ${duration(node.timeoutMs)}`)
  if (node.maxActions !== undefined) lines.push(`max actions: ${node.maxActions}`)
  if (node.capabilities.length > 0) {
    lines.push(`capabilities: ${node.capabilities.join(', ')}`)
  }
  return lines.join('\n')
}

function contractLabel(trial: TrialAst, metadata: readonly string[]): string {
  const lines = [
    `inputs (${trial.inputs.length})`,
    ...trial.inputs.map((field) => `${fieldLabel(field)}${field.required ? ' [required]' : ''}`),
    '',
    `execution: ${trial.execution.class} / ${trial.execution.isolation} / network ${trial.execution.network}`,
    `budget: ${duration(trial.budget.timeoutMs)}, cost ${trial.budget.maxCost}, ${trial.budget.maxTransitions} transitions`,
    ...metadata,
  ]
  return lines.join('\n')
}

function artifactLabel(trial: TrialAst): string {
  return [
    `artifacts (${trial.artifacts.length})`,
    ...trial.artifacts.map((artifact) => {
      const flags = [artifact.kind, artifact.redacted ? 'redacted' : 'plain']
      return `${artifact.name}: ${artifact.type} [${flags.join(', ')}]`
    }),
  ].join('\n')
}

function nodeStatements(
  trial: TrialAst,
  ports: readonly PortAst[],
  nodeKeys: ReadonlyMap<string, string>,
  nodeIds: readonly string[],
): string[] {
  return nodeIds.flatMap((nodeId) => {
    const node = trial.nodes.find((candidate) => candidate.id === nodeId)
    const key = nodeKeys.get(nodeId)
    if (!node || !key) return []
    const terminal = trial.terminal.includes(node.id)
    return [
      `    ${key} [`
        + [
          dotAttribute('label', nodeLabel(node, ports)),
          dotAttribute('fillcolor', nodeColor(node)),
          'peripheries=' + (terminal ? '2' : '1'),
        ].join(', ')
        + '];',
    ]
  })
}

/**
 * Convert a validated v0.4-trial graph into deterministic Graphviz DOT.
 *
 * The projection deliberately keeps the DSL contract visible: node calls,
 * effects, data dependencies, retry limits, capabilities, conditions,
 * feedback, execution policy, budgets, and artifacts are all represented.
 * It does not resolve host bindings or execute any port.
 */
export function trialToDot(
  trial: TrialAst,
  ports: readonly PortAst[] = [],
  options: TrialVisualizationOptions = {},
): string {
  const nodeKeys = new Map(trial.nodes.map((node, index) => [node.id, `node_${index}`]))
  const groups = options.groups ?? []
  const grouped = new Set<string>()
  const lines = [
    'digraph trial {',
    '  graph ['
      + [
        'rankdir=LR',
        'newrank=true',
        'splines=polyline',
        'pad=0.35',
        'nodesep=0.55',
        'ranksep=0.95',
        'bgcolor="#ffffff"',
        'fontname="Helvetica"',
        dotAttribute('label', [trial.title, ...(options.metadata ?? [])].join('\n')),
        'labelloc="t"',
        'labeljust="l"',
        'fontsize=18',
      ].join(', ')
      + '];',
    '  node [shape=box, style="rounded,filled", color="#64748b", penwidth=1.2, fontname="Helvetica", fontsize=10, margin="0.14,0.10"];',
    '  edge [color="#475569", penwidth=1.1, arrowsize=0.75, fontname="Helvetica", fontsize=9];',
    `  trial_start [shape=circle, style="filled", fillcolor="#0f172a", color="#0f172a", fontcolor="#ffffff", label="start", width=0.72, fixedsize=true];`,
  ]

  for (const [groupIndex, group] of groups.entries()) {
    const ids = group.nodeIds.filter((nodeId) => nodeKeys.has(nodeId))
    if (ids.length === 0) continue
    lines.push(`  subgraph ${clusterKey(group.id, groupIndex)} {`)
    lines.push(`    label=${dotString(group.label)};`)
    lines.push('    color="#cbd5e1"; style="rounded,dashed"; penwidth=1.1;')
    lines.push(...nodeStatements(trial, ports, nodeKeys, ids))
    lines.push('  }')
    for (const nodeId of ids) grouped.add(nodeId)
  }

  const ungrouped = trial.nodes
    .map((node) => node.id)
    .filter((nodeId) => !grouped.has(nodeId))
  lines.push(...nodeStatements(trial, ports, nodeKeys, ungrouped))

  if (options.includeContracts !== false) {
    lines.push('  subgraph cluster_contracts {')
    lines.push('    label="Trial contracts"; color="#cbd5e1"; style="rounded,dotted"; penwidth=1.1;')
    lines.push(
      `    trial_contract [shape=note, style="filled", fillcolor="#f8fafc", label=${dotString(contractLabel(trial, options.metadata ?? []))}];`,
    )
    lines.push(
      `    trial_artifacts [shape=note, style="filled", fillcolor="#f8fafc", label=${dotString(artifactLabel(trial))}];`,
    )
    lines.push('  }')
  }

  const startKey = nodeKeys.get(trial.start)
  if (startKey) lines.push(`  trial_start -> ${startKey};`)

  for (const edge of trial.edges) {
    const from = nodeKeys.get(edge.from)
    const to = nodeKeys.get(edge.to)
    if (!from || !to) continue
    const labels: string[] = []
    if (edge.when) labels.push(`when ${edge.when}`)
    if (edge.feedback) {
      labels.push(`feedback ${edge.feedback}${edge.feedbackAs ? ` as ${edge.feedbackAs}` : ''}`)
    }
    if (edge.resetAttempts) labels.push('reset attempts')
    const feedback = Boolean(edge.feedback || edge.resetAttempts || from === to)
    const attributes = [
      ...(labels.length > 0 ? [dotAttribute('label', labels.join('\n'))] : []),
      ...(feedback ? ['style=dashed', 'color="#b45309"', 'fontcolor="#92400e"'] : []),
    ]
    lines.push(`  ${from} -> ${to}${attributes.length > 0 ? ` [${attributes.join(', ')}]` : ''};`)
  }

  lines.push('}')
  return `${lines.join('\n')}\n`
}
