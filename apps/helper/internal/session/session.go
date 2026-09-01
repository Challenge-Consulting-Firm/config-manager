// Package session は Telnet / SSH 共通の「対話シェルからコンフィグを取得する」
// 状態機械を実装する。
//
// 取得フロー（トランスポート接続後）:
//  1. ログイン（ModeInteractiveLogin の場合のみ。プロンプトへ認証情報を送信）
//  2. enable 昇格（EnablePassword があれば）
//  3. 改行を送ってプロンプト文字列を学習
//  4. ページング抑制コマンド + コンフィグ取得コマンドを送り、本文を回収
//  5. エコー・プロンプト行を除去し、ページャ残留とコマンド拒否を検出
//  6. SJIS→UTF-8 変換
//
// プロトコル固有の処理（TCP 接続と IAC ネゴシエーション、SSH ハンドシェイクと
// PTY 要求）は internal/telnet・internal/ssh が担い、本パッケージへは
// {@link Stream} として渡される。
//
// パスワード類は本パッケージ内でもログ出力・永続化しない。Run 完了後は
// 呼び出し側で *Config の参照を破棄し、GC に回収させることを前提とする。
package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/commands"
	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/encoding"
)

// Stream は機器との対話ストリーム。Telnet では IAC を除去済みの TCP 接続、
// SSH では PTY 付きシェルセッションの stdin/stdout が実装を提供する。
//
// SetReadDeadline は net.Conn と同じ意味を持つ（期限超過時は Timeout() が true の
// エラーを返す）。SSH の io.Reader には期限の概念が無いため、実装側で
// goroutine とタイマーによる期限付き読み取りを用意する。
type Stream interface {
	io.Reader
	io.Writer
	// SetReadDeadline は以降の Read の期限を設定する。
	SetReadDeadline(t time.Time) error
}

// Mode はログイン方式。トランスポートが認証を担うかどうかで分かれる。
type Mode int

const (
	// ModeInteractiveLogin は接続直後に対話ログイン（Username/Password のプロンプト
	// 応答）を行う。Telnet 用。
	ModeInteractiveLogin Mode = iota
	// ModePreAuthenticated はプロトコル層で認証が完了している前提で、プロンプト学習
	// から開始する。SSH 用。
	ModePreAuthenticated
)

// Config は 1 回の取得のパラメータ。
//
// パスワード類（Password, EnablePassword）はログ・ファイルへ絶対に出さない。
type Config struct {
	Host            string
	Port            int
	Username        string
	Password        string // 機密: ログ/ファイル出力禁止
	EnablePassword  string // 機密: ログ/ファイル出力禁止（空なら enable 昇格しない）
	OSHint          string
	CommandOverride string // 空でなければ Fetch コマンドを上書き
	PagerSuppress   string // 空なら送信しない
	FetchCommand    string // コンフィグ取得コマンド
	ConnectTimeout  time.Duration
	LoginTimeout    time.Duration
	CommandTimeout  time.Duration
	TotalTimeout    time.Duration
}

// Result は取得成功時の結果。
type Result struct {
	Body           string
	Prompt         string // 学習したプロンプト
	Command        string // 実行した取得コマンド
	SourceEncoding string // "utf-8" または "shift_jis"
	ElapsedMs      int64  // トランスポート側で接続開始からの経過を設定する
}

// ErrorCode は packages/shared/src/helper.ts の HelperFetchErrorCode と一致させる。
type ErrorCode string

