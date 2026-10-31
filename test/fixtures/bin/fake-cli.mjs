// A fake model and grader for the command adapter. Given a grader prompt (it asks for "exactly
// <n> lines"), it answers YES to every criterion, or NO with the argument `no`. Given any other
// prompt, it answers with a line of code.
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (prompt += chunk));
process.stdin.on('end', () => {
  const grading = /followed by exactly (\d+) lines?/.exec(prompt);
  if (grading === null) {
    process.stdout.write('const twice = (n: number): number => double(n);\n');
    return;
  }
  const verdict = process.argv[2] === 'no' ? 'NO' : 'YES';
  const lines = Array.from({ length: Number(grading[1]) }, (_, i) => `${i + 1}: ${verdict}`);
  process.stdout.write(`It calls double.\nVERDICTS:\n${lines.join('\n')}\n`);
});
