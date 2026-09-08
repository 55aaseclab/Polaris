import assert from "node:assert/strict";
import test from "node:test";
import {
  editableFieldRows,
  groupEditableFields,
  hasPromptCompanion,
  isNonPromptStepFieldPath,
  isPromptDetailPath,
  isStepDetailPath,
  isInputArgumentPath,
  promptCompanionTooltip,
  inputArgumentValue,
} from "../lib/workflow-editable-fields.js";

test("editableFieldRows inserts an empty value row for grouped children", () => {
  const [group] = groupEditableFields([
    { path: "review_policy.minimum_confidence", value: "0.75" },
    { path: "review_policy.review_all_claims", value: "true" },
  ]);

  assert.deepEqual(editableFieldRows(group), [
    {
      key: "review_policy.__group",
      label: "review_policy",
      nested: false,
      value: null,
    },
    {
      key: "review_policy.minimum_confidence",
      label: "minimum_confidence",
      nested: true,
      value: "0.75",
    },
    {
      key: "review_policy.review_all_claims",
      label: "review_all_claims",
      nested: true,
      value: "true",
    },
  ]);
});

test("editableFieldRows keeps single fields on one row", () => {
  const [group] = groupEditableFields([
    { path: "analysis_id", value: "example-analysis" },
  ]);

  assert.deepEqual(editableFieldRows(group), [
    {
      key: "analysis_id",
      label: "analysis_id",
      nested: false,
      value: "example-analysis",
    },
  ]);
});

test("inputArgumentValue finds the value after a --input flag", () => {
  const fields = [
    { path: "steps[1].args[1]", value: "--input" },
    { path: "steps[1].args[2]", value: "inputs/input.json" },
    { path: "steps[1].args[3]", value: "--output" },
    { path: "steps[1].args[4]", value: "outputs/output.json" },
  ];

  assert.equal(
    inputArgumentValue(fields, "steps[1].args[1]"),
    "inputs/input.json",
  );
  assert.equal(inputArgumentValue(fields, "steps[1].args[3]"), null);
});

test("isInputArgumentPath attaches to the path value instead of the flag row", () => {
  const fields = [
    { path: "steps[1].args[1]", value: "--input" },
    { path: "steps[1].args[2]", value: "inputs/input.json" },
    { path: "steps[1].args[3]", value: "--output" },
    { path: "steps[1].args[4]", value: "outputs/output.json" },
  ];

  assert.equal(isInputArgumentPath(fields, "steps[1].args[1]"), false);
  assert.equal(isInputArgumentPath(fields, "steps[1].args[2]"), true);
  assert.equal(isInputArgumentPath(fields, "steps[1].args[4]"), false);
});

test("hasPromptCompanion detects sibling prompt specs for scalar fields", () => {
  const fields = [
    { path: "question", value: "What does the literature establish?" },
    { path: "question_prompt.method", value: "generate-text" },
    { path: "question_prompt.instruction", value: "Refine the question." },
    { path: "decision_context", value: "Research planning." },
  ];

  assert.equal(hasPromptCompanion(fields, "question"), true);
  assert.equal(hasPromptCompanion(fields, "question_prompt.method"), false);
  assert.equal(hasPromptCompanion(fields, "decision_context"), false);
});

test("--input path detects stage input_prompt as its prompt companion", () => {
  const fields = [
    { path: "steps[1].args[1]", value: "--input" },
    { path: "steps[1].args[2]", value: "inputs/input.json" },
    { path: "input_prompt.method", value: "generate-file" },
    { path: "input_prompt.instruction", value: "Generate the input file." },
  ];

  assert.equal(hasPromptCompanion(fields, "steps[1].args[2]"), true);
});

test("promptCompanionTooltip summarizes the hidden prompt fields", () => {
  const fields = [
    { path: "question", value: "What does the literature establish?" },
    { path: "question_prompt.method", value: "generate-text" },
    { path: "question_prompt.instruction", value: "Refine the question." },
    { path: "question_prompt.output_kind", value: "text" },
  ];

  assert.equal(
    promptCompanionTooltip(fields, "question"),
    [
      "Prompt 规格",
      "instruction: Refine the question.",
      "method: generate-text",
      "output_kind: text",
    ].join("\n"),
  );
  assert.equal(promptCompanionTooltip(fields, "decision_context"), null);
});

test("--input path uses input_prompt for its prompt tooltip", () => {
  const fields = [
    { path: "steps[1].args[1]", value: "--input" },
    { path: "steps[1].args[2]", value: "inputs/input.json" },
    { path: "input_prompt.method", value: "generate-file" },
    { path: "input_prompt.instruction", value: "Generate the input file." },
    { path: "input_prompt.output_kind", value: "json" },
  ];

  assert.equal(
    promptCompanionTooltip(fields, "steps[1].args[2]"),
    [
      "Prompt 规格",
      "instruction: Generate the input file.",
      "method: generate-file",
      "output_kind: json",
    ].join("\n"),
  );
});

test("isPromptDetailPath hides nested prompt config rows", () => {
  assert.equal(isPromptDetailPath("question_prompt.method"), true);
  assert.equal(isPromptDetailPath("question_prompt.instruction"), true);
  assert.equal(isPromptDetailPath("question"), false);
  assert.equal(isPromptDetailPath("steps[1].args[2]"), false);
});

test("isStepDetailPath hides non-editable step execution details", () => {
  assert.equal(isStepDetailPath("steps[1].id"), true);
  assert.equal(isStepDetailPath("steps[1].args[2]"), true);
  assert.equal(isStepDetailPath("question"), false);
  assert.equal(isStepDetailPath("review_policy.mode"), false);
});

test("isNonPromptStepFieldPath keeps only prompt-related fields under steps", () => {
  assert.equal(isNonPromptStepFieldPath("steps[1].id"), true);
  assert.equal(isNonPromptStepFieldPath("steps[1].args[2]"), true);
  assert.equal(isNonPromptStepFieldPath("steps[1].prompt.method"), false);
  assert.equal(isNonPromptStepFieldPath("steps[1].question_prompt.method"), false);
  assert.equal(isNonPromptStepFieldPath("question_prompt.method"), false);
  assert.equal(isNonPromptStepFieldPath("review_policy.mode"), false);
});
