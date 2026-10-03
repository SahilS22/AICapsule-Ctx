/** Split raw message text into semantic blocks (paragraphs, code fences, tables, list groups). */

export interface Section {
  text: string;
  kind: 'paragraph' | 'code' | 'table' | 'list';
}

export function splitIntoSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  let buf: string[] = [];
  let bufKind: Section['kind'] = 'paragraph';
  let inCode = false;

  const flush = () => {
    const t = buf.join('\n').trim();
    if (t) sections.push({ text: t, kind: bufKind });
    buf = [];
    bufKind = 'paragraph';
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (!inCode) {
        flush();
        inCode = true;
        bufKind = 'code';
        buf.push(line);
      } else {
        buf.push(line);
        flush();
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      buf.push(line);
      continue;
    }
    const trimmed = line.trim();
    const isTable = /^\|.*\|/.test(trimmed);
    const isList = /^([-*•]|\d+[.)])\s+/.test(trimmed);
    if (!trimmed) {
      flush();
      continue;
    }
    const kind: Section['kind'] = isTable ? 'table' : isList ? 'list' : 'paragraph';
    if (buf.length && bufKind !== kind) flush();
    bufKind = kind;
    buf.push(line);
  }
  flush();
  return sections;
}

/** Split a paragraph-ish block into sentence-like units. */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}
