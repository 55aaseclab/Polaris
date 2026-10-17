import { ClhError } from "./errors.js";

/**
 * Minimal Jinja2 subset renderer for CVE-Genie style prompt templates.
 * Supported: {{ VAR }} interpolation plus nested {% if VAR %} / {% else %} /
 * {% endif %} blocks. Undefined variables fail closed (CLH_PRESET_INVALID) —
 * silent empties would mask broken task context.
 */
export function renderJ2(template: string, context: Record<string, string> = {}): string {
  const segments = parseSegments(template);
  return renderSegments(segments, context);
}

interface Segment {
  kind: "text" | "branch";
  text?: string;
  variable?: string;
  body?: Segment[];
  else?: Segment[];
}

interface Tag {
  keyword: "if" | "else" | "endif";
  variable?: string;
  start: number;
  end: number;
}

function renderSegments(segments: Segment[], context: Record<string, string>): string {
  return segments
    .map((segment) => {
      if (segment.kind === "text") return interpolate(segment.text as string, context);
      const value = context[segment.variable as string];
      if (value === undefined || value === "") {
        return segment.else ? renderSegments(segment.else, context) : "";
      }
      return renderSegments(segment.body as Segment[], context);
    })
    .join("");
}

function parseSegments(template: string): Segment[] {
  const tags = scanTags(template);
  const state = { cursor: 0, i: 0 };
  const { segments, terminated } = parseSeq(template, tags, state, null);
  if (terminated !== null) {
    throw new ClhError("CLH_PRESET_INVALID", `Unbalanced j2 template: unexpected {% ${terminated} %}`, {});
  }
  if (state.cursor < template.length) {
    segments.push({ kind: "text", text: template.slice(state.cursor) });
  }
  return segments;
}

/**
 * Recursive-descent parse. Parses until a depth-0 {% else %} or {% endif %}
 * (returned as the terminator) or the end of the template. Nested if blocks
 * recurse, so depth-0 terminators are matched exactly.
 */
function parseSeq(
  template: string,
  tags: Tag[],
  state: { cursor: number; i: number },
  openedBy: "if" | "else" | null,
): { segments: Segment[]; terminated: "else" | "endif" | null } {
  const segments: Segment[] = [];
  while (state.i < tags.length) {
    const tag = tags[state.i];
    if (tag.start > state.cursor) {
      segments.push({ kind: "text", text: template.slice(state.cursor, tag.start) });
    }
    state.cursor = tag.end;
    if (tag.keyword === "if") {
      const variable = requireIfVariable(tag);
      state.i += 1;
      const body = parseSeq(template, tags, state, "if");
      if (body.terminated === null) {
        throw new ClhError("CLH_PRESET_INVALID", `Unclosed j2 {% if ${variable} %} block`, { variable });
      }
      let elseBody: Segment[] | undefined;
      if (body.terminated === "else") {
        const elseParse = parseSeq(template, tags, state, "else");
        if (elseParse.terminated !== "endif") {
          throw new ClhError("CLH_PRESET_INVALID", `Unclosed j2 {% if ${variable} %} block`, { variable });
        }
        elseBody = elseParse.segments;
      }
      segments.push({ kind: "branch", variable, body: body.segments, else: elseBody });
    } else if (tag.keyword === "else") {
      if (openedBy !== "if") {
        throw new ClhError("CLH_PRESET_INVALID", "j2 {% else %} outside an if block", {});
      }
      state.i += 1;
      return { segments, terminated: "else" };
    } else {
      if (openedBy === null) {
        throw new ClhError("CLH_PRESET_INVALID", "j2 {% endif %} outside an if block", {});
      }
      state.i += 1;
      return { segments, terminated: "endif" };
    }
  }
  if (openedBy !== null) {
    throw new ClhError("CLH_PRESET_INVALID", "Unclosed j2 if block", {});
  }
  return { segments, terminated: null };
}

function scanTags(template: string): Tag[] {
  const tags: Tag[] = [];
  const pattern = /\{%\s*(if|else|endif)\s*(?:([A-Za-z_][A-Za-z0-9_]*)\s*)?%\}/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(template)) !== null) {
    tags.push({
      keyword: match[1] as Tag["keyword"],
      variable: match[1] === "if" ? match[2] : undefined,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tags;
}

function requireIfVariable(tag: Tag): string {
  if (!tag.variable) {
    throw new ClhError("CLH_PRESET_INVALID", "j2 {% if %} requires a variable name", {});
  }
  return tag.variable;
}

function interpolate(text: string, context: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu, (_whole, name: string) => {
    const value = context[name];
    if (value === undefined || value === null) {
      throw new ClhError("CLH_PRESET_INVALID", `j2 template variable is undefined in task context: ${name}`, {
        variable: name,
      });
    }
    return value;
  });
}