const (
	CodeConnectFailed   ErrorCode = "connect_failed"
	CodeAuthFailed      ErrorCode = "auth_failed"
	CodePromptNotFound  ErrorCode = "prompt_not_found"
	CodeTimeout         ErrorCode = "timeout"
	CodePagerDetected   ErrorCode = "pager_detected"
	CodeEmptyBody       ErrorCode = "empty_body"
	CodeHandshakeFailed ErrorCode = "handshake_failed"  // SSH: 暗号方式のネゴシエーション失敗
	CodeHostKeyMismatch ErrorCode = "host_key_mismatch" // SSH: 記録済みホスト鍵と不一致
	// CodeCommandInvalid は送信前の検証で取得コマンドを拒否した場合。
	// 機器へは接続・送信しない（fail closed）。
	CodeCommandInvalid ErrorCode = "command_invalid"
	// CodeCommandRejected は機器が取得コマンド自体を受け付けなかった場合。
	// osHint と実機のコマンド体系が食い違っているか、特権モードに昇格できて
	// いないケースが典型。
	CodeCommandRejected ErrorCode = "command_rejected"
)

// Error は取得失敗時のエラー。Code で機械可読な原因を区別する。
type Error struct {
	Code    ErrorCode
	Message string
	Cause   error // ラップ元エラー（クライアントへは送らない）
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.Cause }

// NewError は Cause 付きの Error を作る。
func NewError(code ErrorCode, message string, cause error) *Error {
	return &Error{Code: code, Message: message, Cause: cause}
}

// ログインプロンプトの正規表現。複数バリエーションを許容する。
// 大文字小文字は区別しない（機器によって表記揺れがある）。
var (
	loginPromptRe = regexp.MustCompile(`(?i)(?:login\s*[:：]|user\s*name\s*[:：]|username\s*[:：])\s*$`)
	passwordRe    = regexp.MustCompile(`(?i)(?:password|passwd|パスワード)\s*[:：]?\s*$`)
	// プロンプト全体行（学習時に最後の非空行を採用するため、行マッチを使う）。
	promptLineRe = regexp.MustCompile(`(?m)^[ \t]*[\w.\-()]+(?:[^\r\n]*?)[>#]\s*$`)
)

// pagerMarkerRe はページャの "--More--" 系マーカを検出する。
// Cisco: "--More--", YAMAHA: "---- More ----" など。
var pagerMarkerRe = regexp.MustCompile(`(?i)-+\s*more\s*-+`)

