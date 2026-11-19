// Usage: node test/e2e/shot.mjs out.png — screenshot of the Positron workbench via CDP.
import { connect } from './cdp.mjs';
const cdp = await connect();
await cdp.screenshot(process.argv[2] ?? '/tmp/pa.png');
cdp.close();
