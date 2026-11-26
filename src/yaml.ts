/**
 * Minimal YAML-subset parser for GitHub Actions workflow files.
 *
 * It is deliberately NOT a full YAML parser: it handles the shapes that
 * appear in real workflow files (nested maps, sequences, scalars, quoted
 * strings, block scalars, flow lists/maps, inline comments, anchors) and
 * records the 1-based line of every key and value so findings can cite
 * file:line evidence. Anything outside the subset is a parse error, and
 * the caller reports the file as UNKNOWN instead of guessing.
 *
 * Tabs for indentation are rejected (YAML forbids them). Duplicate keys
 * are rejected. Multi-document files (---) are rejected.
 */

export interface YamlNode {
  kind: "map" | "seq" | "scalar";
  line: number;
  map?: Map<string, YamlNode>;
  /** Line of each map key, so findings can cite the key itself. */
  keyLines?: Map<string, number>;
  seq?: YamlNode[];
  scalar?: string;
}

export class YamlParseError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.line = line;
  }
}

interface RawLine {
  indent: number;
  content: string;
  line: number;
}

function stripComment(text: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) {
      if (text[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      if (text[i - 1] !== "\\") inDouble = !inDouble;
    } else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || text[i - 1] === " " || text[i - 1] === "\t") {
        return text.slice(0, i).trimEnd();
      }
    }
  }
  return text.trimEnd();
}

function tokenize(text: string): RawLine[] {
  const out: RawLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, "");
    if (raw.trim() === "") continue;
    if (raw.includes("\t")) {
      const firstTab = raw.indexOf("\t");
      const before = raw.slice(0, firstTab);
      if (before.trim() === "") {
        throw new YamlParseError("tab used for indentation", i + 1);
      }
    }
    const indent = raw.length - raw.trimStart().length;
    const content = stripComment(raw.slice(indent));
    if (content === "") continue; // comment-only line
    if (content === "---" || content === "...") {
      throw new YamlParseError("multi-document YAML is not supported", i + 1);
    }
    out.push({ indent, content, line: i + 1 });
  }
  return out;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    value[0] === '"' &&
    value[value.length - 1] === '"'
  ) {
    const inner = value.slice(1, -1);
    return inner
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (
    value.length >= 2 &&
    value[0] === "'" &&
    value[value.length - 1] === "'"
  ) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Split a flow list/map body on top-level commas (quote/brace aware). */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && body[i - 1] !== "\\")
      inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "[" || ch === "{") depth++;
      else if (ch === "]" || ch === "}") depth--;
      else if (ch === "," && depth === 0) {
        parts.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts;
}

function parseFlow(value: string, line: number): YamlNode {
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) {
      throw new YamlParseError("unterminated flow list", line);
    }
    const inner = value.slice(1, -1).trim();
    const seq: YamlNode[] = [];
    if (inner !== "") {
      for (const part of splitFlow(inner)) {
        seq.push(parseInlineValue(part, line));
      }
    }
    return { kind: "seq", line, seq };
  }
  if (value.startsWith("{")) {
    if (!value.endsWith("}")) {
      throw new YamlParseError("unterminated flow map", line);
    }
    const inner = value.slice(1, -1).trim();
    const map = new Map<string, YamlNode>();
    if (inner !== "") {
      for (const part of splitFlow(inner)) {
        const m = part.match(/^([^:]+):\s*(.*)$/);
        if (!m) throw new YamlParseError(`bad flow map entry: ${part}`, line);
        const key = unquote(m[1].trim());
        if (map.has(key))
          throw new YamlParseError(`duplicate key: ${key}`, line);
        map.set(key, parseInlineValue(m[2].trim(), line));
      }
    }
    return { kind: "map", line, map };
  }
  return { kind: "scalar", line, scalar: unquote(value) };
}

function parseInlineValue(value: string, line: number): YamlNode {
  let v = value.trim();
  // Anchor: "&name rest" - keep the rest, drop the anchor.
  if (v.startsWith("&")) {
    const sp = v.indexOf(" ");
    if (sp === -1) return { kind: "scalar", line, scalar: "" };
    v = v.slice(sp + 1).trim();
  }
  // Alias: "*name" - opaque, kept as a scalar so the caller can see it.
  if (v.startsWith("*")) return { kind: "scalar", line, scalar: v };
  if (v.startsWith("[") || v.startsWith("{")) return parseFlow(v, line);
  return { kind: "scalar", line, scalar: unquote(v) };
}

