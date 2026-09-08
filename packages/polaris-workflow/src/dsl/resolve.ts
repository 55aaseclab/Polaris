/**
 * 域包解析：展开 import，合并符号，处理 port 版本与别名。
 */
import {
  flattenDomain,
  normalizeVersion,
  type DomainAst,
  type ImportAst,
  type PortAst,
  type ValidationIssue,
} from './ast.js'
import { parse } from './parser.js'
import { satisfies } from './semver.js'

export interface PackSource {
  source: string
  /** 可选路径，仅用于报错 */
  path?: string
}

/** 按 domain 名和可选版本范围加载源码 */
export type PackLoader = (domainName: string, versionRange?: string) => PackSource | null

export interface ResolveResult {
  ok: boolean
  /** 合并 import 后的 AST（供 validate/compile/interpret） */
  ast?: DomainAst
  issues: ValidationIssue[]
  /** 依赖图：本包 → 直接 import 的 domain */
  graph: { from: string; to: string; versionRange: string }[]
}

function push(
  issues: ValidationIssue[],
  level: ValidationIssue['level'],
  code: string,
  message: string,
  path?: string,
) {
  issues.push({ level, code, message, path })
}

function clonePort(p: PortAst, patch: Partial<PortAst>): PortAst {
  return { ...p, ...patch, inFields: [...p.inFields], outFields: [...p.outFields] }
}

/**
 * 递归加载并合并 import。
 * - 无 as：端口/实体/枚举并入当前作用域（同名冲突报错，除非完全同版本 port）
 * - 有 as：符号变为 `Alias.Name`（port.qualifiedName / entity.name）
 */
export function resolveImports(
  root: DomainAst,
  loader: PackLoader,
  stack: string[] = [],
): ResolveResult {
  const issues: ValidationIssue[] = []
  const graph: ResolveResult['graph'] = []

  if (stack.includes(root.name)) {
    push(issues, 'error', 'E_IMPORT_CYCLE', `循环 import: ${[...stack, root.name].join(' → ')}`)
    return { ok: false, issues, graph }
  }

  const nextStack = [...stack, root.name]
  const merged: DomainAst = {
    ...root,
    imports: [...root.imports],
    enums: root.enums.map((e) => ({ ...e, values: [...e.values] })),
    entities: root.entities.map((e) => ({ ...e, fields: [...e.fields] })),
    ports: root.ports.map((p) => clonePort(p, { version: normalizeVersion(p.version || '1.0.0') })),
    flows: [...root.flows],
    pipelines: root.pipelines ? root.pipelines.map((p) => ({ ...p, steps: [...p.steps] })) : [],
    trials: root.trials ? root.trials.map((trial) => ({
      ...trial,
      inputs: trial.inputs.map((input) => ({ ...input })),
      nodes: trial.nodes.map((node) => ({
        ...node,
        uses: [...node.uses],
        outputs: node.outputs.map((output) => ({ ...output })),
        capabilities: [...node.capabilities],
        retry: { ...node.retry },
        ...(node.call ? { call: { ...node.call } } : {}),
      })),
      edges: trial.edges.map((edge) => ({ ...edge })),
      terminal: [...trial.terminal],
      budget: { ...trial.budget },
      execution: { ...trial.execution },
      artifacts: trial.artifacts.map((artifact) => ({ ...artifact })),
    })) : [],
    modules: root.modules.map((m) => ({
      ...m,
      entities: m.entities.map((e) => ({ ...e, fields: [...e.fields] })),
      enums: m.enums.map((e) => ({ ...e, values: [...e.values] })),
      ports: m.ports.map((p) => clonePort(p, { version: normalizeVersion(p.version || '1.0.0') })),
      flows: [...m.flows],
      outputs: [...m.outputs],
    })),
  }

  // 本地 port 默认 version
  for (const p of flattenDomain(merged).ports) {
    p.version = normalizeVersion(p.version || '1.0.0')
  }

  for (const imp of root.imports) {
    graph.push({ from: root.name, to: imp.domain, versionRange: imp.version })
    const loaded = loadDomain(imp, loader, issues)
    if (!loaded) continue

    if (!satisfies(loaded.version, imp.version)) {
      push(
        issues,
        'error',
        'E_IMPORT_VERSION',
        `import ${imp.domain} 需要 ${imp.version}，实际 ${loaded.version}`,
        `import.${imp.domain}`,
      )
      continue
    }

    // 递归展开被导入包自己的 import
    const inner = resolveImports(loaded, loader, nextStack)
    issues.push(...inner.issues)
    graph.push(...inner.graph)
    if (!inner.ok || !inner.ast) continue

    mergePack(merged, inner.ast, imp, issues)
  }

  const ok = !issues.some((i) => i.level === 'error')
  return { ok, ast: ok ? merged : merged, issues, graph }
}

