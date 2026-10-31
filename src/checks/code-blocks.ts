export type CodeBlock = {
  /** The first word of the info string, lowercased; empty when the block has none. */
  lang: string;
  /** The block's content, without the fences and without the fence's indentation. */
  code: string;
  /** The 1-based line of the opening fence. */
  line: number;
  /** The info string holds the word `skip`, as in ```` ```ts skip ````. */
  skip: boolean;
};

const OPENING_FENCE = /^( *)(`{3,}|~{3,})(.*)$/;

/**
 * The fenced code blocks of a markdown text. A block closes at a fence of the same character that
 * is at least as long as the opening one, or at the end of the text.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const lines = markdown.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();

  const blocks: CodeBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = OPENING_FENCE.exec(lines[index]!);
    const info = opening?.[3] ?? '';
    // A backtick fence's info string cannot contain a backtick (that is inline code).
    if (opening === null || (opening[2]!.startsWith('`') && info.includes('`'))) {
      index += 1;
      continue;
    }

    const indent = opening[1]!.length;
    const fence = opening[2]!;
    const closing = new RegExp(`^ *${fence[0] === '`' ? '`' : '~'}{${fence.length},} *$`);
    const words = info.trim().split(/\s+/).filter((word) => word !== '');
    const code: string[] = [];
    let end = index + 1;
    while (end < lines.length && !closing.test(lines[end]!)) {
      code.push(removeIndent(lines[end]!, indent));
      end += 1;
    }

    blocks.push({
      lang: (words[0] ?? '').toLowerCase(),
      code: code.join('\n'),
      line: index + 1,
      skip: words.includes('skip'),
    });
    index = end + 1;
  }
  return blocks;
}

/** Removes up to `indent` leading spaces, as CommonMark does for a fenced block's content. */
function removeIndent(line: string, indent: number): string {
  let start = 0;
  while (start < indent && line[start] === ' ') start += 1;
  return line.slice(start);
}
