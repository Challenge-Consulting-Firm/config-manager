package commands

import (
	"errors"
	"sort"
	"strings"
	"unicode"
)

// commandOverride（コンフィグ取得コマンドの上書き）の検証。
//
// 設計方針（Issue #76）:
//   - ヘルパー側を権威とする。SPA 側の検証は UX 補助であり、代替にはならない。
//   - CR / LF / NUL などの制御文字は対話シェルのコマンド境界を破り、1 本の
//     「取得コマンド」に複数コマンドを混在させられるため、接続前に拒否する。
//   - 保存済み認証情報（credentialToken）を使う経路では、osHint ごとに定義済みの
//     読み取り専用コマンドだけを許可する。高権限 credential と任意コマンドの
//     組み合わせを断ち、読み取り専用機能から設定変更へ昇格できないようにする。
//   - 都度入力の認証情報だけを使う経路では、未サポート機種のために、読み取り専用の
//     コマンド形（先頭語 allowlist + 安全な文字種）に限って自由入力を許可する。
//
// 検証エラーは入力コマンドを含めない。拒否ログやレスポンスへ入力がそのまま
// 出ると、誤って貼り付けられた認証情報が漏れるため。

// MaxOverrideLen は commandOverride の最大長（正規化後の文字数）。
// 実機の取得コマンドはいずれも 40 文字未満で、余裕を見た上限。
const MaxOverrideLen = 100

var (
	// ErrOverrideEmpty は空文字・空白のみの上書き。
	ErrOverrideEmpty = errors.New("command override is empty")
	// ErrOverrideTooLong は長すぎる上書き。
	ErrOverrideTooLong = errors.New("command override is too long")
	// ErrOverrideControlChar は CR / LF / NUL などの制御文字を含む上書き。
	ErrOverrideControlChar = errors.New("command override contains control characters")
	// ErrOverrideCharset は許可外の文字を含む上書き。
	ErrOverrideCharset = errors.New("command override contains disallowed characters")
	// ErrOverrideNotReadOnly は読み取り専用と判断できない上書き。
	ErrOverrideNotReadOnly = errors.New("command override is not a read-only command")
	// ErrOverrideNotAllowed は定義済み読み取り専用コマンド以外の上書き
	// （保存済み認証情報を使う経路で自由入力を拒否した場合）。
	ErrOverrideNotAllowed = errors.New("command override is not an allowed read-only command")
)

// readOnlyVerbs は自由入力を許可するコマンドの先頭語。いずれも表示系で、
// 機器の設定を変更しない。小文字で比較する。
var readOnlyVerbs = map[string]bool{
	"show":    true, // Cisco / YAMAHA / NEC IX ほか
	"display": true, // Huawei
	"get":     true, // Fortinet / ScreenOS
	"dir":     true, // ファイル一覧
	"more":    true, // ファイル表示
}

// allowedOverrides は osHint ごとの定義済み読み取り専用コマンド。
// 保存済み認証情報を使う経路では、この一覧に一致する上書きだけを許可する。
var allowedOverrides = map[string][]string{
	OsHintCiscoIOS: {
		"show running-config",
		"show startup-config",
		"show version",
	},
	OsHintYamahaRT: {
		"show config",
		"show config list",
		"show environment",
	},
	OsHintYamahaSWX: {
		"show running-config",
		"show startup-config",
		"show version",
	},
	// generic は既定の取得コマンドを持たないため、既知機種の読み取りコマンドを
	// まとめて候補にする。これ以外は都度入力の認証情報の場合のみ自由入力を許可。
	OsHintGeneric: {
		"show config",
		"show config list",
		"show environment",
		"show running-config",
		"show startup-config",
		"show version",
	},
}

