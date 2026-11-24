import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const nest = spawn(
  process.execPath,
  ['run', 'nest', 'start', ...process.argv.slice(2)],
  { stdio: ['inherit', 'pipe', 'inherit'] },
);
const output = createInterface({ input: nest.stdout });
let browserOpened = false;
let startupFailed = false;

output.on('line', (line) => {
  process.stdout.write(`${line}\n`);
  const prefix = 'Swagger UI: ';
  if (!browserOpened && line.startsWith(prefix)) {
    browserOpened = true;
    openBrowser(line.slice(prefix.length));
  }
});

nest.on('error', (error) => {
  startupFailed = true;
  console.error('Failed to start the NestJS application:', error);
  process.exitCode = 1;
});

nest.on('close', (code, signal) => {
  output.close();
  if (startupFailed) return;
  process.exitCode = code ?? (signal ? 1 : 0);
});

function openBrowser(url: string): void {
  const command =
    process.platform === 'win32'
      ? 'cmd.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const args =
    process.platform === 'win32'
      ? ['/c', 'start', '', url]
      : [url];
  const browser = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  browser.on('error', (error) => {
    console.error('Failed to open the Swagger UI in a browser:', error);
  });
  browser.unref();
}
