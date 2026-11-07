// Development mode: start a simulated XR18 and the bridge pointed at it.
//   npm run dev            # normal simulator
//   npm run dev -- --chaos # simulator also routes click/guide to the house every 20 s
import { XR18Simulator } from './simulator/xr18-sim.js';
import { Bridge } from './bridge.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const simPort = Number(process.env.SIM_PORT || 10024);
const sim = await new XR18Simulator({ port: simPort, chaos: process.argv.includes('--chaos'), log: true }).start();
const bridge = await new Bridge({
  mixerHost: '127.0.0.1',
  mixerPort: simPort,
  httpPort: Number(process.env.PORT || 8080),
  walkinFadeSeconds: 8,
  dataDir: path.join(ROOT, 'data', 'dev'),
  keepAwake: false,
}).start();

const shutdown = () => {
  bridge.stop();
  sim.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