// Run は接続済みストリームからコンフィグ本文を取得する。失敗時は *Error を返す。
//
// ctx には全体タイムアウト（TotalTimeout）を設定したコンテキストを渡すこと。
// 本関数内部で段階別タイムアウト（Login/Command）も適用する。
// Result.ElapsedMs は 0 のまま返すため、接続時間を含めた計測は呼び出し側で行う。
func Run(ctx context.Context, s Stream, cfg *Config, mode Mode) (*Result, error) {
	// 事前チェック: 取得コマンドが空なら実行前に弾く。
	if strings.TrimSpace(cfg.FetchCommand) == "" {
		return nil, NewError(CodeEmptyBody, "fetch command is empty (generic requires commandOverride)", nil)
	}
	// 事前チェック: 送信するコマンドに CR / LF / NUL などが混ざっていないか。
	// sendLine が末尾へ CR を付けて送るため、混入すると 1 本の取得コマンドに
	// 複数コマンドを潜り込ませられる（Issue #76）。呼び出し側（HTTP / CLI）でも
	// 検証しているが、送信経路の最終防衛線としてここでも fail closed にする。
	//
	// 【ログ出力】コマンド本文は Message に含めない。
	if err := commands.ValidateCommandLine(cfg.FetchCommand); err != nil {
		return nil, NewError(CodeCommandInvalid, "fetch command contains forbidden characters", err)
	}
	if err := commands.ValidateCommandLine(cfg.PagerSuppress); err != nil {
		return nil, NewError(CodeCommandInvalid, "pager suppress command contains forbidden characters", err)
	}
	// 対話ログインではユーザー名も 1 行として送るため、同じ経路でコマンドを
	// 潜り込ませられる。パスワードは正当な値を弾く恐れがあるため検証しない。
	if err := commands.ValidateCommandLine(cfg.Username); err != nil {
		return nil, NewError(CodeCommandInvalid, "username contains forbidden characters", err)
	}

	// 全体タイムアウト監視用に、ctx の残時間を各フェーズのタイムアウトと比較して
	// より短い方を採用するためのヘルパ。
	stageTimeout := func(d time.Duration) time.Duration {
		if deadline, ok := ctx.Deadline(); ok {
			remaining := time.Until(deadline)
			if remaining < d {
				return remaining
			}
		}
		return d
	}

	// 1. ログイン（対話ログインが必要なトランスポートのみ）。
	var prompt string
	var err error
	switch mode {
	case ModeInteractiveLogin:
		prompt, err = doLogin(ctx, s, cfg, stageTimeout(cfg.LoginTimeout))
	default:
		// SSH は認証がプロトコル層で完了しているため、プロンプト学習から始める。
		prompt, err = learnPrompt(ctx, s, stageTimeout(cfg.LoginTimeout))
	}
	if err != nil {
		return nil, err
	}

	// 2. enable 昇格（EnablePassword があれば）
	if cfg.EnablePassword != "" {
		if err := doEnable(ctx, s, cfg, stageTimeout(cfg.LoginTimeout)); err != nil {
			return nil, err
		}
		// enable 昇格後にプロンプトが変わる（> → #）可能性があるため再学習。
		prompt, err = learnPrompt(ctx, s, stageTimeout(cfg.LoginTimeout))
		if err != nil {
			return nil, err
		}
	}

	// 3. ページング抑制 + コンフィグ取得（CommandTimeout）
	rawBody, err := doFetch(ctx, s, cfg, prompt, stageTimeout(cfg.CommandTimeout))
	if err != nil {
		return nil, err
	}

	// 4. SJIS→UTF-8 変換
	body, srcEnc := encoding.Decode(rawBody)

	// 5. 本文検証
	cleaned := cleanBody(body, prompt, cfg.FetchCommand)
	if strings.TrimSpace(cleaned) == "" {
		return nil, NewError(CodeEmptyBody, "empty body after cleanup", nil)
	}

	// 6. ページャ残留検出
	if pagerMarkerRe.MatchString(cleaned) {
		return nil, NewError(CodePagerDetected, "pager marker (--More--) remains in body", nil)
	}

	// 7. コマンド拒否検出
	//
	// 機器が取得コマンドを受け付けなかった場合、本文はエラーメッセージだけに
	// なる。ここで弾かないと "% Invalid input detected at '^' marker." の 2 行が
	// 正常なコンフィグとして世代登録されてしまう。
	if msg, rejected := commandRejected(cleaned); rejected {
		return nil, NewError(CodeCommandRejected, msg, nil)
	}

	return &Result{
		Body:           cleaned,
		Prompt:         prompt,
		Command:        cfg.FetchCommand,
		SourceEncoding: srcEnc,
	}, nil
}

