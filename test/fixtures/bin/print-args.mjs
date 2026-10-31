// Prints its arguments, stdin, working directory and SKILLBE_TEST_VAR as JSON.
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', () => {
  const report = {
    argv: process.argv.slice(2),
    stdin,
    cwd: process.cwd(),
    envVar: process.env.SKILLBE_TEST_VAR ?? null,
  };
  process.stdout.write(JSON.stringify(report));
});
