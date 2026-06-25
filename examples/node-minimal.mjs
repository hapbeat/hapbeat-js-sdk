// Minimal Node example — direct UDP broadcast, no helper needed.
//   node examples/node-minimal.mjs
// (build first: npm run build)
import { connect } from "../dist/node.js";

const EVENT_ID = "sample-kit.sine_100hz"; // must exist in the kit deployed to your device

const hb = await connect({ appName: "NodeExample" });

for (const d of await hb.discover(1500)) {
  console.log(`found ${d.ip}  ${d.address ?? "?"}  fw=${d.firmwareVersion ?? "?"}`);
}

hb.play(EVENT_ID);
await new Promise((r) => setTimeout(r, 500));
hb.play(EVENT_ID, { gain: 0.3 });
await new Promise((r) => setTimeout(r, 500));

hb.stopAll();
await hb.close();
console.log("done");
