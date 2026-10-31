// Starts sleep-forever.mjs as a grandchild sharing this process's stdio, prints its own pid,
// then never exits. Stdout ends up with two pid lines: this process and the grandchild.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const sleeper = fileURLToPath(new URL('./sleep-forever.mjs', import.meta.url));
spawn(process.execPath, [sleeper], { stdio: 'inherit' });
process.stdout.write(`${process.pid}\n`);
setInterval(() => {}, 60_000);
