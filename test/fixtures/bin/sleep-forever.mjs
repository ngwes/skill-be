// Prints its pid on a line of its own, then never exits.
process.stdout.write(`${process.pid}\n`);
setInterval(() => {}, 60_000);
