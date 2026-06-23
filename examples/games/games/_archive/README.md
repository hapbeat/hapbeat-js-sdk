# Archived demos（非表示・保管）

採用見送りだが**残してある**デモ。メニュー（`shared/app.js` の `GAMES`）からは外してあるので非表示。

- `maze.js` — 見えない壁の迷路（衝突=二値）。"存在意義が不明" として見送り。
  方向ナビ用途（L/R 振動で曲がる方向提示・主観視点 / 地図ナビ）として作り直す案あり。
- `rhythm.js` — 触覚リズム（タイミング）。同上。timing primitive は「進捗をさわる」「ポモドーロ呼吸」等の実用デモへ転用検討中。
- `spatialalert.js` — どっちで鳴った（Spatial Alert）。左右どちらで発火したかを当てる。非表示化。
- `progress.js` — 進捗をさわる（Feel-the-Wait）。進捗・待ち時間を触覚で表現。非表示化。
- `walknav.js` — 顔を上げて歩くナビ（Eyes-Up Walk Nav）。L/R 振動で曲がる方向を提示。非表示化。

> なお `heatcursor.js`（ヒートカーソル）は `hotcold.js`（宝探し）と機構が実質同じため**削除**した（git 履歴で復元可）。

## 復活させるには
`shared/app.js` で import して `GAMES` に戻す:

```js
import { game as maze } from "../games/_archive/maze.js";
import { game as rhythm } from "../games/_archive/rhythm.js";
const GAMES = [hotcold, reflex, maze, rhythm];
```

> ⚠️ これらのアーカイブは旧 `shared/events.js`（削除済み）時代のもの。現在の触覚/音は
> `shared/event-content.js` の `CONTENT` に集約されており、`maze_*` / `rhythm_*` の
> イベントは CONTENT に存在しない。復活させる場合は対応する行を `event-content.js` に
> 追加すること（`bridge.fire("maze_bump")` 等が CONTENT 参照になっているため）。
import 深さは `../../shared/...`（このフォルダ基準）に調整済み。
