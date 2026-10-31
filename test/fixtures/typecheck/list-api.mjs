// A coverage command: prints its arguments as API names, one per line (Windows line endings,
// blank lines and a repeated name included). `--fail` exits non-zero with a message instead.
const names = process.argv.slice(2);
if (names.includes('--fail')) {
  process.stderr.write('cannot list the API\n');
  process.exit(3);
}
process.stdout.write(names.join('\r\n') + '\r\n\r\n');
