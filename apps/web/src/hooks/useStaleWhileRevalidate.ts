/**
 * stale-while-revalidate パターンの React フック。
 *
 * - 初回マウント時に localStorage のキャッシュを同期的に読み出し、即時描画させる。
 * - 並行して裏側で最新データを取得し、成功後に state とキャッシュを上書きする。
 * - キャッシュが無い場合は従来通りローディング表示になる。
 *
 * キーは localStorage の接頭辞込みではない一意な文字列（例: "devices"）。
 * 同一 key でフェッチ結果が変わらない場合に備え、fetcher はコンポーネント側で
 * useCallback 等でメモ化するか、key 変更時に再取得させる設計を想定している。
 */
import { useEffect, useRef, useState } from "react";
import { ApiError } from "../apiClient";
import { readCache, writeCache } from "../utils/swrCache";

export interface SwrResult<T> {
  /** キャッシュまたはフェッチ結果。どちらも無い場合は null。 */
  data: T | null;
  /** フェッチ中か。キャッシュ表示中も true になる（再取得を知らせるため）。 */
  loading: boolean;
  /** バックグラウンド取得が失敗した場合のメッセージ。 */
  error: string | null;
  /** data がキャッシュ由来（まだ再取得結果が来ていない）か。 */
  stale: boolean;
}

export function useStaleWhileRevalidate<T>(
  key: string,
  fetcher: () => Promise<T>,
): SwrResult<T> {
  // 初期 state はキャッシュを同期的に読み出した結果。SSR 安全のため window は
  // ファイルトップではなくフック内で参照する。
  const [data, setData] = useState<T | null>(() => readCache<T>(key));
  const [error, setError] = useState<string | null>(null);
  // stale: data がキャッシュ由来で、まだフェッチ結果で上書きされていない状態。
  // 初期描画時にキャッシュがあれば stale=true で開始し、フェッチ成功で false にする。
  // キャッシュが無ければ最新データ待ちなので stale ではなく単なる loading。
  const [stale, setStale] = useState<boolean>(() => data !== null);
  // キャッシュ有無にかかわらず、初回マウント時は必ずフェッチを走らせる。
  const [loading, setLoading] = useState<boolean>(() => data === null);

  // アンマウント後の state 更新を防ぐためのフラグ。
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    // key が変わった場合: キャッシュを再読み込みして即時描画、そのあと再取得。
    const cached = readCache<T>(key);
    if (cached !== null) {
      setData(cached);
      setStale(true);
      setLoading(false);
      setError(null);
    } else {
      // キャッシュが無い場合は loading を有効にしてプレースホルダ表示。
      setLoading(true);
      setStale(false);
    }

    (async () => {
      try {
        const fresh = await fetcher();
        if (!active.current) return;
        setData(fresh);
        writeCache(key, fresh);
        setError(null);
        setStale(false);
      } catch (e) {
        if (!active.current) return;
        setError(e instanceof ApiError ? e.message : String(e));
      } finally {
        if (active.current) setLoading(false);
      }
    })();

    return () => {
      active.current = false;
    };
    // fetcher は一般にインラインで渡されるため参照が毎回変わる。key 変更時のみ
    // 再フェッチさせ、それ以外の不要な再取得は防ぐため依存配列からは外す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { data, loading, error, stale };
}
