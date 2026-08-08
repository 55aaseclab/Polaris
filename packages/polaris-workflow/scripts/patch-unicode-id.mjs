import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/dsl/parser.ts'
let s = readFileSync(path, 'utf8')

const helper = `
/** Unicode-aware identifier (e.g. ReserveStock, 任务单, 分拣臂) */
const ID = String.raw\`[\\p{L}_][\\p{L}\\p{N}_]*\`
function re(source: string, flags = ''): RegExp {
  const f = flags.includes('u') ? flags : flags + 'u'
  return new RegExp(source, f)
}
`

if (!s.includes('const ID = ')) {
  s = s.replace(
    'export interface ParseResult {\n  ok: boolean\n  ast?: DomainAst\n  errors: ParseError[]\n}\n',
    'export interface ParseResult {\n  ok: boolean\n  ast?: DomainAst\n  errors: ParseError[]\n}\n' + helper + '\n',
  )
}

// Simple global replace of ASCII id capture group used everywhere
// [A-Za-z_]\w*  → use carefully only inside regexes

const pairs = [
  [
    'line.match(/^([A-Za-z_]\\w*)\\s*:\\s*([A-Za-z_]\\w*)(\\?)?(?:\\s*=\\s*(.+))?$/)',
    'line.match(re(`^(${ID})\\\\s*:\\\\s*(${ID})(\\\\?)?(?:\\\\s*=\\\\s*(.+))?$`))',
  ],
  [
    'line.match(/^([A-Za-z_]\\w*)\\s*:\\s*([A-Za-z_]\\w*)(.*)$/)',
    'line.match(re(`^(${ID})\\\\s*:\\\\s*(${ID})(.*)$`))',
  ],
  ['header.match(/^flow\\s+([A-Za-z_]\\w*)/i)', 'header.match(re(`^flow\\\\s+(${ID})`, "i"))'],
  ['header.match(/\\bon\\s+([A-Za-z_]\\w*)/i)', 'header.match(re(`\\\\bon\\\\s+(${ID})`, "i"))'],
  ['text.slice(i).match(/^([A-Za-z_]\\w*)/)', 'text.slice(i).match(re(`^(${ID})`))'],
  [
    'blk.body.match(/([A-Za-z_]\\w*)\\s*->\\s*([A-Za-z_]\\w*)/)',
    'blk.body.match(re(`(${ID})\\\\s*->\\\\s*(${ID})`))',
  ],
  [
    'text.slice(i).match(/([A-Za-z_]\\w*)\\s*->\\s*([A-Za-z_]\\w*)/)',
    'text.slice(i).match(re(`(${ID})\\\\s*->\\\\s*(${ID})`))',
  ],
  ['header.match(/^port\\s+([A-Za-z_]\\w*)/i)', 'header.match(re(`^port\\\\s+(${ID})`, "i"))'],
  ['header.match(/^enum\\s+([A-Za-z_]\\w*)/i)', 'header.match(re(`^enum\\\\s+(${ID})`, "i"))'],
  ['header.match(/^entity\\s+([A-Za-z_]\\w*)/i)', 'header.match(re(`^entity\\\\s+(${ID})`, "i"))'],
  ['header.match(/^module\\s+([A-Za-z_]\\w*)/i)', 'header.match(re(`^module\\\\s+(${ID})`, "i"))'],
  [
    'part.match(/^call\\s+([A-Za-z_]\\w*)/i)',
    'part.match(re(`^call\\\\s+(${ID})`, "i"))',
  ],
  [
    'restLine.match(/^\\s*call\\s+([A-Za-z_]\\w*)/i)',
    'restLine.match(re(`^\\\\s*call\\\\s+(${ID})`, "i"))',
  ],
  [
    'part.trim().match(/^([A-Za-z_]\\w*)\\s*:\\s*([A-Za-z_]\\w*)$/)',
    'part.trim().match(re(`^(${ID})\\\\s*:\\\\s*(${ID})$`))',
  ],
  [
    'body.slice(i).match(/^([A-Za-z_]\\w*)(?:\\s+("([^"]*)"|\'([^\']*)\'))?/)',
    "body.slice(i).match(re(`^(${ID})(?:\\\\s+(\\\"([^\\\"]*)\\\"|'([^']*)'))?`))",
  ],
  [
    'const re = /\\b(entity|enum|flow|port)\\s+[A-Za-z_]\\w*/gi',
    'const memberRe = new RegExp(String.raw`\\b(entity|enum|flow|port)\\s+${ID}`, "giu")',
  ],
  // after renaming member re, fix exec loop variable if needed
  [
    'cleaned.match(/domain\\s+([A-Za-z_]\\w*)(?:\\s+version\\s+("([^"]*)"|\'([^\']*)\'))?/i)',
    'cleaned.match(re(`domain\\\\s+(${ID})(?:\\\\s+version\\\\s+(\\\"([^\\\"]*)\\\"|\\\'([^\\\']*)\\\'))?`, "i"))',
  ],
  [
    'cleaned.search(/\\b(module|entity|enum|flow|port)\\s+[A-Za-z_]/i)',
    'cleaned.search(new RegExp(String.raw`\\b(module|entity|enum|flow|port)\\s+${ID}`, "iu"))',
  ],
  [
    'const moduleRe = /\\bmodule\\s+[A-Za-z_]/gi',
    'const moduleRe = new RegExp(String.raw`\\bmodule\\s+${ID}`, "giu")',
  ],
]

let hit = 0
for (const [a, b] of pairs) {
  if (s.includes(a)) {
    s = s.split(a).join(b)
    hit++
  } else {
    console.log('MISS', JSON.stringify(a).slice(0, 70))
  }
}

// flow output + step output line regexes (multiline strings in source)
s = s.replace(
  /line\.match\(\n\s*\^\/\(\[A-Za-z_\]\\w\*\)[\s\S]*?label[\s\S]*?\)\n\s*\)/,
  (m) => {
    console.log('complex replace matched length', m.length)
    return m
  },
)

// Direct fix for parseFlowOutputs and parseStepOutputs if still ASCII
s = s.replace(
  `line.match(
      /^([A-Za-z_]\\w*)\\s*:\\s*([A-Za-z_]\\w*)(?:\\s+from\\s+([A-Za-z_]\\w*(?:\\.[A-Za-z_]\\w*)?))?(?:\\s+label\\s+("([^"]*)"|'([^']*)'))?/,
    )`,
  `line.match(
      re(\`^(\${ID})\\\\s*:\\\\s*(\${ID})(?:\\\\s+from\\\\s+(\${ID}(?:\\\\.\${ID})?))?(?:\\\\s+label\\\\s+("([^"]*)"|'([^']*)'))?\`),
    )`,
)

s = s.replace(
  `line.match(
      /^([A-Za-z_]\\w*)\\s*:\\s*([A-Za-z_]\\w*)(?:\\s+label\\s+("([^"]*)"|'([^']*)'))?/,
    )`,
  `line.match(
      re(\`^(\${ID})\\\\s*:\\\\s*(\${ID})(?:\\\\s+label\\\\s+("([^"]*)"|'([^']*)'))?\`),
    )`,
)

// Fix memberRe variable name usage
if (s.includes('const memberRe =') && s.includes('while ((match = re.exec(src))')) {
  s = s.replace('while ((match = re.exec(src))', 'while ((match = memberRe.exec(src))')
}

writeFileSync(path, s)
console.log('done hits', hit)
// show remaining ASCII id patterns
const left = s.match(/\[A-Za-z_\]/g)
console.log('remaining [A-Za-z_] count', left?.length ?? 0)
