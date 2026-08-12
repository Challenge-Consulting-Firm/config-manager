// Package commands は osHint 別のコマンドマップを提供する。
//
// ページング抑制コマンドは空文字列の場合があり、その場合は送信しない
// （YAMAHA RT はページング抑制不要）。
package commands

// CommandSet は 1 つの osHint に対するコマンドセット。
type CommandSet struct {
	// PagerSuppress はページング抑制コマンド。空文字列の場合は送信しない。
	// 例: "terminal length 0"（Cisco IOS）
	PagerSuppress string

	// Fetch はコンフィグ取得コマンド。
	// 例: "show running-config"（Cisco IOS）, "show config"（YAMAHA RT）
	Fetch string
}

// OsHint 定数。packages/shared/src/helper.ts の HelperOsHint と一致させる。
const (
	OsHintCiscoIOS  = "cisco-ios"
	OsHintYamahaRT  = "yamaha-rt"
	OsHintYamahaSWX = "yamaha-swx"
	OsHintGeneric   = "generic"
)

// Lookup は osHint に対応するコマンドセットを返す。
// 未知の osHint の場合は generic として扱う。
//
// generic は Fetch コマンドを持たず、commandOverride 必須（呼び出し側で判定）。
// PagerSuppress は "terminal length 0" を試行する（多くの機種で有効なため）。
func Lookup(osHint string) CommandSet {
	switch osHint {
	case OsHintCiscoIOS:
		return CommandSet{
			PagerSuppress: "terminal length 0",
			Fetch:         "show running-config",
		}
	case OsHintYamahaRT:
		// YAMAHA RT はページング抑制設定が不要（show config は一度に出力される）。
		return CommandSet{
			PagerSuppress: "",
			Fetch:         "show config",
		}
	case OsHintYamahaSWX:
		// YAMAHA SWX（L2/L3 スイッチ）は RT と CLI 体系が異なり、Cisco 風の
		// "show running-config" / "terminal length 0" を使う。RT 用の
		// "show config" を送ると "% Invalid input detected at '^' marker." を返す。
		return CommandSet{
			PagerSuppress: "terminal length 0",
			Fetch:         "show running-config",
		}
	case OsHintGeneric:
		// generic: フェーズ 1 では動作確認対象外（正式サポートは Cisco IOS/IOS-XE と
		// YAMAHA RT のみ）。commandOverride 必須で取得コマンドをユーザーが指定する前提。
		// PagerSuppress は多くの機種で有効な "terminal length 0" を試行する。
		return CommandSet{
			PagerSuppress: "terminal length 0",
			Fetch:         "", // commandOverride 必須
		}
	default:
		// 未知の osHint は generic として扱う。
		return CommandSet{
			PagerSuppress: "terminal length 0",
			Fetch:         "",
		}
	}
}

// Valid は osHint が既知の値かを返す。
func Valid(osHint string) bool {
	switch osHint {
	case OsHintCiscoIOS, OsHintYamahaRT, OsHintYamahaSWX, OsHintGeneric:
		return true
	default:
		return false
	}
}
