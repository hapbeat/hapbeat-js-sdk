# Archived demos（非表示・保管）

採用見送りだが**残してある**デモ。メニュー（`shared/app.js` の `GAMES`）からは外してあるので非表示。

- `maze.js` — 見えない壁の迷路（衝突=二値）。"存在意義が不明" として見送り。
  方向ナビ用途（L/R 振動で曲がる方向提示・主観視点 / 地図ナビ）として作り直す案あり。
- `rhythm.js` — 触覚リズム（タイミング）。同上。timing primitive は「進捗をさわる」「ポモドーロ呼吸」等の実用デモへ転用検討中。

## 復活させるには
`shared/app.js` で import して `GAMES` に戻す:

```js
import { game as maze } from "../games/_archive/maze.js";
import { game as rhythm } from "../games/_archive/rhythm.js";
const GAMES = [hotcold, reflex, maze, rhythm];
```

各 event id（`hapbeat-arcade.maze_*` / `rhythm_*`）は `shared/events.js` と
`demo-kit/hapbeat-arcade-manifest.json` に残してあるのでそのまま動く。
import 深さは `../../shared/...`（このフォルダ基準）に調整済み。
