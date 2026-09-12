import { parse } from './parser.js'
import { validate } from './validator.js'
import { compile, type Program } from './compiler.js'
import { resolveImports, type PackLoader } from './resolve.js'
import type { DomainAst, ParseError, ValidationIssue } from './ast.js'
import type { ToolResolver } from './validator.js'

export interface PipelineOptions {
  /** 跨域包 import 加载器；无 import 时可省略 */
  loader?: PackLoader
  /** Host-provided tool inventory; kept outside the DSL package. */
  toolResolver?: ToolResolver
}

export interface PipelineResult {
  ok: boolean
  source: string
  parseErrors: ParseError[]
  issues: ValidationIssue[]
  /** 原始 AST（未展开 import） */
  rawAst?: DomainAst
  /** 展开 import 后的 AST */
  ast?: DomainAst
  program?: Program
  importGraph?: { from: string; to: string; versionRange: string }[]
  stages: {
    parse: 'pass' | 'fail'
    resolve: 'pass' | 'fail' | 'skip'
    validate: 'pass' | 'fail' | 'skip'
    compile: 'pass' | 'fail' | 'skip'
  }
}

/** source → parse → resolve(import) → validate → compile */
export function runPipeline(source: string, options: PipelineOptions = {}): PipelineResult {
  const parsed = parse(source)
  if (!parsed.ok || !parsed.ast) {
    return {
      ok: false,
      source,
      parseErrors: parsed.errors,
      issues: [],
      stages: { parse: 'fail', resolve: 'skip', validate: 'skip', compile: 'skip' },
    }
  }

  const rawAst = parsed.ast
  let ast = rawAst
  let importGraph: PipelineResult['importGraph'] = []
  const resolveIssues: ValidationIssue[] = []

  if (rawAst.imports.length > 0) {
    if (!options.loader) {
      return {
        ok: false,
        source,
        parseErrors: [],
        issues: [
          {
            level: 'error',
            code: 'E_IMPORT_NO_LOADER',
            message: `域包声明了 import，但 pipeline 未提供 PackLoader`,
          },
        ],
        rawAst,
        stages: { parse: 'pass', resolve: 'fail', validate: 'skip', compile: 'skip' },
      }
    }
    const resolved = resolveImports(rawAst, options.loader)
    importGraph = resolved.graph
    resolveIssues.push(...resolved.issues)
    if (!resolved.ok || !resolved.ast) {
      return {
        ok: false,
        source,
        parseErrors: [],
        issues: resolveIssues,
        rawAst,
        importGraph,
        stages: { parse: 'pass', resolve: 'fail', validate: 'skip', compile: 'skip' },
      }
    }
    ast = resolved.ast
  }

  const validated = validate(ast, options.toolResolver)
  const issues = [...resolveIssues, ...validated.issues]
  if (!validated.ok) {
    return {
      ok: false,
      source,
      parseErrors: [],
      issues,
      rawAst,
      ast,
      importGraph,
      stages: {
        parse: 'pass',
        resolve: rawAst.imports.length ? 'pass' : 'skip',
        validate: 'fail',
        compile: 'skip',
      },
    }
  }

  const program = compile(ast)
  return {
    ok: true,
    source,
    parseErrors: [],
    issues,
    rawAst,
    ast,
    program,
    importGraph,
    stages: {
      parse: 'pass',
      resolve: rawAst.imports.length ? 'pass' : 'skip',
      validate: 'pass',
      compile: 'pass',
    },
  }
}
