// Ignores stdin, writes to stderr and exits with code 3.
process.stderr.write('exit-3 failed on purpose\n');
process.exit(3);
