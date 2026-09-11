import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { runPipeline, trialToDot } from '../src/index.js'

const SOURCE = fs.readFileSync(
  new URL('../../../packs/cve-genie-trial/main.ord', import.meta.url),
  'utf8',
)

test('trialToDot preserves the executable graph contract in a deterministic projection', () => {
  const result = runPipeline(SOURCE)
  assert.equal(result.ok, true)
  const trial = result.ast?.trials?.[0]
  assert.ok(trial)

  const first = trialToDot(trial, result.ast?.ports, {
    metadata: ['synthetic metadata'],
    groups: [
      { id: 'all', label: 'All nodes', nodeIds: trial.nodes.map((node) => node.id) },
    ],
  })
  const second = trialToDot(trial, result.ast?.ports, {
    metadata: ['synthetic metadata'],
    groups: [
      { id: 'all', label: 'All nodes', nodeIds: trial.nodes.map((node) => node.id) },
    ],
  })

  assert.equal(first, second)
  assert.match(first, /^digraph trial \{/u)
  assert.match(first, /synthetic metadata/u)
  assert.match(first, /Data Processor/u)
  assert.match(first, /Repository Builder/u)
  assert.match(first, /feedback setupFeedbackRef as feedbackRef/u)
  assert.match(first, /feedback exploitFeedbackRef as exploitFeedbackRef/u)
  assert.match(first, /reset attempts/u)
  assert.match(first, /when setupAccepted == false/u)
  assert.match(first, /execution: ai \/ disposable \/ network deny/u)
  assert.match(first, /budget: 45m, cost 5, 128 transitions/u)
  assert.match(first, /artifacts \(9\)/u)
  assert.match(first, /reproductionArtifactRef: String \[report, plain\]/u)
  assert.equal((first.match(/^    node_\d+ \[/gmu) ?? []).length, trial.nodes.length)
  assert.equal((first.match(/ -> /gu) ?? []).length, trial.edges.length + 1)
})

test('trialToDot escapes labels before passing them to Graphviz', () => {
  const result = runPipeline(SOURCE)
  assert.equal(result.ok, true)
  const trial = result.ast?.trials?.[0]
  assert.ok(trial)
  const altered = {
    ...trial,
    title: 'quoted "trial"\\name\nnext',
  }
  const dot = trialToDot(altered, result.ast?.ports)
  assert.ok(dot.includes('quoted \\"trial\\"\\\\name\\nnext'))
})
