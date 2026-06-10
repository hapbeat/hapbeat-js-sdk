# Hapbeat Arcade — チューニング対応表

各ゲームが鳴らす触覚イベントの一覧。**clip と gain は studio `showcase-kit` 由来の仮置き**で、最終調整はユーザーが行う前提。
変更の起点（source of truth）は [`shared/events.js`](./shared/events.js)。clip 差し替えは
[`demo-kit/hapbeat-arcade-manifest.json`](./demo-kit/hapbeat-arcade-manifest.json) +
[`demo-kit/install-clips/`](./demo-kit/install-clips/) → Studio で再配備。

- **既定 gain** … `events.js` の `gain`（manifest の `intensity` と整合）。`hb.play(id)` の基準値。
- **実 gain** … ゲーム実行時に渡す値。`固定` か、状況で動的にスケールするもの。
- **clip** … デバイスにインストールされる触覚波形（プレースホルダ）。`ch` は元 WAV のチャンネル数 / `ms` は長さ。

## 🧭 見えない壁の迷路 (maze)

| トリガー（いつ鳴る） | logical event | device event id | clip | ch/ms | 既定 gain | 実 gain | 調整メモ |
|---|---|---|---|---|---|---|---|
| 壁に接触 | `maze_bump` | `hapbeat-arcade.maze_bump` | z5_shot_light.wav | 1 / 94 | 0.50 | 0.3–0.9（接触速度で動的） | 「コツン」と短く欲しい。長いと連続接触で潰れる。straight 接触で 0.85 付近 |
| ゴール到達 | `maze_goal` | `hapbeat-arcade.maze_goal` | z2_door_unlock.wav | 2 / 479 | 0.60 | 0.65（固定） | 解放感のあるポジティブ。長め可。クリア時 1 発のみ |
| 壁接触で即死（Expert） | `maze_fail` | `hapbeat-arcade.maze_fail` | z2_door_slam.wav | 1 / 746 | 0.70 | 0.80（固定） | はっきり「失敗」と分かる強め。Expert のみ |

## 🥁 触覚リズム (rhythm)

| トリガー（いつ鳴る） | logical event | device event id | clip | ch/ms | 既定 gain | 実 gain | 調整メモ |
|---|---|---|---|---|---|---|---|
| 各拍のキュー（触覚メトロノーム） | `rhythm_cue` | `hapbeat-arcade.rhythm_cue` | z4_slider_tick.wav | 2 / 11 | 0.45 | 0.45（固定） | **最重要**。テンポを体で取れる明瞭な単発。短く立ち上がり鋭く。強すぎると hit と混ざる |
| 判定成功 | `rhythm_hit` | `hapbeat-arcade.rhythm_hit` | z1_pin_hit.wav | 1 / 50 | 0.50 | 0.6=Perfect / 0.4=Good | cue と質感を変える（叩いた確認）。Perfect を少し強く |
| 10 コンボごと | `rhythm_combo` | `hapbeat-arcade.rhythm_combo` | z5_tar_hit_light.wav | 1 / 50 | 0.55 | 0.60（固定） | ご褒美。節目だけなので少し豪華で可 |

## 💎 宝探し (hotcold)

| トリガー（いつ鳴る） | logical event | device event id | clip | ch/ms | 既定 gain | 実 gain | 調整メモ |
|---|---|---|---|---|---|---|---|
| 近接パルス（ガイガー） | `hot_pulse` | `hapbeat-arcade.hot_pulse` | z1_pin_hit.wav | 1 / 50 | 0.40 | 0.15–1.0（近さで動的）／間隔 600→90ms | **最重要**。遠＝弱く疎、近＝強く密。単発が短いほど「カウンタ感」が出る。空振りクリックは 0.12 固定 |
| ターゲット発見 | `hot_found` | `hapbeat-arcade.hot_found` | z5_tar_hit_heavy.wav | 2 / 844 | 0.60 | 0.65（固定） | 「当たり！」の強い当たり。長め・リッチで可 |
| 時間切れ | `hot_timeout` | `hapbeat-arcade.hot_timeout` | z2_door_slam.wav | 1 / 746 | 0.70 | 0.70（固定） | 失敗の締め。1 発のみ |

## ⚡ 反応速度 (reflex)

| トリガー（いつ鳴る） | logical event | device event id | clip | ch/ms | 既定 gain | 実 gain | 調整メモ |
|---|---|---|---|---|---|---|---|
| GO 合図 | `reflex_go` | `hapbeat-arcade.reflex_go` | z1_pin_hit.wav | 1 / 50 | 0.75 | 0.75（固定） | **最重要**。視覚 OFF でも気づける強く鋭い単発。立ち上がりが命。弱いと反応が遅れる |
| お手つき（フライング） | `reflex_foul` | `hapbeat-arcade.reflex_foul` | z2_door_slam.wav | 1 / 746 | 0.60 | 0.60（固定） | 「待ち」中に押した時の否定。GO とは明確に異質な質感に |
| 全ラウンド完了 | `reflex_win` | `hapbeat-arcade.reflex_win` | z5_tar_hit_heavy.wav | 2 / 844 | 0.60 | 0.60（固定） | 締めのご褒美。1 発のみ |

## 動的スケールの式（参考・調整時の目安）

- **maze_bump**: `gain = clamp(0.3 + min(1, 接触速度[px/s]/200) * 0.6, 0.3, 0.9)`（`games/maze.js` `onBump`）
- **hot_pulse**: `warmth = 1 - 距離/range`、`gain = lerp(0.15, 1.0, warmth^1.1)`、`間隔 = lerp(600ms, 90ms, warmth^1.3)`（`games/hotcold.js`）
- **rhythm_hit**: Perfect(±60ms)=0.6 / Good(±130ms)=0.4（`games/rhythm.js` `press`）

スケールの上下限・カーブを変えたい場合は各 `games/*.js` の該当箇所、基準強度を変えたい場合は
`events.js` の `gain` と manifest の `intensity` を両方合わせる。