// AllowedOverrides は osHint に対する定義済み読み取り専用コマンドを返す。
// 未知の osHint は generic と同じ扱い（Lookup と同じ方針）。
func AllowedOverrides(osHint string) []string {
	list, ok := allowedOverrides[osHint]
	if !ok {
		list = allowedOverrides[OsHintGeneric]
	}
	out := make([]string, len(list))
	copy(out, list)
	sort.Strings(out)
	return out
}

// ValidateCommandLine は機器へ 1 行として送るコマンドに、コマンド境界を破る
// 文字が含まれていないかを検証する。sendLine が末尾へ CR を付けて送るため、
// 入力に CR / LF / NUL などが混ざると複数コマンドの送信になる。
//
// セッション層の最終防衛線としても使う（CLI 経路を含め、ここを通らない
// 送信経路を作らない）。
func ValidateCommandLine(cmd string) error {
	for _, r := range cmd {
		if unicode.IsControl(r) {
			return ErrOverrideControlChar
		}
		// Unicode の行区切り。unicode.IsControl では拾えないが、端末や
		// 中間層によっては改行として解釈され得るため同様に拒否する。
		if r == '\u2028' || r == '\u2029' {
			return ErrOverrideControlChar
		}
	}
	return nil
}

// NormalizeOverride は上書きコマンドを正規化する。
//
//   - 前後の空白を除去する（末尾空白は機器によって意味を持たないため）
//   - 制御文字を含む場合は拒否する
//   - 連続する空白を 1 個へ畳む（allowlist 照合を安定させるため）
//   - 長すぎる場合は拒否する
func NormalizeOverride(raw string) (string, error) {
	if err := ValidateCommandLine(raw); err != nil {
		return "", err
	}
	cmd := strings.Join(strings.Fields(raw), " ")
	if cmd == "" {
		return "", ErrOverrideEmpty
	}
	if len([]rune(cmd)) > MaxOverrideLen {
		return "", ErrOverrideTooLong
	}
	return cmd, nil
}

// ValidateOverride は commandOverride を検証し、機器へ送ってよい正規化済み
// コマンドを返す。
//
// allowFreeform が false の場合（保存済み認証情報を使う経路）、osHint ごとの
// 定義済み読み取り専用コマンド以外は拒否する。true の場合でも、読み取り専用の
// コマンド形（先頭語 allowlist + 安全な文字種）に一致しないものは拒否する。
func ValidateOverride(osHint, raw string, allowFreeform bool) (string, error) {
	cmd, err := NormalizeOverride(raw)
	if err != nil {
		return "", err
	}
	if isAllowedOverride(osHint, cmd) {
		return cmd, nil
	}
	if !allowFreeform {
		return "", ErrOverrideNotAllowed
	}
	if err := checkReadOnlyShape(cmd); err != nil {
		return "", err
	}
	return cmd, nil
}

// isAllowedOverride は正規化済みコマンドが定義済み読み取り専用コマンドかを返す。
// 機器の CLI は大文字小文字を区別しないものが多いため、比較も区別しない。
func isAllowedOverride(osHint, cmd string) bool {
	lower := strings.ToLower(cmd)
	for _, allowed := range AllowedOverrides(osHint) {
		if lower == allowed {
			return true
		}
	}
	return false
}

// checkReadOnlyShape は自由入力コマンドが読み取り専用の形をしているかを検証する。
//
// シェル / CLI のメタ文字（";" "|" "&" "$" "`" "(" ")" など）を文字種の
// allowlist で排除し、先頭語を表示系コマンドに限定する。文字種を allowlist に
// するのは、機器ごとに異なる区切り文字を列挙し切れないため。
func checkReadOnlyShape(cmd string) error {
	for _, r := range cmd {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == ' ', r == '-', r == '_', r == '.', r == '/', r == ':':
		default:
			return ErrOverrideCharset
		}
	}
	verb, _, _ := strings.Cut(cmd, " ")
	if !readOnlyVerbs[strings.ToLower(verb)] {
		return ErrOverrideNotReadOnly
	}
	return nil
}
