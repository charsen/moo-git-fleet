export type DiffLineKind = 'header' | 'hunk' | 'addition' | 'deletion' | 'context' | 'meta';

export type SyntaxTokenKind =
  | 'plain'
  | 'comment'
  | 'keyword'
  | 'string'
  | 'number'
  | 'function'
  | 'variable'
  | 'property'
  | 'tag'
  | 'constant'
  | 'whitespace';

export interface DiffSyntaxToken {
  text: string;
  kind: SyntaxTokenKind;
}

export interface PresentedDiffLine {
  id: string;
  kind: DiffLineKind;
  marker: string;
  oldLine: number | null;
  newLine: number | null;
  tokens: DiffSyntaxToken[];
}

export interface PresentedDiff {
  language: string;
  languageLabel: string;
  additions: number;
  deletions: number;
  lines: PresentedDiffLine[];
}

const languageByExtension: Record<string, { id: string; label: string }> = {
  bash: { id: 'shell', label: 'Shell' },
  c: { id: 'c', label: 'C' },
  cc: { id: 'c', label: 'C++' },
  cjs: { id: 'javascript', label: 'JavaScript' },
  cpp: { id: 'c', label: 'C++' },
  cs: { id: 'csharp', label: 'C#' },
  css: { id: 'css', label: 'CSS' },
  go: { id: 'go', label: 'Go' },
  h: { id: 'c', label: 'C' },
  hpp: { id: 'c', label: 'C++' },
  html: { id: 'markup', label: 'HTML' },
  java: { id: 'java', label: 'Java' },
  js: { id: 'javascript', label: 'JavaScript' },
  json: { id: 'json', label: 'JSON' },
  jsx: { id: 'javascript', label: 'JSX' },
  less: { id: 'css', label: 'Less' },
  md: { id: 'markdown', label: 'Markdown' },
  mjs: { id: 'javascript', label: 'JavaScript' },
  php: { id: 'php', label: 'PHP' },
  py: { id: 'python', label: 'Python' },
  rb: { id: 'ruby', label: 'Ruby' },
  rs: { id: 'rust', label: 'Rust' },
  scss: { id: 'css', label: 'SCSS' },
  sh: { id: 'shell', label: 'Shell' },
  sql: { id: 'sql', label: 'SQL' },
  swift: { id: 'swift', label: 'Swift' },
  ts: { id: 'typescript', label: 'TypeScript' },
  tsx: { id: 'typescript', label: 'TSX' },
  vue: { id: 'markup', label: 'Vue' },
  xml: { id: 'markup', label: 'XML' },
  yaml: { id: 'yaml', label: 'YAML' },
  yml: { id: 'yaml', label: 'YAML' },
  zsh: { id: 'shell', label: 'Shell' },
};

const keywords = new Set([
  'abstract', 'and', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'def', 'default', 'defer', 'do', 'echo', 'else', 'elseif', 'enum', 'export', 'extends', 'false',
  'final', 'finally', 'fn', 'for', 'foreach', 'from', 'func', 'function', 'if', 'implements', 'import',
  'in', 'instanceof', 'interface', 'let', 'match', 'namespace', 'new', 'nil', 'not', 'null', 'of', 'or',
  'package', 'private', 'protected', 'public', 'readonly', 'require', 'return', 'self', 'static', 'struct',
  'super', 'switch', 'this', 'throw', 'throws', 'trait', 'true', 'try', 'type', 'typeof', 'undefined',
  'use', 'var', 'void', 'while', 'with', 'yield',
]);

const constants = new Set(['true', 'false', 'null', 'nil', 'undefined', 'NaN', 'Infinity']);

function inferLanguage(path: string): { id: string; label: string } {
  const fileName = path.split('/').at(-1)?.toLowerCase() ?? '';
  if (['dockerfile', 'makefile'].includes(fileName)) return { id: 'shell', label: fileName === 'dockerfile' ? 'Dockerfile' : 'Makefile' };
  const extension = fileName.includes('.') ? fileName.split('.').at(-1) ?? '' : '';
  return languageByExtension[extension] ?? { id: 'plain', label: extension ? extension.toUpperCase() : 'Text' };
}

function pushToken(tokens: DiffSyntaxToken[], text: string, kind: SyntaxTokenKind): void {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.kind === kind) previous.text += text;
  else tokens.push({ text, kind });
}

function consumeQuoted(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === '\\') index += 2;
    else if (text[index] === quote) return index + 1;
    else index += 1;
  }
  return text.length;
}

function commentStart(text: string, index: number, language: string): boolean {
  if (text.startsWith('//', index) || text.startsWith('/*', index) || text.startsWith('<!--', index)) return true;
  if (!['python', 'ruby', 'shell', 'yaml'].includes(language)) return false;
  return text[index] === '#';
}

function markTrailingWhitespace(text: string, tokens: DiffSyntaxToken[]): DiffSyntaxToken[] {
  const trailingWhitespace = text.match(/[ \t]+$/)?.[0];
  if (!trailingWhitespace) return tokens;
  let remaining = trailingWhitespace.length;
  while (remaining > 0 && tokens.length > 0) {
    const token = tokens.at(-1)!;
    const removable = Math.min(remaining, token.text.length);
    token.text = token.text.slice(0, -removable);
    remaining -= removable;
    if (!token.text) tokens.pop();
  }
  tokens.push({ text: trailingWhitespace, kind: 'whitespace' });
  return tokens;
}

