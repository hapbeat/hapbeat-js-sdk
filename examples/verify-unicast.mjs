// Release check for unicast sending (Node transport) — run it and listen.
//   npm run build && node examples/verify-unicast.mjs
//
// Power on ONE Hapbeat on the same Wi-Fi as this PC. No kit needed: the tone is
// synthesized here.
//
// A *continuous* 100 Hz sine is the harshest case for the transport — every
// late or lost packet is audible. The script streams one while alternating
// broadcast and unicast. Broadcast is expected to stutter every 100-300 ms (the
// AP holds group-addressed frames until its next DTIM beacon whenever any
// client on it is power-saving); unicast should be smooth.
//
// The Node build has no ICMP fix to verify (unlike the Python SDK): its socket
// error handler only logs and never closes the socket, which is what keeps a
// dead unicast destination from killing discovery. The last phase power-cycles
// the device to confirm that still holds.
import { createInterface } from "node:readline/promises";
import { connect } from "../dist/node.js";

const TONE_HZ = 100;
const SAMPLE_RATE = 16000;
const AMPLITUDE = 0.8;
const GAIN = 0.6;
const PHASE_SECONDS = 15;
const ICMP_SECONDS = 90;

const rl = createInterface({ input: process.stdin, output: process.stdout });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Continuous 100 Hz sine as mono PCM16 (little-endian), phase-continuous. */
function sinePcm(seconds) {
  const n = Math.floor(SAMPLE_RATE * seconds);
  const pcm = new Uint8Array(n * 2);
  const view = new DataView(pcm.buffer);
  const step = (2 * Math.PI * TONE_HZ) / SAMPLE_RATE;
  for (let i = 0; i < n; i++) {
    view.setInt16(i * 2, Math.round(AMPLITUDE * 32767 * Math.sin(step * i)), true);
  }
  return pcm;
}

function rule(title) {
  console.log(`\n${"=".repeat(66)}\n  ${title}\n${"=".repeat(66)}`);
}

async function countdown(seconds, label) {
  for (let left = seconds; left > 0; left--) {
    process.stdout.write(`\r  ${label}  ${String(left).padStart(2)}s left `);
    await sleep(1000);
  }
  process.stdout.write("\r" + " ".repeat(46) + "\r");
}

async function abPhase(pcm, unicast) {
  // `unicast` is fixed at construction, so each phase gets its own connection.
  const hb = await connect({ appName: "VerifyUnicast", unicast });
  await hb.discover(1500); // let the destination table fill before streaming
  const label = unicast ? "[A] UNICAST  " : "[B] BROADCAST";
  console.log(`  ${label}`);
  hb.streamPcm(pcm, { sampleRate: SAMPLE_RATE, channels: 1, gain: GAIN });
  await countdown(PHASE_SECONDS, label);
  hb.stopAll();
  await hb.close();
  await sleep(300);
}

rule("0. Discovery");
const probe = await connect({ appName: "VerifyUnicast" });
const found = await probe.discover(2000);
if (found.length === 0) {
  console.log("  FAIL: no device found.");
  console.log("    - is the Hapbeat on the same Wi-Fi as this PC?");
  console.log("    - on a multi-NIC PC, does the Hapbeat's NIC have the route?");
  await probe.close();
  rl.close();
  process.exit(1);
}
for (const d of found) {
  console.log(`  found ${d.ip}  address=${JSON.stringify(d.address ?? "")}  fw=${d.firmwareVersion ?? "?"}`);
}
await probe.close();

rule("1. Vibration quality — continuous 100 Hz sine, A/B");
console.log("  Same tone, only the send path changes.");
console.log("  [B] is expected to stutter; [A] should be smooth.\n");
const pcm = sinePcm(PHASE_SECONDS);
for (let round = 0; round < 2; round++) {
  await abPhase(pcm, false);
  await abPhase(pcm, true);
}
const answer = await rl.question("\n  Was [A] UNICAST smoother than [B]? [y/n]: ");
const qualityOk = answer.trim().toLowerCase().startsWith("y");

rule("2. Power cycle — does the socket survive a dead destination?");
console.log(`  Streaming by unicast for ${ICMP_SECONDS}s. While it runs:\n`);
console.log("    1. after ~10s, switch the Hapbeat OFF");
console.log("    2. leave it off 10-20s (we keep unicasting at a dead host)");
console.log("    3. switch it back ON\n");
await rl.question("  Press Enter to start: ");

const hb = await connect({ appName: "VerifyUnicast", unicast: true });
await hb.discover(1500);
hb.streamPcm(sinePcm(ICMP_SECONDS), { sampleRate: SAMPLE_RATE, channels: 1, gain: GAIN });
let sawZero = false;
let recovered = false;
for (let elapsed = 0; elapsed < ICMP_SECONDS; elapsed++) {
  // discover() reports only devices that answered within the window, so it
  // doubles as the liveness probe here.
  const alive = (await hb.discover(700)).length;
  if (alive === 0) sawZero = true;
  else if (sawZero) recovered = true;
  const note = alive === 0 ? "device is OFF" : recovered ? "RECOVERED" : "";
  process.stdout.write(`\r  [${String(elapsed).padStart(3)}s] alive devices: ${alive}  ${note.padEnd(16)}`);
  if (recovered && elapsed > 5) {
    await sleep(5000); // a few more seconds so you can feel it resume
    break;
  }
  await sleep(300); // discover() already waited 700 ms — keep the tick ~1 s
}
console.log();
hb.stopAll();
await hb.close();

rule("Result");
const icmpOk = sawZero && recovered;
if (!sawZero) {
  console.log("  ?  never saw the device go away — did you power it off?");
} else if (icmpOk) {
  console.log("  OK device was found again after the power cycle");
} else {
  console.log("  NG device never came back after power-on");
  console.log("     -> the receive path died. Do NOT publish this release.");
}
console.log(`  ${qualityOk ? "OK" : "NG"} quality: unicast smoother than broadcast = ${qualityOk ? "yes" : "no"}`);
console.log("\n  VERDICT: " + (icmpOk && qualityOk ? "PASS — good to publish" : "FAIL / needs a look"));
rl.close();
process.exit(icmpOk && qualityOk ? 0 : 1);
