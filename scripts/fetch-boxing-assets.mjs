#!/usr/bin/env node
/**
 * boxing デモの外部アセット取得（Node 標準のみ・依存なし）。
 *
 * 取得するもの（いずれも CC0。出典は examples/games/boxing/assets/CREDITS.md に書き出す）:
 *   1. 背景 HDRI  … Poly Haven "Wrestling Gym"（API から直接ダウンロードできる）
 *   2. 人型モデル … Quaternius "Universal Base Characters"
 *                   ※ 配布が itch.io のボタン経由で**直リンクが無い**ため自動取得できない。
 *                     手動でダウンロードした zip を assets/downloads/ に置けば、この
 *                     スクリプトが必要な glTF だけ取り出して配置する。
 *
 * アセットはバイナリなのでリポジトリにコミットしない（assets/ は .gitignore）。
 * 置かれていない場合、デモは自動的にプリミティブ表現へフォールバックする。
 *
 *   node scripts/fetch-boxing-assets.mjs          # HDRI を取得 + zip があれば展開
 *   node scripts/fetch-boxing-assets.mjs --1k     # 軽い 1K HDRI にする（非力な PC 向け）
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "../examples/games/boxing/assets");
const DOWNLOADS = join(ASSETS, "downloads");

const HDRI = {
  name: "Wrestling Gym",
  author: "Sergej Majboroda",
  page: "https://polyhaven.com/a/wrestling_gym",
  license: "CC0",
  url: (size) => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${size}/wrestling_gym_${size}.hdr`,
};
const CHARACTERS = {
  name: "Universal Base Characters",
  author: "Quaternius",
  page: "https://quaternius.com/packs/universalbasecharacters.html",
  itch: "https://quaternius.itch.io/universal-base-characters",
  license: "CC0",
};
/** zip から取り出したい glTF（プレイヤー / 敵で別モデルにする）。 */
const WANTED = [
  { out: "player.glb", match: /(male|man|regular).*\.glb$/i },
  { out: "enemy.glb", match: /(female|woman|regular).*\.glb$/i },
];

async function download(url, dest, redirects = 5) {
  await mkdir(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  await pipeline(res.body, createWriteStream(dest));
  const { size } = await stat(dest);
  return size;
}

/**
 * 最小限の zip 展開（末尾の中央ディレクトリを読んで、必要なエントリだけ inflate する）。
 * 依存を増やさないための実装。store(0) と deflate(8) のみ対応。
 */
function unzipEntries(buf, wantFn) {
  const eocd = (() => {
    for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  })();
  if (eocd < 0) throw new Error("zip の中央ディレクトリが見つかりません");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!wantFn(name)) continue;
    // ローカルヘッダを読んでデータ位置を出す
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnLen + leLen;
    const raw = buf.slice(start, start + compSize);
    out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
  }
  return out;
}

async function extractCharacters() {
  let zips = [];
  try {
    zips = (await readdir(DOWNLOADS)).filter((f) => f.toLowerCase().endsWith(".zip"));
  } catch {
    return false; // downloads/ が無い
  }
  if (!zips.length) return false;
  let placed = 0;
  for (const zip of zips) {
    const buf = await readFile(join(DOWNLOADS, zip));
    for (const want of WANTED) {
      const hit = unzipEntries(buf, (n) => want.match.test(n))[0];
      if (!hit) continue;
      await writeFile(join(ASSETS, want.out), hit.data);
      console.log(`  ✓ ${want.out}  ← ${zip}:${hit.name} (${(hit.data.length / 1e6).toFixed(1)}MB)`);
      placed++;
    }
  }
  return placed > 0;
}

async function writeCredits(hdriFile, hasChars) {
  const lines = [
    "# boxing デモの外部アセット（出典）",
    "",
    "いずれも **CC0**（パブリックドメイン相当）。CC0 は表示義務が無いが、出典は残す。",
    "このフォルダの中身は git にコミットしていない（`scripts/fetch-boxing-assets.mjs` で取得する）。",
    "",
    `## 背景 HDRI — ${HDRI.name}`,
    "",
    `- 作者: ${HDRI.author}`,
    `- 出典: ${HDRI.page}`,
    `- ライセンス: ${HDRI.license}`,
    `- ファイル: \`${hdriFile ?? "(未取得)"}\``,
    "",
    `## 人型モデル — ${CHARACTERS.name}`,
    "",
    `- 作者: ${CHARACTERS.author}`,
    `- 出典: ${CHARACTERS.page}`,
    `- 配布: ${CHARACTERS.itch}`,
    `- ライセンス: ${CHARACTERS.license}`,
    `- 状態: ${hasChars ? "配置済み（player.glb / enemy.glb）" : "**未配置**（手動ダウンロードが必要。README 参照）"}`,
    "",
    "リング（マット・ポスト・ロープ・コーナーパッド）は Three.js の簡易ジオメトリで自作。",
    "",
  ];
  await writeFile(join(ASSETS, "CREDITS.md"), lines.join("\n"), "utf8");
}

async function main() {
  const size = process.argv.includes("--1k") ? "1k" : "2k";
  await mkdir(ASSETS, { recursive: true });
  console.log("boxing アセット取得");

  let hdriFile = null;
  try {
    const dest = join(ASSETS, `wrestling_gym_${size}.hdr`);
    const bytes = await download(HDRI.url(size), dest);
    hdriFile = `wrestling_gym_${size}.hdr`;
    console.log(`  ✓ ${hdriFile} (${(bytes / 1e6).toFixed(1)}MB) — ${HDRI.page} / CC0`);
  } catch (e) {
    console.warn(`  ✗ HDRI を取得できませんでした: ${e.message}`);
    console.warn(`    手動: ${HDRI.page} から 2K .hdr を ${ASSETS} に置く`);
  }

  const hasChars = await extractCharacters();
  if (!hasChars) {
    console.log("");
    console.log("  ! 人型モデルは自動取得できません（itch.io のボタン経由で配布されているため）。");
    console.log("    1. " + CHARACTERS.itch + " から glTF 版をダウンロード（CC0 / 0 円でも可）");
    console.log("    2. zip をそのまま " + DOWNLOADS + " に置く");
    console.log("    3. もう一度このスクリプトを実行すると player.glb / enemy.glb を取り出します");
    console.log("    （手動で置く場合は assets/player.glb, assets/enemy.glb という名前にする）");
  }

  await writeCredits(hdriFile, hasChars);
  console.log("");
  console.log(`アセットが無い場合、デモは自動的にプリミティブ表現で動きます（${ASSETS}）。`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