function loadDomain(
  imp: ImportAst,
  loader: PackLoader,
  issues: ValidationIssue[],
): DomainAst | null {
  const pack = loader(imp.domain, imp.version)
  if (!pack) {
    push(issues, 'error', 'E_IMPORT_MISSING', `找不到域包 ${imp.domain}`, `import.${imp.domain}`)
    return null
  }
  const parsed = parse(pack.source)
  if (!parsed.ok || !parsed.ast) {
    push(
      issues,
      'error',
      'E_IMPORT_PARSE',
      `域包 ${imp.domain} 解析失败: ${parsed.errors.map((e) => e.message).join('; ')}`,
      pack.path ?? imp.domain,
    )
    return null
  }
  if (parsed.ast.name !== imp.domain) {
    push(
      issues,
      'warning',
      'W_IMPORT_NAME',
      `文件 domain 名为 ${parsed.ast.name}，import 写的是 ${imp.domain}`,
      `import.${imp.domain}`,
    )
  }
  return parsed.ast
}

function mergePack(target: DomainAst, source: DomainAst, imp: ImportAst, issues: ValidationIssue[]) {
  const prefix = imp.as
  const flat = flattenDomain(source)

  const rename = (n: string) => (prefix ? `${prefix}.${n}` : n)

  for (const en of flat.enums) {
    const name = rename(en.name)
    const existing = target.enums.find((e) => e.name === name)
    if (existing) {
      push(issues, 'error', 'E_IMPORT_ENUM_CLASH', `枚举冲突 ${name}（来自 ${source.name}）`)
      continue
    }
    target.enums.push({
      ...en,
      name,
      values: [...en.values],
      originDomain: source.name,
    })
  }

  for (const ent of flat.entities) {
    const name = rename(ent.name)
    if (target.entities.some((e) => e.name === name) || flattenDomain(target).entities.some((e) => e.name === name)) {
      // also check modules — keep simple: top-level only for import merge
      if (target.entities.some((e) => e.name === name)) {
        push(issues, 'error', 'E_IMPORT_ENTITY_CLASH', `实体冲突 ${name}（来自 ${source.name}）`)
        continue
      }
    }
    target.entities.push({
      ...ent,
      name,
      fields: [...ent.fields],
      originDomain: source.name,
      module: undefined,
    })
  }

  for (const p of flat.ports) {
    const qName = rename(p.name)
    const version = normalizeVersion(p.version || '1.0.0')
    const clash = target.ports.find(
      (x) => (x.qualifiedName ?? x.name) === qName && normalizeVersion(x.version) === version,
    )
    if (clash) {
      // 同名同版本：允许（幂等）
      continue
    }
    const nameClashOtherVer = target.ports.find(
      (x) => (x.qualifiedName ?? x.name) === qName && normalizeVersion(x.version) !== version,
    )
    if (nameClashOtherVer && !prefix) {
      // 无别名时同名不同版本并存，靠 @version 区分
      push(
        issues,
        'warning',
        'W_PORT_MULTI_VER',
        `port ${qName} 多版本: ${nameClashOtherVer.version} 与 ${version}（请用 Name@ver 调用）`,
      )
    }
    target.ports.push(
      clonePort(p, {
        name: prefix ? p.name : p.name, // bare name 保留
        qualifiedName: qName,
        version,
        originDomain: source.name,
        originDomainVersion: source.version,
        module: undefined,
      }),
    )
  }

  // 不合并 flows：流程属于各自域包，避免把别人的业务事务拉进来
  // （若需要编排跨包 flow，用本包 flow + call 外部 port）
}

/** 从目录/映射构造 loader */
export function mapLoader(map: Record<string, string>): PackLoader {
  return (name) => {
    const source = map[name]
    if (source == null) return null
    return { source, path: `map:${name}` }
  }
}

export function resolvePort(
  ports: PortAst[],
  refName: string,
  pinVersion?: string,
): PortAst | null {
  const cands = ports.filter((p) => (p.qualifiedName ?? p.name) === refName || p.name === refName)
  if (!cands.length) {
    // try qualified only match on name tail
    const tail = refName.includes('.') ? refName : null
    if (tail) {
      const c2 = ports.filter((p) => p.qualifiedName === refName)
      if (c2.length) return pickPort(c2, pinVersion)
    }
    return null
  }
  return pickPort(cands, pinVersion)
}

function pickPort(cands: PortAst[], pinVersion?: string): PortAst | null {
  if (pinVersion) {
    const v = normalizeVersion(pinVersion)
    return cands.find((p) => normalizeVersion(p.version) === v) ?? null
  }
  if (cands.length === 1) return cands[0]!
  // 多版本无 pin：取最高版本
  return [...cands].sort((a, b) => {
    const pa = normalizeVersion(a.version).split('.').map(Number)
    const pb = normalizeVersion(b.version).split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      const d = (pb[i] ?? 0) - (pa[i] ?? 0)
      if (d) return d
    }
    return 0
  })[0]!
}