function highlightCodeLine(text: string, language: string): DiffSyntaxToken[] {
  if (!text) return [{ text: '', kind: 'plain' }];
  if (language === 'markdown' && /^\s*#{1,6}\s/.test(text)) return markTrailingWhitespace(text, [{ text, kind: 'keyword' }]);
  const tokens: DiffSyntaxToken[] = [];
  let index = 0;

  while (index < text.length) {
    if (commentStart(text, index, language)) {
      pushToken(tokens, text.slice(index), 'comment');
      break;
    }

    const character = text[index] ?? '';
    if (['"', "'", '`'].includes(character)) {
      const end = consumeQuoted(text, index, character);
      const token = text.slice(index, end);
      const after = text.slice(end).match(/^\s*:/);
      pushToken(tokens, token, language === 'json' && after ? 'property' : 'string');
      index = end;
      continue;
    }

    if (language === 'markup' && character === '<') {
      const match = text.slice(index).match(/^<\/?[A-Za-z][^>]*>/);
      if (match) {
        pushToken(tokens, match[0], 'tag');
        index += match[0].length;
        continue;
      }
    }

    if ((language === 'php' || language === 'shell') && character === '$') {
      const match = text.slice(index).match(/^\$\{?[A-Za-z_][\w]*\}?/);
      if (match) {
        pushToken(tokens, match[0], 'variable');
        index += match[0].length;
        continue;
      }
    }

    if (/\d/.test(character) && (index === 0 || !/[\w.]/.test(text[index - 1] ?? ''))) {
      const match = text.slice(index).match(/^(?:0x[\da-f]+|\d+(?:\.\d+)?)/i);
      if (match) {
        pushToken(tokens, match[0], 'number');
        index += match[0].length;
        continue;
      }
    }

    if (/[A-Za-z_]/.test(character)) {
      const match = text.slice(index).match(/^[A-Za-z_][\w-]*/);
      if (match) {
        const word = match[0];
        const remaining = text.slice(index + word.length);
        const kind: SyntaxTokenKind = constants.has(word)
          ? 'constant'
          : keywords.has(word)
            ? 'keyword'
            : /^\s*\(/.test(remaining)
              ? 'function'
              : language === 'css' && /^\s*:/.test(remaining)
                ? 'property'
                : 'plain';
        pushToken(tokens, word, kind);
        index += word.length;
        continue;
      }
    }

    pushToken(tokens, character, 'plain');
    index += 1;
  }

  return markTrailingWhitespace(text, tokens);
}

function parseHunkHeader(line: string): { oldLine: number; newLine: number } | null {
  const match = line.match(/^@@ -(?<oldLine>\d+)(?:,\d+)? \+(?<newLine>\d+)(?:,\d+)? @@/);
  if (!match?.groups) return null;
  return { oldLine: Number(match.groups.oldLine), newLine: Number(match.groups.newLine) };
}

export function presentGitDiff(diff: string, path: string): PresentedDiff {
  const language = inferLanguage(path);
  const lines: PresentedDiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let additions = 0;
  let deletions = 0;

  diff.split('\n').forEach((rawLine, index) => {
    const hunk = parseHunkHeader(rawLine);
    if (hunk) {
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      lines.push({ id: `${index}:hunk`, kind: 'hunk', marker: '', oldLine: null, newLine: null, tokens: [{ text: rawLine, kind: 'plain' }] });
      return;
    }

    if (oldLine !== null && newLine !== null && rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      const currentNewLine = newLine;
      newLine = currentNewLine + 1;
      additions += 1;
      lines.push({ id: `${index}:addition`, kind: 'addition', marker: '+', oldLine: null, newLine: currentNewLine, tokens: highlightCodeLine(rawLine.slice(1), language.id) });
      return;
    }
    if (oldLine !== null && newLine !== null && rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      const currentOldLine = oldLine;
      oldLine = currentOldLine + 1;
      deletions += 1;
      lines.push({ id: `${index}:deletion`, kind: 'deletion', marker: '−', oldLine: currentOldLine, newLine: null, tokens: highlightCodeLine(rawLine.slice(1), language.id) });
      return;
    }
    if (oldLine !== null && newLine !== null && rawLine.startsWith(' ')) {
      const currentOldLine = oldLine;
      const currentNewLine = newLine;
      oldLine = currentOldLine + 1;
      newLine = currentNewLine + 1;
      lines.push({ id: `${index}:context`, kind: 'context', marker: '', oldLine: currentOldLine, newLine: currentNewLine, tokens: highlightCodeLine(rawLine.slice(1), language.id) });
      return;
    }
    if (rawLine.startsWith('\\ No newline') || rawLine === '… diff 已截断 …') {
      lines.push({ id: `${index}:meta`, kind: 'meta', marker: '', oldLine: null, newLine: null, tokens: [{ text: rawLine, kind: 'plain' }] });
      return;
    }

    const kind: DiffLineKind = /^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (?:from|to))/.test(rawLine)
      ? 'header'
      : 'meta';
    lines.push({ id: `${index}:${kind}`, kind, marker: '', oldLine: null, newLine: null, tokens: [{ text: rawLine, kind: 'plain' }] });
  });

  return { language: language.id, languageLabel: language.label, additions, deletions, lines };
}