/** "key:" or "key: value" - keys may be quoted. Returns null when not a map entry. */
function matchKey(content: string): { key: string; rest: string } | null {
  const m = content.match(
    /^((?:"[^"]*")|(?:'[^']*')|[^:#][^:]*?):(?:\s+(.*))?$/,
  );
  if (!m) return null;
  const key = unquote(m[1].trim());
  if (key === "") return null;
  return { key, rest: (m[2] ?? "").trim() };
}

export class YamlParser {
  private lines: RawLine[];
  private pos = 0;

  constructor(text: string) {
    this.lines = tokenize(text);
  }

  parse(): YamlNode {
    if (this.lines.length === 0) {
      return { kind: "map", line: 1, map: new Map() };
    }
    const node = this.parseBlock(this.lines[0].indent);
    if (this.pos < this.lines.length) {
      throw new YamlParseError(
        `unexpected content at indent ${this.lines[this.pos].indent}`,
        this.lines[this.pos].line,
      );
    }
    return node;
  }

  private peek(): RawLine | undefined {
    return this.lines[this.pos];
  }

  private parseBlock(indent: number): YamlNode {
    const first = this.peek();
    if (!first) throw new YamlParseError("unexpected end of file", 1);
    if (first.content === "-" || first.content.startsWith("- ")) {
      return this.parseSeq(indent);
    }
    if (matchKey(first.content)) {
      return this.parseMap(indent);
    }
    // Plain multi-line scalar: join continuation lines at this indent or deeper.
    const startLine = first.line;
    const parts: string[] = [];
    while (this.peek() && this.peek()!.indent >= indent) {
      parts.push(this.lines[this.pos].content);
      this.pos++;
    }
    return { kind: "scalar", line: startLine, scalar: parts.join(" ") };
  }

  private parseMap(indent: number): YamlNode {
    const map = new Map<string, YamlNode>();
    const keyLines = new Map<string, number>();
    const startLine = this.peek()!.line;
    while (true) {
      const cur = this.peek();
      if (!cur || cur.indent !== indent) break;
      if (cur.content === "-" || cur.content.startsWith("- ")) break;
      const kv = matchKey(cur.content);
      if (!kv) {
        throw new YamlParseError(
          `expected a mapping key, got: ${cur.content}`,
          cur.line,
        );
      }
      if (map.has(kv.key)) {
        throw new YamlParseError(`duplicate key: ${kv.key}`, cur.line);
      }
      const keyLine = cur.line;
      this.pos++;
      keyLines.set(kv.key, keyLine);
      map.set(kv.key, this.parseValueAfterKey(kv.rest, keyLine, indent));
    }
    return { kind: "map", line: startLine, map, keyLines };
  }

  private parseSeq(indent: number): YamlNode {
    const seq: YamlNode[] = [];
    const startLine = this.peek()!.line;
    while (true) {
      const cur = this.peek();
      if (!cur || cur.indent !== indent) break;
      if (!(cur.content === "-" || cur.content.startsWith("- "))) break;
      const dashLine = cur.line;
      const after = cur.content === "-" ? "" : cur.content.slice(2);
      this.pos++;
      if (after === "") {
        // "-": nested block on the following lines. A nested sequence
        // may sit at the same indent as the dash (see parseValueAfterKey).
        const next = this.peek();
        if (next) {
          const isSeq = next.content === "-" || next.content.startsWith("- ");
          if (isSeq && next.indent >= indent) {
            seq.push(this.parseSeq(next.indent));
            continue;
          }
          if (next.indent > indent) {
            seq.push(this.parseBlock(next.indent));
            continue;
          }
        }
        seq.push({ kind: "scalar", line: dashLine, scalar: "" });
        continue;
      }
      const kv = matchKey(after);
      if (kv) {
        // "- key: value": a map whose first entry is on the dash line
        // and whose remaining entries sit at indent + 2.
        const map = new Map<string, YamlNode>();
        const keyLines = new Map<string, number>();
        keyLines.set(kv.key, dashLine);
        map.set(kv.key, this.parseValueAfterKey(kv.rest, dashLine, indent + 2));
        const innerIndent = indent + 2;
        while (true) {
          const n = this.peek();
          if (!n || n.indent !== innerIndent) break;
          if (n.content === "-" || n.content.startsWith("- ")) break;
          const kv2 = matchKey(n.content);
          if (!kv2) {
            throw new YamlParseError(
              `expected a mapping key, got: ${n.content}`,
              n.line,
            );
          }
          if (map.has(kv2.key)) {
            throw new YamlParseError(`duplicate key: ${kv2.key}`, n.line);
          }
          const kl = n.line;
          this.pos++;
          keyLines.set(kv2.key, kl);
          map.set(kv2.key, this.parseValueAfterKey(kv2.rest, kl, innerIndent));
        }
        seq.push({ kind: "map", line: dashLine, map, keyLines });
      } else {
        seq.push(parseInlineValue(after, dashLine));
      }
    }
    return { kind: "seq", line: startLine, seq };
  }

  /**
   * Value that follows "key:" on the same line. When the rest is empty,
   * the value is a nested block on deeper-indented lines, or an empty
   * scalar when there is none.
   */
  private parseValueAfterKey(
    rest: string,
    keyLine: number,
    keyIndent: number,
  ): YamlNode {
    if (rest === "") {
      const next = this.peek();
      if (next) {
        // YAML allows a block sequence at the SAME indent as its parent
        // key ("branches:\n- main"). A mapping or scalar still needs a
        // deeper indent.
        const isSeq = next.content === "-" || next.content.startsWith("- ");
        if (isSeq && next.indent >= keyIndent) {
          return this.parseSeq(next.indent);
        }
        if (next.indent > keyIndent) {
          return this.parseBlock(next.indent);
        }
      }
      return { kind: "scalar", line: keyLine, scalar: "" };
    }
    // Block scalar: "|" (literal) or ">" (folded), optional +/- chomping.
    if (/^[|>][+-]?$/.test(rest)) {
      const folded = rest.startsWith(">");
      const next = this.peek();
      const parts: string[] = [];
      if (next && next.indent > keyIndent) {
        const blockIndent = next.indent;
        while (this.peek() && this.peek()!.indent >= blockIndent) {
          parts.push(this.lines[this.pos].content);
          this.pos++;
        }
      }
      const joined = folded ? parts.join(" ") : parts.join("\n");
      return { kind: "scalar", line: keyLine, scalar: joined };
    }
    // Multi-line flow value: keep consuming lines until brackets balance.
    if (rest.startsWith("[") || rest.startsWith("{")) {
      let joined = rest;
      let depth = 0;
      let inSingle = false;
      let inDouble = false;
      const scan = (s: string) => {
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (ch === "'" && !inDouble) inSingle = !inSingle;
          else if (ch === '"' && !inSingle && s[i - 1] !== "\\")
            inDouble = !inDouble;
          else if (!inSingle && !inDouble) {
            if (ch === "[" || ch === "{") depth++;
            else if (ch === "]" || ch === "}") depth--;
          }
        }
      };
      scan(joined);
      while (depth > 0) {
        const n = this.peek();
        if (!n) break;
        joined += " " + n.content;
        scan(n.content);
        this.pos++;
      }
      return parseFlow(joined, keyLine);
    }
    return parseInlineValue(rest, keyLine);
  }
}

