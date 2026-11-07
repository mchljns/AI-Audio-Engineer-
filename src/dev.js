// Practice / development mode: a simulated XR18 and the bridge pointed at it.
// Runs on port 8081 so it never clashes with the real Mix Assistant on 8080.
//   npm run dev            # normal simulator
//   npm run dev -- --chaos # simulator also routes click/guide to the house every 20 s
import { XR18Simulator } from './simulator/xr18-sim.js';
import { Bridge } from './bridge.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const simPort = Number(process.env.SIM_PORT || 10124); // not 10024, so a real mixer search never finds it
const sim = await new XR18Simulator({ port: simPort, chaos: process.argv.includes('--chaos'), log: true }).start();
const bridge = await new Bridge({
  mixerHost: '127.0.0.1',
  mixerPort: simPort,
  httpPort: Number(process.env.PORT || 8081),
  walkinFadeSeconds: 8,
  dataDir: path.join(ROOT, 'data', 'dev'),
  keepAwake: false,
  pin: false, // practice mode only talks to a pretend mixer
  trustLocalhost: true,
  protectedBuses: null,
}).start();

const shutdown = () => {
  bridge.stop();
  sim.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
