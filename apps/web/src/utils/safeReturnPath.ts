/** BFF / Web 共通の実装を re-export する。既存の相対 import を壊さないための
 *  互換レイヤ。新規コードは `@config-manager/shared` から直接 import してよい。 */
export { safeReturnPath } from "@config-manager/shared";
