// Quick start (Node): make a Hapbeat buzz with no kit and no Studio deploy.
// The SDK streams a WAV from this PC straight to every Hapbeat on the LAN, so
// nothing has to be installed on the device first. hit_80hz.wav (next to this
// file) is a 0.25 s, 80 Hz pulse; any PCM16 WAV of your own works the same way.
//
//   npm run build
//   node examples/quickstart-clip-node.mjs
//
// In your own project: npm install @hapbeat/sdk, and import from "@hapbeat/sdk".
import { readFile } from "node:fs/promises";
import { connect, parseWav } from "../dist/node.js";

const hit = parseWav(await readFile(new URL("./hit_80hz.wav", import.meta.url)));

const hb = await connect({ appName: "QuickStart" });
hb.streamPcm(hit.data, { sampleRate: hit.sampleRate, channels: hit.channels, gain: 0.6 });

await new Promise((r) => setTimeout(r, 1000)); // keep the socket open while the clip streams
await hb.close();
