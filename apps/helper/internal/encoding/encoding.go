// Package encoding は Telnet で受信したバイト列の文字コード判定と
// UTF-8 変換を行う。
//
// YAMAHA RT は "console character sjis" 設定時に Shift_JIS で日本語を
// 出力するため、受信バイト列を UTF-8 へ正規化する必要がある。
// Cisco IOS は通常 ASCII/UTF-8 で応答するため、そのまま返す。
package encoding

import (
	"unicode/utf8"

	"golang.org/x/text/encoding/japanese"
)

// SourceEncoding は変換元の文字コードを表す識別子。
// meta.sourceEncoding にそのまま設定される。
const (
	ShiftJIS = "shift_jis"
	UTF8     = "utf-8"
)

// Decode はバイト列を UTF-8 文字列へ変換する。
//
// 変換戦略:
//  1. 既に UTF-8 として妥当ならそのまま（sourceEncoding="utf-8"）
//  2. Shift_JIS としてデコードを試行（sourceEncoding="shift_jis"）
//  3. SJIS 変換に失敗した場合は不正バイトを置換文字に置き換えて続行
//
// フェイルファストしないのは、一部バイトが壊れていてもコンフィグ本文の
// 一次取得を優先するため（フェーズ 1 の方針）。
//
// 戻り値の encoding は "utf-8" または "shift_jis"。
func Decode(raw []byte) (text string, encoding string) {
	// 1. UTF-8 として妥当なら ASCII 互換の範囲も含めてそのまま採用。
	if utf8.Valid(raw) {
		return string(raw), UTF8
	}

	// 2. UTF-8 でなければ Shift_JIS を試す（YAMAHA RT の SJIS 設定を想定）。
	// japanese.ShiftJIS.NewDecoder().String は不正バイトを
	// Unicode Replacement Character (U+FFFD) に置き換えるため、
	// エラーで止まることなく文字列化できる。
	dec := japanese.ShiftJIS.NewDecoder()
	text, err := dec.String(string(raw))
	if err != nil {
		// Decoder は内部でエラーを置換文字化するため、ここに来るのは
		// 極めて異常なケース。その場合は生バイトを無理やり文字列化して
		// 取得自体は成立させる（クライアント側で後段の検証で弾く）。
		return string(raw), ShiftJIS
	}
	return text, ShiftJIS
}
