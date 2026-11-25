// Dev: start the Vite server, then launch Electron pointed at it.
import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`vite ready at ${url}`);
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, ANOBE_DEV_URL: url } });
child.on('close', async code => { await server.close(); process.exit(code ?? 0); });
