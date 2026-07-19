/**
 * localStorage を使ったシンプルな stale-while-revalidate キャッシュ。
 *
 * 画面遷移のたびに BFF へリクエストすると待ち時間が目立つ一覧系画面向けに、
 * 取得結果を localStorage に保持して次回訪問時に即時描画できるようにする。
 * キャッシュはあくまで「前回取得したスナップショット」であり、裏側で必ず
 * 最新データを取り直して上書きする前提。有効期限 (TTL) は設けず、表示後に
 * 必ず再取得が走るため新鮮さはバックグラウンド更新で担保する。
 */

const PREFIX = "cm:swr:";

interface CacheEntry<T> {
  /** 保存時刻 (ms)。デバッグ用。 */
  savedAt: number;
  /** キャッシュされたペイロード。 */
  data: T;
}

/**
 * キャッシュを読み出す。エントリが無い・読み込み失敗・パース失敗・スキーマ
 * 不整合のいずれかの場合は null を返し、呼び出し側は通常のローディング表示に
 * 戻せるようにする。
 */
export function readCache<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry<T>;
    if (!entry || typeof entry !== "object" || !("data" in entry)) {
      return null;
    }
    return entry.data;
  } catch {
    // localStorage が無効化されている・_quota 超過・破損データなどのケース。
    // キャッシュ無しとして扱い、通常のフェッチにフォールバックする。
    return null;
  }
}

/**
 * キャッシュを書き込む。書き込み失敗（プライベートモード・容量超過など）は
 * 単に無視し、呼び出し側へは例外を伝播させない。キャッシュはあくまで便宜的な
 * 表示高速化であり、書き込み失敗が機能に影響してはならないため。
 */
export function writeCache<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { savedAt: Date.now(), data };
    window.localStorage.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // プライベートモードや quota 超過の可能性がある。次回表示時にキャッシュ
    // が無いだけで機能自体に影響はないので静かに無視する。
  }
}

/** キャッシュを削除する（ログアウト時やキャッシュ無効化に使う）。 */
export function clearCache(key: string): void {
  try {
    window.localStorage.removeItem(PREFIX + key);
  } catch {
    // 読み込み時と同様に失敗は握りつぶす。
  }
}
