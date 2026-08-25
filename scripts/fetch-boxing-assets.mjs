#!/usr/bin/env node
/** Extract optional CC0 humanoids from a user-supplied Quaternius zip. No photo/HDRI assets. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const assets = resolve(dirname(fileURLToPath(import.meta.url)), "../examples/games/boxing/assets");
const downloads = join(assets, "downloads");
const characters = { name: "Universal Base Characters", author: "Quaternius",
  page: "https://quaternius.com/packs/universalbasecharacters.html", itch: "https://quaternius.itch.io/universal-base-characters", license: "CC0" };
const wanted = [{ out: "player.glb", match: /(male|man|regular).*\.glb$/i }, { out: "enemy.glb", match: /(female|woman|regular).*\.glb$/i }];

function unzipEntries(buffer, want) {
  let eocd = -1;
  for (let i = buffer.length - 22; i > buffer.length - 66000 && i >= 0; i--) if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("zip の中央ディレクトリが見つかりません");
  const count = buffer.readUInt16LE(eocd + 10); let pos = buffer.readUInt32LE(eocd + 16); const out = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(pos + 10), size = buffer.readUInt32LE(pos + 20), nameLength = buffer.readUInt16LE(pos + 28);
    const extra = buffer.readUInt16LE(pos + 30), comment = buffer.readUInt16LE(pos + 32), local = buffer.readUInt32LE(pos + 42);
    const name = buffer.slice(pos + 46, pos + 46 + nameLength).toString("utf8"); pos += 46 + nameLength + extra + comment;
    if (!want(name)) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    out.push({ name, data: method === 0 ? buffer.slice(start, start + size) : inflateRawSync(buffer.slice(start, start + size)) });
  }
  return out;
}

async function extractCharacters() {
  let zips = []; try { zips = (await readdir(downloads)).filter((file) => file.toLowerCase().endsWith(".zip")); } catch { return false; }
  let placed = 0;
  for (const zip of zips) for (const entry of wanted) {
    const hit = unzipEntries(await readFile(join(downloads, zip)), (name) => entry.match.test(name))[0];
    if (hit) { await writeFile(join(assets, entry.out), hit.data); console.log(`  ✓ ${entry.out} ← ${zip}:${hit.name}`); placed++; }
  }
  return placed > 0;
}

async function main() {
  await mkdir(assets, { recursive: true });
  const present = await extractCharacters();
  await writeFile(join(assets, "CREDITS.md"), ["# boxing デモの任意人型アセット", "", `- ${characters.name} — ${characters.author}`, `- 出典: ${characters.page}`, `- 配布: ${characters.itch}`, `- ライセンス: ${characters.license}`, `- 状態: ${present ? "配置済み（player.glb / enemy.glb）" : "未配置"}`, "", "背景・リング・照明は Three.js の自作表現。写真背景・HDRI は使用しない。", ""].join("\n"));
  if (!present) console.log(`人型は ${characters.itch} から glTF zip を取得し、${downloads} に置いてください。`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
