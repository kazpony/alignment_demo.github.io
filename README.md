# ホイールアライメント計測 PWA（並進基準法・逐次1台方式）

スマートフォンの IMU（加速度・ジャイロ）だけで、**キャンバー**と**トー（相対）**を計測する
Web アプリ（PWA）の雛形です。**磁気センサは使いません**（ホイール近傍の磁気歪みを避けるため）。
GitHub Pages でそのまま公開できるよう、**すべて相対パス**・`.nojekyll` 込みで構成しています。

---

## 特長 / 設計の要点

- **並進基準法**: 車体を前後に転がした際の「共通並進方向」を機械的な方位基準に使う。
- **TRIAD 合成**: 重力ベクトル＋並進ベクトルから各センサ座標を車両座標へ統一。
  角度計算はセンサ座標内で完結するため、**治具の取付平行度誤差を自己吸収**（バイアスなし）。
- **直進ゲート**: 水平面内の線形加速度の「2次元的広がり」で“曲がった押し”を自動棄却。
  定常クラブ（真っ直ぐだが角度付きの平行移動）は原理的に検出不能な床オフセットとして扱う。
- **逐次1台**: 各輪を順に計測し合算。キャンバー/キャスターは重力基準なので無リスク、
  トーのみ「直進の再現性」を担保（ゲート＋舵角固定＋床ガイド）。
- **オフライン動作**: Service Worker でキャッシュ、ホーム画面追加可。

数理は付属の `../toe_sim.py`（シミュレータ）Part A と一致。`estimator.js` は Node でも動き、
`node _test_estimator.js` で合成データ→復元の一致を検証できます。

---

## ファイル構成

```
pwa/
├─ index.html            # UI
├─ styles.css            # スタイル
├─ estimator.js          # 信号処理コア（TRIAD/PCA/ゲート/CSV, 依存なし）
├─ sensors.js            # センサ抽象（Generic Sensor API + DeviceMotion）
├─ app.js                # ステートマシン/セッション/UI配線
├─ manifest.webmanifest  # PWA マニフェスト（相対パス）
├─ sw.js                 # Service Worker（相対パス）
├─ .nojekyll             # GitHub Pages の Jekyll 処理を無効化（重要）
├─ icons/
│  ├─ icon-192.png
│  └─ icon-512.png
├─ _test_estimator.js    # Node 用の数理検証（デプロイ不要）
└─ README.md
```

---

## GitHub Pages への公開手順

### 方法A: リポジトリ直下に置く（`https://<user>.github.io/<repo>/` で配信）

1. 新規リポジトリを作成し、`pwa/` の中身を**リポジトリ直下**にコピー
   （`index.html` がルートに来るように）。
2. コミット & push。
   ```bash
   git init
   git add .
   git commit -m "alignment PWA skeleton"
   git branch -M main
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
3. GitHub の **Settings → Pages** で
   - **Source**: `Deploy from a branch`
   - **Branch**: `main` / `/ (root)` を選択して保存。
4. 数十秒後、`https://<user>.github.io/<repo>/` で公開。**HTTPS 自動付与**。

### 方法B: `docs/` サブフォルダで公開

1. `pwa/` の中身を `docs/` に置く。
2. Settings → Pages → Branch: `main` / `/docs` を選択。

> **サブパス配信でも動くように**、本アプリは manifest / SW / スクリプトを
> すべて `./` の相対パスで参照し、SW の登録も `register('./sw.js', {scope:'./'})`
> としています。`.nojekyll` があるため `_test_...` 等のアンダースコア始まりも配信されます
> （不要ならデプロイ前に削除可）。

---

## 使い方（実機）

1. Android Chrome で公開 URL を開く（**HTTPS 必須**。GitHub Pages はOK）。
2. **権限** → **センサ起動**。`mode` が `generic` か `devicemotion` か、`実効Hz` を確認
   （100Hz 近くが理想。低い場合は端末負荷を下げる）。
3. **対象輪**を選択。治具で端末をハブ中心に固定（背面＝ハブ面と平行）。
4. **① 静止取得**（1.5秒静止）→ 重力・ジャイロバイアス・静止キャンバーを記録。
5. **② 押して計測** → 床ガイドに沿って**前後に短く強く**。2秒後に自動判定。
   - 通過 → 「採用」。曲がり/弱い → 「やり直し」。
6. 採用回数に達したら次の輪へ。4輪完了で**総トー・スラスト角・スラストライン基準トー**を表示。
7. **CSVエクスポート**で結果＋生ログを保存（後処理は Python で）。

### 精度と運用の勘所（シミュレータ結果より）
- スイートスポットは **ゲート閾値 0.5〜1.0° × 採用 3〜5回**。
- **絶対トーの一発値より、同一治具・同一場所での「相対トー（調整前後差・左右差）」が高再現性**。
- 誤差の下限は「床オフセット（真っ直ぐだが角度付きの押し）」が決めるため、
  **床ガイドと停止手順の統一**が最重要。

---

## ローカル確認

Service Worker と Generic Sensor API は **セキュアコンテキスト**が必要です。
`localhost` は例外的に http でも可。

```bash
# いずれかで pwa/ を配信
python -m http.server 8080          # → http://localhost:8080
# または
npx serve .
```

PC では IMU が無いため計測はできませんが、UI 遷移・SW 登録・CSV 出力は確認できます。
実センサ検証は実機（Android）で行ってください。

---

## 既知の制限 / 今後

- **キャスター/SAI**（舵角スイープ法）は未実装（UI枠のみ）。次フェーズで追加予定。
- **絶対トー**は本方式の苦手領域。高精度化は将来的に ESP32 治具＋ハード同期
  （並進基準法の精度上限UP）や車輪間レーザ光学（別原理で磁気の壁を回避）を想定。
- iOS Safari は `DeviceMotionEvent.requestPermission` が必要（「権限」ボタンで対応済み）。
  ただし本アプリの主対象は Android。

---

## ライセンス / 帰属
社内 PoC 用の雛形。数式・アルゴリズムの詳細は同梱の仕様書
`../アライメント計測アプリ_仕様書.md` を参照。