// doLogin はログインネゴシエーションを行い、ログイン後プロンプトを返す。
//
// 典型シーケンス:
//   - 機器 → "Login:" / "Username:" 等のプロンプト
//   - 本ヘルパー → ユーザー名 + CR
//   - 機器 → "Password:" プロンプト
//   - 本ヘルパー → パスワード + CR
//   - 機器 → ログイン成功ならプロンプト（> または #）、失敗なら再プロンプトや拒否メッセージ
//
// ログイン成功をプロンプト検出で判定する。Password プロンプトが再度現れたり
// "denied" / "failed" 等のメッセージが出たら auth_failed。
func doLogin(ctx context.Context, s Stream, cfg *Config, timeout time.Duration) (string, error) {
	// ログイン完了の判定は「Password を送った後、再度 Password/ログインプロンプトが
	// 現れずに > または # プロンプトが出る」こと。簡易のため、一定時間以内に
	// バッファを読み込みながら状態機械的に進める。

	// 最初に何が来るかは機器によって異なる。
	//   0: "Username:" 等 → ユーザー名 → パスワードの順に送る
	//   1: "Password:"     → ユーザー名は求められていない。パスワードのみ送る
	//   2: プロンプト      → 認証なしでログイン済み。何も送らない
	const (
		gotLoginPrompt = iota
		gotPasswordPrompt
		gotShellPrompt
	)
	idx, err := waitForAny(ctx, s, timeout, loginPromptRe, passwordRe, promptLineRe)
	if err != nil {
		return "", classifyLoginErr(ctx, err)
	}

	if idx == gotShellPrompt {
		// 認証なしでプロンプトが出た → ユーザー名/パスワード送信せず学習へ。
		p, lerr := learnPrompt(ctx, s, timeout)
		if lerr != nil {
			return "", classifyLoginErr(ctx, lerr)
		}
		return p, nil
	}

	if idx == gotLoginPrompt {
		// ユーザー名送信。
		if err := sendLine(s, cfg.Username); err != nil {
			return "", NewError(CodeConnectFailed, "failed to send username", err)
		}
		// Password プロンプトを待つ。ユーザー名だけでログインできる機器も
		// あるため、プロンプトが出たらそのまま成功として扱う。
		pidx, err := waitForAny(ctx, s, timeout, passwordRe, promptLineRe)
		if err != nil {
			return "", classifyLoginErr(ctx, err)
		}
		if pidx == 1 {
			p, lerr := learnPrompt(ctx, s, timeout)
			if lerr != nil {
				return "", classifyLoginErr(ctx, lerr)
			}
			return p, nil
		}
	}

	// パスワード送信（エコーを避けるため CR のみ）。
	if err := sendLine(s, cfg.Password); err != nil {
		return "", NewError(CodeConnectFailed, "failed to send password", err)
	}

	// ログイン成功を確認: プロンプトが出るか、再度認証プロンプトが出るか。
	// 再度 password/login プロンプトが出れば auth_failed。
	buf, err := readUntilMatch(ctx, s, timeout, passwordRe, loginPromptRe, promptLineRe)
	if err != nil {
		return "", classifyLoginErr(ctx, err)
	}
	// 認証失敗の兆候（再度の Password/Login プロンプト、denied/failed）を検査。
	if authFailedSignal(buf) {
		return "", NewError(CodeAuthFailed, "authentication rejected by device", nil)
	}

	// プロンプトを学習して返す。
	prompt, err := learnPromptFromBuffer(buf)
	if err != nil {
		// バッファから学習できなければ追加で改行を送って学習。
		prompt, err = learnPrompt(ctx, s, timeout)
		if err != nil {
			return "", err
		}
	}
	return prompt, nil
}

// doEnable は enable 昇格を行う。
func doEnable(ctx context.Context, s Stream, cfg *Config, timeout time.Duration) error {
	if err := sendLine(s, "enable"); err != nil {
		return NewError(CodeConnectFailed, "failed to send enable command", err)
	}
	// Password を求められるか、既に特権モードでプロンプトが返るかのどちらか。
	idx, err := waitForAny(ctx, s, timeout, passwordRe, promptLineRe)
	if err != nil {
		return classifyLoginErr(ctx, err)
	}
	if idx == 1 {
		// 既に特権モード（# プロンプト）。パスワード入力は不要。
		return nil
	}
	if err := sendLine(s, cfg.EnablePassword); err != nil {
		return NewError(CodeConnectFailed, "failed to send enable password", err)
	}
	// 昇格後のプロンプト（#）を待つ。
	if _, err := waitForAny(ctx, s, timeout, promptLineRe); err != nil {
		return classifyLoginErr(ctx, err)
	}
	return nil
}

