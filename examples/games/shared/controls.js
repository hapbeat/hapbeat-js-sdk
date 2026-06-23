/**
 * Shared in-toolbar controls for the arcade games.
 *
 * `modalityControls(bridge)` builds the 👁映像 / 👂音 / ✋触覚 toggle group that
 * lives in every game toolbar (between the input selector and the start button).
 * Each button carries its gamepad badge (Ⓧ/Ⓨ/Ⓑ) because, while a game is NOT
 * running, those pad buttons toggle the same channels — see `padModality()`.
 *
 * `padModality(pad, bridge, locked)` applies pad Ⓧ/Ⓨ/Ⓑ edges to the masters,
 * but only when `locked` is false (i.e. the game is not in progress — the user
 * asked that modality stay fixed mid-game so a run can't be altered halfway).
 */

import { BTN } from "./gamepad.js";

const MODS = [
  { key: "visual", label: "👁 映像", pad: "X", cls: "x" },
  { key: "audio", label: "👂 音", pad: "Y", cls: "y" },
  { key: "haptic", label: "✋ 触覚", pad: "B", cls: "b" },
];

/**
 * Returns { el, dispose }. `el` is a `.toggle-group.modality-group` of three
 * buttons wired to bridge.setMaster and kept in sync with bridge.master.
 */
export function modalityControls(bridge) {
  const el = document.createElement("span");
  el.className = "toggle-group modality-group";
  el.title = "モダリティ切替（パッドは Ⓧ/Ⓨ/Ⓑ・開始前のみ）";
  const btns = {};
  for (const m of MODS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "modbtn";
    b.innerHTML = `${m.label} <span class="padkey k-${m.cls}">${m.pad}</span>`;
    b.title = `${m.label}（パッド ${m.pad}：ゲーム開始前のみ切替）`;
    b.onclick = () => {
      if (m.key === "audio") bridge.unlockAudio();
      bridge.setMaster(m.key, !bridge.master[m.key]);
    };
    btns[m.key] = b;
    el.appendChild(b);
  }
  const sync = (b) => {
    for (const m of MODS) btns[m.key].setAttribute("aria-pressed", String(b.master[m.key]));
  };
  const dispose = bridge.onChange(sync); // onChange fires once immediately
  // Disable the buttons mid-run so a measurement game's channels can't be changed
  // partway through (mouse parity with the pad's idle-only Ⓧ/Ⓨ/Ⓑ lock).
  function setLocked(locked) {
    for (const m of MODS) btns[m.key].disabled = locked;
    el.title = locked
      ? "ゲーム中は変更できません（終了 / ストップ後に切替）"
      : "モダリティ切替（パッドは Ⓧ/Ⓨ/Ⓑ・開始前のみ）";
  }
  return { el, dispose, setLocked };
}

/**
 * While NOT locked (game idle), let pad Ⓧ/Ⓨ/Ⓑ toggle 映像/音/触覚. Call once per
 * frame with a polled Pad snapshot. No-op while locked so a run can't be altered
 * mid-game.
 * @param {{isDown:(b:number)=>boolean}} G  polled Pad snapshot
 */
export function padModality(G, bridge, locked) {
  if (locked || !G || !G.connected) return;
  if (G.isDown(BTN.X)) bridge.setMaster("visual", !bridge.master.visual);
  if (G.isDown(BTN.Y)) { bridge.unlockAudio(); bridge.setMaster("audio", !bridge.master.audio); }
  if (G.isDown(BTN.B)) bridge.setMaster("haptic", !bridge.master.haptic);
}

const NAME_KEY = "hapbeat-arcade-player";

/** Which modalities are currently ON, as keys — for ranking badges. */
export function activeMods(bridge) {
  return ["visual", "audio", "haptic"].filter((k) => bridge.master[k]);
}

// Friendly two-part random handles so an unnamed visitor still gets a distinct,
// memorable booth name instead of a blank row.
const NAME_ADJ = ["あかい", "あおい", "きいろ", "みどり", "はやい", "しずか", "げんき", "ゆうき", "つよい", "かしこい", "ぴかぴか", "もふもふ", "きらきら", "ふわふわ", "すばやい", "ねむい"];
const NAME_NOUN = ["きつね", "たぬき", "うさぎ", "ねこ", "いぬ", "ぱんだ", "らっこ", "ぺんぎん", "ふくろう", "りす", "くま", "しか", "かもめ", "いるか", "とら", "ぞう"];
export function randomName() {
  // index-by-time is fine in the browser; pick adjective + noun + 2 digits
  const r = () => Math.floor(Math.random() * 1e6);
  return NAME_ADJ[r() % NAME_ADJ.length] + NAME_NOUN[r() % NAME_NOUN.length] + (10 + (r() % 90));
}

/**
 * A small "名前" input for the ranking board. The input is EMPTY by default; a
 * random handle is shown as the PLACEHOLDER and re-rolled each play (call roll()
 * on game start). A blank entry records under the placeholder's current random
 * name; typed text takes priority (and persists for that visitor's session).
 * Returns { el, get, roll }.
 */
export function playerNameField() {
  const el = document.createElement("label");
  el.className = "namefield";
  el.innerHTML = `名前 <input type="text" maxlength="18" /><button type="button" class="namedice" title="ランダム名を引き直す">🎲</button>`;
  const input = el.querySelector("input");
  let ph = randomName();
  input.placeholder = ph;
  try { input.value = localStorage.getItem(NAME_KEY) || ""; } catch { /* private mode */ } // empty unless a prior typed value
  input.oninput = () => { try { localStorage.setItem(NAME_KEY, input.value); } catch { /* ignore */ } };
  el.querySelector(".namedice").onclick = () => { // reroll the suggestion (and clear any typed name)
    ph = randomName(); input.placeholder = ph; input.value = "";
    try { localStorage.removeItem(NAME_KEY); } catch { /* ignore */ }
  };
  return {
    el,
    get: () => input.value.trim() || ph, // typed wins; else the placeholder random
    roll: () => { if (!input.value.trim()) { ph = randomName(); input.placeholder = ph; } }, // new random per play (only when blank)
  };
}
