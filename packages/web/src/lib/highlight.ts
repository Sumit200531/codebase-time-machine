/**
 * Minimal lexical highlighter for diff lines: comments, strings, numbers and
 * keywords. Produces tokens rendered as React text, never as HTML.
 */
export type TokenKind = "plain" | "keyword" | "string" | "comment" | "number";
export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

const KEYWORDS = new Set(
  "import export from as const let var function return if else for while await async new class extends type interface default try catch throw null undefined true false def self None True False select create table not primary key".split(" "),
);
const TOKEN = /(\/\/.*$|#.*$|--.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;

export function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ kind: "plain", text: line.slice(last, index) });
    const [text, comment, string, number, word] = match;
    const kind: TokenKind = comment ? "comment" : string ? "string" : number ? "number" : word && KEYWORDS.has(word.toLowerCase()) ? "keyword" : "plain";
    tokens.push({ kind, text });
    last = index + text.length;
  }
  if (last < line.length) tokens.push({ kind: "plain", text: line.slice(last) });
  return tokens;
}