// doFetch はページング抑制 + コンフィグ取得を実行し、生バイト列を返す。
func doFetch(ctx context.Context, s Stream, cfg *Config, prompt string, timeout time.Duration) ([]byte, error) {
	// ページング抑制（空でなければ）。
	if cfg.PagerSuppress != "" {
		if err := sendLine(s, cfg.PagerSuppress); err != nil {
			return nil, NewError(CodeConnectFailed, "failed to send pager suppress", err)
		}
		// 抑制コマンドの応答（プロンプトに戻る）を待つ。
		if _, err := waitForAny(ctx, s, timeout, promptLineRe); err != nil {
			return nil, classifyLoginErr(ctx, err)
		}
	}

	// コンフィグ取得コマンド送信。
	if err := sendLine(s, cfg.FetchCommand); err != nil {
		return nil, NewError(CodeConnectFailed, "failed to send fetch command", err)
	}

	// プロンプトが再び現れるまで読む（プロンプトが出たらコマンド完了）。
	// 大容量 running-config は時間がかかるため CommandTimeout を使う。
	raw, err := readUntilPrompt(ctx, s, timeout, prompt)
	if err != nil {
		return nil, err
	}
	return raw, nil
}

// ----- 読み書きヘルパ -----

// sendLine はテキスト + CR を送信する。Telnet の行終端は CR (\r) が標準で、
// SSH の PTY セッションでも CR が Enter として解釈される。
// LF は付けない（機器によっては二重改行になるため）。
func sendLine(s Stream, line string) error {
	_, err := io.WriteString(s, line+"\r")
	return err
}

// readLoop は Stream から読み続け、accumulator へ追記する。
// コンテキストのタイムアウトで中断する。
//
// 戻り値の bool は「タイムアウトで止まったか」。
func readLoop(ctx context.Context, s Stream, acc *bytes.Buffer, timeout time.Duration) (bool, error) {
	// 読み取りの都度タイムアウトを設定。
	_ = s.SetReadDeadline(time.Now().Add(timeout))
	buf := make([]byte, 4096)
	for {
		select {
		case <-ctx.Done():
			return true, ctx.Err()
		default:
		}
		nr, err := s.Read(buf)
		if nr > 0 {
			acc.Write(buf[:nr])
		}
		if err != nil {
			if isTimeout(err) {
				return true, nil // ループの呼び出し側でマッチ判定
			}
			return false, err
		}
		// タイムアウト延長（データが来ている間は延ばす）。
		_ = s.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	}
}

// waitForAny はいずれかの正規表現にマッチするまで読み続け、マッチした
// パターンの添字を返す。
//
// 「どれにマッチしたか」を呼び出し側へ返すのが要点。機器によってログイン
// シーケンスは異なり（Username を求める / いきなり Password を出す /
// 認証なしでプロンプトが出る）、どれが来たかで次に送るものが変わるため。
//
// res の順序がそのまま優先順位になる。同時に複数マッチしうる場合は、
// より具体的なパターンを先に並べること。
func waitForAny(ctx context.Context, s Stream, timeout time.Duration, res ...*regexp.Regexp) (int, error) {
	acc := new(bytes.Buffer)
	deadline := time.Now().Add(timeout)
	for {
		if time.Now().After(deadline) {
			if isContextTimeout(ctx, nil) {
				return -1, NewError(CodeTimeout, "login timeout (context deadline)", nil)
			}
			return -1, NewError(CodeAuthFailed, "login prompt timeout", nil)
		}
		timedOut, err := readLoop(ctx, s, acc, 300*time.Millisecond)
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return -1, NewError(CodeConnectFailed, "read error during wait", err)
		}
		text := acc.String()
		for i, re := range res {
			if re.MatchString(text) {
				return i, nil
			}
		}
		_ = timedOut // ループ継続
	}
}

// readUntilMatch はいずれかの正規表現にマッチするまで読み続け、バッファ全文を返す。
func readUntilMatch(ctx context.Context, s Stream, timeout time.Duration, res ...*regexp.Regexp) (string, error) {
	acc := new(bytes.Buffer)
	deadline := time.Now().Add(timeout)
	for {
		if time.Now().After(deadline) {
			return acc.String(), NewError(CodeTimeout, "read timeout", nil)
		}
		_, err := readLoop(ctx, s, acc, 300*time.Millisecond)
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return acc.String(), NewError(CodeConnectFailed, "read error", err)
		}
		text := acc.String()
		for _, re := range res {
			if re.MatchString(text) {
				return text, nil
			}
		}
	}
}

