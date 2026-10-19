import { startMvp } from './mvp.js';

await startMvp((error) => {
  console.error(`AACpipe Publisher: fatal error: ${error.message}`);
  process.exitCode = 1;
});