export function parseYaml(text: string): YamlNode {
  return new YamlParser(text).parse();
}

/** Map helpers: look up a key, tolerating a missing or non-map node. */
export function getMap(
  node: YamlNode | undefined,
  key: string,
): YamlNode | undefined {
  if (!node || node.kind !== "map" || !node.map) return undefined;
  return node.map.get(key);
}

export function asString(node: YamlNode | undefined): string | undefined {
  if (!node || node.kind !== "scalar") return undefined;
  return node.scalar ?? "";
}

/** A scalar becomes a one-item list; a sequence of scalars becomes a list. */
export function asStringList(node: YamlNode | undefined): string[] {
  if (!node) return [];
  if (node.kind === "scalar") {
    const s = node.scalar ?? "";
    return s === "" ? [] : [s];
  }
  if (node.kind === "seq" && node.seq) {
    const out: string[] = [];
    for (const item of node.seq) {
      if (
        item.kind === "scalar" &&
        item.scalar !== undefined &&
        item.scalar !== ""
      ) {
        out.push(item.scalar);
      }
    }
    return out;
  }
  return [];
}

/** Iterate map entries in file order. */
export function mapEntries(
  node: YamlNode | undefined,
): Array<{ key: string; value: YamlNode }> {
  if (!node || node.kind !== "map" || !node.map) return [];
  return [...node.map.entries()].map(([key, value]) => ({ key, value }));
}

/** Line of a map key itself (the line the key appears on). */
export function getKeyLine(node: YamlNode | undefined, key: string): number {
  if (!node || node.kind !== "map" || !node.keyLines) return node?.line ?? 1;
  return node.keyLines.get(key) ?? node.line;
}