// readUntilPrompt は指定プロンプトで終わるまで読む（コンフィグ取得完了待ち）。
// プロンプト文字列が学習済みである前提。
//
// 【ページャ方針】--More-- / ---- More ---- を検知したら即座に pager_detected
// エラーを返す（スペース送信による回復は行わない）。
func readUntilPrompt(ctx context.Context, s Stream, timeout time.Duration, prompt string) ([]byte, error) {
	acc := new(bytes.Buffer)
	deadline := time.Now().Add(timeout)
	promptBytes := []byte(prompt)
	for {
		if time.Now().After(deadline) {
			if isContextTimeout(ctx, nil) {
				return acc.Bytes(), NewError(CodeTimeout, "command timeout (total deadline)", nil)
			}
			return acc.Bytes(), NewError(CodeTimeout, "command timeout", nil)
		}
		_, err := readLoop(ctx, s, acc, 500*time.Millisecond)
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return acc.Bytes(), NewError(CodeConnectFailed, "read error during fetch", err)
		}
		// プロンプトで終わっているか判定。
		if endsWithPrompt(acc.Bytes(), promptBytes) {
			return acc.Bytes(), nil
		}
		// ページャマーカを検知したら即座に失敗（回復は行わない）。
		if pagerMarkerRe.Match(acc.Bytes()) {
			return acc.Bytes(), NewError(CodePagerDetected, "pager marker (--More--) detected during fetch", nil)
		}
	}
}

// endsWithPrompt は data の末尾が prompt で終わるか（改行・空白を許容）。
func endsWithPrompt(data []byte, prompt []byte) bool {
	// 末尾の改行・空白を除去。
	tail := data
	for len(tail) > 0 && (tail[len(tail)-1] == '\n' || tail[len(tail)-1] == '\r' || tail[len(tail)-1] == ' ') {
		tail = tail[:len(tail)-1]
	}
	if len(tail) < len(prompt) {
		return false
	}
	return bytes.HasSuffix(tail, prompt)
}

// learnPrompt は改行を送り、応答末尾からプロンプトを学習する。
// banner MOTD が検出を阻害しないよう、最後の非空行を採用する。
func learnPrompt(ctx context.Context, s Stream, timeout time.Duration) (string, error) {
	// 改行送信でプロンプト再表示を促す。
	if err := sendLine(s, ""); err != nil {
		return "", NewError(CodeConnectFailed, "failed to send newline for prompt learning", err)
	}
	acc := new(bytes.Buffer)
	deadline := time.Now().Add(timeout)
	// プロンプトらしき行が末尾に出るまで読む。
	for {
		if time.Now().After(deadline) {
			return "", NewError(CodePromptNotFound, "prompt not detected after login", nil)
		}
		_, err := readLoop(ctx, s, acc, 400*time.Millisecond)
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return "", NewError(CodeConnectFailed, "read error during prompt learning", err)
		}
		if p, ok := extractPromptFromTail(acc.String()); ok {
			return p, nil
		}
	}
}

// learnPromptFromBuffer はバッファ末尾からプロンプトを抽出する。
func learnPromptFromBuffer(text string) (string, error) {
	if p, ok := extractPromptFromTail(text); ok {
		return p, nil
	}
	return "", NewError(CodePromptNotFound, "prompt not found in buffer", nil)
}

// extractPromptFromTail はテキスト末尾の最後の非空行からプロンプトを抽出する。
// ">" または "#" で終わる行のみをプロンプト候補とする。
func extractPromptFromTail(text string) (string, bool) {
	// CRLF/CR/LF で行分割し、末尾の空行を飛ばして最後の非空行を取り出す。
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")
	lines := strings.Split(normalized, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimRight(lines[i], " \t")
		if line == "" {
			continue
		}
		// ">" または "#" で終わる行をプロンプトとして採用。
		if strings.HasSuffix(line, ">") || strings.HasSuffix(line, "#") {
			return line, true
		}
		// 末尾がプロンプト記号でない行が来たら、プロンプトではない。
		return "", false
	}
	return "", false
}

