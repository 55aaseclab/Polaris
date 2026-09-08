export type EditableField = {
  path: string;
  value: string;
};

export type GroupedEditableField = {
  child: string | null;
  path: string;
  value: string;
};

export type EditableFieldGroup = {
  items: GroupedEditableField[];
  root: string;
};

export type EditableFieldRow = {
  key: string;
  nested: boolean;
  label: string;
  value: string | null;
};

const STEP_INPUT_ARGUMENT_PATH = /^(.*\.args\[)(\d+)\]$/;

function promptCompanionPrefix(
  fields: EditableField[],
  fieldPath: string,
): string | null {
  const directPrefix = `${fieldPath}_prompt.`;
  if (fields.some((field) => field.path.startsWith(directPrefix))) {
    return directPrefix;
  }

  if (isInputArgumentPath(fields, fieldPath)) {
    const inputPrefix = "input_prompt.";
    if (fields.some((field) => field.path.startsWith(inputPrefix))) {
      return inputPrefix;
    }
  }

  return null;
}

export function displayEditableFieldLabel(rawLabel: string): string {
  return rawLabel
    .replaceAll("_prompt.", ".")
    .replace(/_prompt$/g, "");
}

export function groupEditableFields(
  fields: EditableField[],
): EditableFieldGroup[] {
  const groups = new Map<string, EditableFieldGroup>();

  for (const field of fields) {
    const [root, ...rest] = field.path.split(".");
    const child = rest.length > 0 ? rest.join(".") : null;
    const existing = groups.get(root);

    if (existing) {
      existing.items.push({ child, path: field.path, value: field.value });
      continue;
    }

    groups.set(root, {
      root,
      items: [{ child, path: field.path, value: field.value }],
    });
  }

  return [...groups.values()];
}

export function sortEditableFieldGroupsForDisplay(
  groups: EditableFieldGroup[],
): EditableFieldGroup[] {
  return [...groups].sort((left, right) => {
    const leftIsStep = isStepDetailPath(left.root);
    const rightIsStep = isStepDetailPath(right.root);
    if (leftIsStep !== rightIsStep) return leftIsStep ? 1 : -1;
    return 0;
  });
}

export function editableFieldRows(group: EditableFieldGroup): EditableFieldRow[] {
  const hasChildren = group.items.some((item) => item.child);
  if (!hasChildren) {
    return group.items.map((item) => ({
      key: item.path,
      nested: false,
      label: displayEditableFieldLabel(group.root),
      value: item.value,
    }));
  }

  return [
    {
      key: `${group.root}.__group`,
      nested: false,
      label: displayEditableFieldLabel(group.root),
      value: null,
    },
    ...group.items.map((item) => ({
      key: item.path,
      nested: true,
      label: displayEditableFieldLabel(item.child ?? item.path),
      value: item.value,
    })),
  ];
}

/** Returns the argument paired with a `--input` step flag, when present. */
export function inputArgumentValue(
  fields: EditableField[],
  flagPath: string,
): string | null {
  const flag = fields.find((field) => field.path === flagPath);
  if (flag?.value !== "--input") return null;

  const match = flagPath.match(STEP_INPUT_ARGUMENT_PATH);
  if (!match) return null;
  const argumentIndex = Number(match[2]) + 1;
  if (!Number.isSafeInteger(argumentIndex)) return null;

  const valuePath = `${match[1]}${argumentIndex}]`;
  return fields.find((field) => field.path === valuePath)?.value ?? null;
}

/** Returns true when the current editable field is the value paired with `--input`. */
export function isInputArgumentPath(
  fields: EditableField[],
  valuePath: string,
): boolean {
  const match = valuePath.match(STEP_INPUT_ARGUMENT_PATH);
  if (!match) return false;
  const argumentIndex = Number(match[2]);
  if (!Number.isSafeInteger(argumentIndex) || argumentIndex <= 1) return false;
  const flagPath = `${match[1]}${argumentIndex - 1}]`;
  return fields.find((field) => field.path === flagPath)?.value === "--input";
}

/** Returns true when a scalar field has a sibling `<field>_prompt.*` spec. */
export function hasPromptCompanion(
  fields: EditableField[],
  fieldPath: string,
): boolean {
  return promptCompanionPrefix(fields, fieldPath) !== null;
}

export function promptCompanionTooltip(
  fields: EditableField[],
  fieldPath: string,
): string | null {
  const prefix = promptCompanionPrefix(fields, fieldPath);
  if (!prefix) return null;
  const promptFields = fields
    .filter((field) => field.path.startsWith(prefix))
    .sort((left, right) => left.path.localeCompare(right.path));

  const lines = ["Prompt 规格"];
  for (const field of promptFields) {
    lines.push(`${field.path.slice(prefix.length)}: ${field.value}`);
  }
  return lines.join("\n");
}

export function isPromptDetailPath(fieldPath: string): boolean {
  return fieldPath.includes("_prompt.");
}

export function isStepDetailPath(fieldPath: string): boolean {
  return fieldPath === "steps" || fieldPath.startsWith("steps[");
}

export function isNonPromptStepFieldPath(fieldPath: string): boolean {
  if (!isStepDetailPath(fieldPath)) return false;
  return !fieldPath.includes(".prompt.") && !fieldPath.includes("_prompt.");
}
