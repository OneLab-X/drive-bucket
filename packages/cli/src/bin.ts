import { run } from './cli.js';

run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
  isTTY: Boolean(process.stdout.isTTY),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`drivebucket: ${(err as Error)?.message ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