// authFailedSignal は認証失敗の兆候を検出する。
// - 再度の Password/Login プロンプト
// - "denied" / "failed" / "incorrect" / "invalid" 等のメッセージ
// （プロンプト # / > が既に検出されている場合は呼び出し側で成功扱い）
func authFailedSignal(text string) bool {
	lower := strings.ToLower(text)
	// プロンプトが既にあれば成功側で弾かれているはずだが、安全のため。
	if promptLineRe.MatchString(text) && !passwordRe.MatchString(text) && !loginPromptRe.MatchString(text) {
		return false
	}
	keywords := []string{"denied", "failed", "incorrect", "invalid", "bad password", "login invalid", "% login"}
	for _, kw := range keywords {
		if strings.Contains(lower, kw) {
			return true
		}
	}
	// Password プロンプトが再度出ていれば失敗の可能性が高い。
	if passwordRe.MatchString(text) && !promptLineRe.MatchString(text) {
		return true
	}
	return false
}

// commandRejectionRes は「機器が取得コマンドを受け付けなかった」ことを示す応答。
//
// 各社の CLI が返す定型のエラー行のみを対象にする。コンフィグ本文中の文字列と
// 衝突しないよう、行頭の "%" や既知の定型文に限定してマッチさせる。
var commandRejectionRes = []*regexp.Regexp{
	// Cisco IOS / YAMAHA SWX 系: "% Invalid input detected at '^' marker."
	regexp.MustCompile(`(?im)^\s*%\s*invalid input detected`),
	// "% Unknown command" / "% Unrecognized command"
	regexp.MustCompile(`(?im)^\s*%\s*unknown command`),
	regexp.MustCompile(`(?im)^\s*%\s*unrecognized command`),
	// "% Incomplete command."
	regexp.MustCompile(`(?im)^\s*%\s*incomplete command`),
	// "% Ambiguous command: ..."
	regexp.MustCompile(`(?im)^\s*%\s*ambiguous command`),
	// 権限不足: "% Permission denied" / "Command authorization failed"
	regexp.MustCompile(`(?im)^\s*%\s*permission denied`),
	regexp.MustCompile(`(?im)^\s*command authorization failed`),
	// YAMAHA RT 系: "Error: unknown command" / "エラー: コマンドが違います"
	regexp.MustCompile(`(?im)^\s*error:\s*unknown command`),
	regexp.MustCompile(`(?im)^\s*エラー`),
	// 汎用シェル系（generic で誤ったコマンドを指定した場合）。
	// "-sh: show: command not found" のように接頭辞が付くため行頭には固定しない。
	regexp.MustCompile(`(?im)command not found`),
	regexp.MustCompile(`(?im)^\s*syntax error`),
}

// commandRejected は本文がコマンド拒否の応答かどうかを判定し、
// 該当した場合は原因となった行をメッセージとして返す。
//
// 拒否パターンを含んでいても本文が十分に長い場合は、コンフィグ本文の一部に
// たまたま一致しただけとみなして通す（誤検出でユーザーの取得を失敗させない）。
func commandRejected(body string) (string, bool) {
	trimmed := strings.TrimSpace(body)
	if trimmed == "" {
		return "", false
	}
	// 正常な running-config がこの行数に収まることはまずない。長い本文の中の
	// 一致は誤検出とみなす。
	const maxRejectionLines = 10
	if strings.Count(trimmed, "\n")+1 > maxRejectionLines {
		return "", false
	}
	for _, re := range commandRejectionRes {
		if loc := re.FindString(trimmed); loc != "" {
			return "device rejected the fetch command: " +
					strings.TrimSpace(firstMatchingLine(trimmed, re)),
				true
		}
	}
	return "", false
}

