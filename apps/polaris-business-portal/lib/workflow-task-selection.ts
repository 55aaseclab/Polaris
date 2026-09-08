export type WorkflowTaskTemplateOption = {
  id: string;
  title: string;
};

export type WorkflowTaskExistingOption = {
  id: string;
  title: string;
};

export type WorkflowTaskSelectionGroup = {
  id: "templates" | "existing";
  items: Array<{
    label: string;
    value: string;
  }>;
  label: "模板" | "已有任务";
};

export function templateSelectionValue(templateId: string): string {
  return `template:${templateId}`;
}

export function existingTaskSelectionValue(workflowId: string): string {
  return `workflow:${workflowId}`;
}

export function selectedTemplateId(value: string): string | null {
  return value.startsWith("template:") ? value.slice("template:".length) || null : null;
}

export function selectedExistingWorkflowId(value: string): string | null {
  return value.startsWith("workflow:") ? value.slice("workflow:".length) || null : null;
}

export function buildWorkflowTaskSelectionGroups(
  templates: WorkflowTaskTemplateOption[],
  workflows: WorkflowTaskExistingOption[],
): WorkflowTaskSelectionGroup[] {
  const groups: WorkflowTaskSelectionGroup[] = [];

  if (templates.length > 0) {
    groups.push({
      id: "templates",
      items: templates.map((template) => ({
        label: template.title,
        value: templateSelectionValue(template.id),
      })),
      label: "模板",
    });
  }

  if (workflows.length > 0) {
    groups.push({
      id: "existing",
      items: workflows.map((workflow) => ({
        label: workflow.title,
        value: existingTaskSelectionValue(workflow.id),
      })),
      label: "已有任务",
    });
  }

  return groups;
}
