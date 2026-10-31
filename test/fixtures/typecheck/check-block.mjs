// A typecheck command: reads a code block on stdin and fails when it contains "BAD".
let code = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (code += chunk));
process.stdin.on('end', () => {
  if (code.includes('BAD')) {
    process.stderr.write(`rejected (${process.env.SKILL_BE_LANG}): ${code.trim()}\n`);
    process.exit(1);
  }
});