// firstMatchingLine は re に最初に一致した行を返す（メッセージ表示用）。
func firstMatchingLine(text string, re *regexp.Regexp) string {
	for _, line := range strings.Split(text, "\n") {
		if re.MatchString(line) {
			return line
		}
	}
	return text
}

// cleanBody はコマンドエコー・プロンプト行を除去し、純粋なコンフィグ本文を抽出する。
//
// 除去対象:
//   - コマンドエコー行（送信したコマンドそのもの）
//   - プロンプトで始まる行（"router#" 等）
//   - 末尾のプロンプト
//   - CR を LF に正規化
func cleanBody(text, prompt, command string) string {
	// CRLF/CR → LF へ正規化。
	normalized := strings.ReplaceAll(text, "\r\n", "\n")
	normalized = strings.ReplaceAll(normalized, "\r", "\n")

	lines := strings.Split(normalized, "\n")
	var out []string
	commandEcho := strings.TrimSpace(command)
	promptTrim := strings.TrimSpace(prompt)

	skipUntilCommand := true // コマンドエコー行までを読み飛ばす
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// コマンドエコー行が現れるまでスキップ（banner やログイン residue を除外）。
		// 実機のコマンドエコーは「プロンプト + コマンド」形式（例: "router#show running-config"）
		// で来るため、サフィックスマッチで検出する。コマンド単独の行も許容する。
		if skipUntilCommand {
			if commandEcho != "" && (trimmed == commandEcho || strings.HasSuffix(trimmed, commandEcho)) {
				skipUntilCommand = false
			}
			continue
		}

		// プロンプト単独行、またはプロンプトで始まる行を除去。
		if promptTrim != "" && (trimmed == promptTrim || strings.HasPrefix(trimmed, promptTrim)) {
			continue
		}
		// プロンプト記号のみの行も除去。
		if trimmed == "#" || trimmed == ">" {
			continue
		}
		out = append(out, line)
	}

	// 末尾の空行をトリム。
	cleaned := strings.TrimRight(strings.Join(out, "\n"), "\n")
	// UTF-8 の妥当性を確認（不正バイトがあれば置換）。
	if !utf8.ValidString(cleaned) {
		cleaned = sanitizeUTF8(cleaned)
	}
	return cleaned
}

// sanitizeUTF8 は不正 UTF-8 バイトを Replacement Character に置換する。
func sanitizeUTF8(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == utf8.RuneError {
			b.WriteRune(0xFFFD)
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// ----- エラー分類ヘルパ -----

// classifyLoginErr はログイン系の待機エラーを適切な ErrorCode に分類する。
func classifyLoginErr(ctx context.Context, err error) *Error {
	if err == nil {
		return nil
	}
	var se *Error
	if errors.As(err, &se) {
		return se
	}
	if isContextTimeout(ctx, err) {
		return NewError(CodeTimeout, "login timeout (total deadline)", err)
	}
	return NewError(CodeAuthFailed, "login negotiation failed", err)
}

// IsContextTimeout は ctx がタイムアウトしているか、err がタイムアウト系かを判定する。
// トランスポート（telnet/ssh）が接続失敗をタイムアウトと接続エラーに分類する際に使う。
func IsContextTimeout(ctx context.Context, err error) bool {
	return isContextTimeout(ctx, err)
}

// isContextTimeout は ctx がタイムアウトしているか、err がタイムアウト系かを判定。
func isContextTimeout(ctx context.Context, err error) bool {
	if ctx != nil && ctx.Err() != nil {
		return true
	}
	if err == nil {
		return false
	}
	return isTimeout(err) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled)
}

// isTimeout は net.Error の Timeout() を判定。
func isTimeout(err error) bool {
	var ne net.Error
	if errors.As(err, &ne) {
		return ne.Timeout()
	}
	return false
}
