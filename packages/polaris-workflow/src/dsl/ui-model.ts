import { flattenDomain, type DomainAst, type FlowAst } from './ast.js'
import { toMeta, type Program, type ProgramFlowMeta, type ProgramModuleMeta } from './compiler.js'

export type FlowView = ProgramFlowMeta
export type ModuleView = ProgramModuleMeta

export function flowsFromAst(ast: DomainAst): FlowView[] {
  return flattenDomain(ast).flows.map((f: FlowAst) => toMeta(f))
}

export function modulesFromAst(ast: DomainAst): ModuleView[] {
  return ast.modules.map((m) => ({
    name: m.name,
    code: m.code,
    title: m.title,
    description: m.description,
    outputs: m.outputs,
    flowNames: m.flows.map((f) => f.name),
  }))
}

export function flowsFromProgram(program: Program): FlowView[] {
  return program.flows.map((h) => h.meta)
}

export function modulesFromProgram(program: Program): ModuleView[] {
  return program.modules
}
