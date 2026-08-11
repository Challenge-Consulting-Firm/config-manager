// Package telnet は NW 機器への Telnet 自動取得を実装する。
//
// 取得フロー:
//  1. TCP 接続（connectMs タイムアウト）
//  2. IAC ネゴシエーションを吸いながらログインプロンプトを待ち、認証情報を送信（loginMs）
//  3. enable 昇格（enablePassword があれば）
//  4. 改行を送ってプロンプト文字列を学習
//  5. ページング抑制コマンド + コンフィグ取得コマンドを送り、本文を回収（commandMs）
//  6. エコー・プロンプト行を除去し、ページャ残留を検出
//  7. SJIS→UTF-8 変換
//
// パスワード類は本パッケージ内でもログ出力・永続化しない。Fetch 完了後は
// 呼び出し側で *Config の参照を破棄し、GC に回収させることを前提とする。
//
// 【重要】Telnet は平文プロトコルである。本ヘルパーと機器間の通信は
// 暗号化されず、同一セグメント上のパケットキャプチャで認証情報が漏洩する
// 可能性がある。SPA 側の UI でも注意喚起するが、本パッケージ利用者も留意すること。
package telnet

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

	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/encoding"
)

// Telnet プロトコル定数（RFC 854）。
const (
	iac  = 255 // Interpret As Command
	dont = 254
	do   = 253
	wont = 252
	will = 251
	sb   = 250 // Subnegotiation Begin
	se   = 240 // Subnegotiation End
)

// Config は 1 回の取得のパラメータ。
//
// パスワード類（Password, EnablePassword）はログ・ファイルへ絶対に出さない。
// 本構造体の零値は使えない（NewConfig 経由で生成すること）。
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
	ElapsedMs      int64
}

// ErrorCode は packages/shared/src/helper.ts の HelperFetchErrorCode と一致させる。
type ErrorCode string

const (
	CodeConnectFailed  ErrorCode = "connect_failed"
	CodeAuthFailed     ErrorCode = "auth_failed"
	CodePromptNotFound ErrorCode = "prompt_not_found"
	CodeTimeout        ErrorCode = "timeout"
	CodePagerDetected  ErrorCode = "pager_detected"
	CodeEmptyBody      ErrorCode = "empty_body"
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
	// プロンプト候補: ">" または "#" で終わる行の末尾部分。
	// 例: "router>", "router#", "router(config)#", "Router>"
	promptRe = regexp.MustCompile(`([^\r\n>#]*[>#])\s*$`)
	// プロンプト全体行（学習時に最後の非空行を採用するため、行マッチを使う）。
	promptLineRe = regexp.MustCompile(`(?m)^[ \t]*[\w.\-()]+(?:[^\r\n]*?)[>#]\s*$`)
)

// pagerMarkerRe はページャの "--More--" 系マーカを検出する。
// Cisco: "--More--", YAMAHA: "---- More ----" など。
var pagerMarkerRe = regexp.MustCompile(`(?i)-+\s*more\s*-+`)

// Fetch は Telnet でコンフィグ本文を取得する。失敗時は *Error を返す。
//
// ctx には全体タイムアウト（TotalTimeout）を設定したコンテキストを渡すこと。
// 本関数内部で段階別タイムアウト（Connect/Login/Command）も適用する。
func Fetch(ctx context.Context, cfg *Config) (*Result, error) {
	// 0. 事前チェック: 取得コマンドが空なら実行前に弾く。
	if strings.TrimSpace(cfg.FetchCommand) == "" {
		return nil, NewError(CodeEmptyBody, "fetch command is empty (generic requires commandOverride)", nil)
	}

	start := time.Now()

	// 1. TCP 接続（ConnectTimeout）
	dialer := &net.Dialer{Timeout: cfg.ConnectTimeout}
	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		// ctx の Deadline 超過なら timeout、それ以外は connect_failed。
		if isContextTimeout(ctx, err) {
			return nil, NewError(CodeTimeout, "connect timeout", err)
		}
		return nil, NewError(CodeConnectFailed, "TCP connection failed", err)
	}
	// 接続が確立しても後続でエラーになれば確実に閉じる。
	defer func() { _ = conn.Close() }()

	// IAC パーサーは接続（Fetch 呼び出し）単位で生成する。
	// チャンク境界をまたぐ IAC シーケンスを正しく解釈するため、状態を保持する。
	parser := &iacParser{}

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

	// 2. ログイン（LoginTimeout）
	prompt, err := doLogin(ctx, conn, parser, cfg, stageTimeout(cfg.LoginTimeout))
	if err != nil {
		return nil, err
	}

	// 3. enable 昇格（EnablePassword があれば）
	if cfg.EnablePassword != "" {
		if err := doEnable(ctx, conn, parser, cfg, prompt, stageTimeout(cfg.LoginTimeout)); err != nil {
			return nil, err
		}
		// enable 昇格後にプロンプトが変わる（> → #）可能性があるため再学習。
		prompt, err = learnPrompt(ctx, conn, parser, stageTimeout(cfg.LoginTimeout))
		if err != nil {
			return nil, err
		}
	}

	// 4. ページング抑制 + コンフィグ取得（CommandTimeout）
	rawBody, err := doFetch(ctx, conn, parser, cfg, prompt, stageTimeout(cfg.CommandTimeout))
	if err != nil {
		return nil, err
	}

	// 5. SJIS→UTF-8 変換
	body, srcEnc := encoding.Decode(rawBody)

	// 6. 本文検証
	cleaned := cleanBody(body, prompt, cfg.FetchCommand)
	if strings.TrimSpace(cleaned) == "" {
		return nil, NewError(CodeEmptyBody, "empty body after cleanup", nil)
	}

	// 7. ページャ残留検出
	if pagerMarkerRe.MatchString(cleaned) {
		return nil, NewError(CodePagerDetected, "pager marker (--More--) remains in body", nil)
	}

	return &Result{
		Body:           cleaned,
		Prompt:         prompt,
		Command:        cfg.FetchCommand,
		SourceEncoding: srcEnc,
		ElapsedMs:      time.Since(start).Milliseconds(),
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
func doLogin(ctx context.Context, conn net.Conn, parser *iacParser, cfg *Config, timeout time.Duration) (string, error) {
	// ログイン完了の判定は「Password を送った後、再度 Password/ログインプロンプトが
	// 現れずに > または # プロンプトが出る」こと。簡易のため、一定時間以内に
	// バッファを読み込みながら状態機械的に進める。

	// まずログインプロンプトを待つ。
	if err := waitFor(ctx, conn, parser, timeout, loginPromptRe, passwordRe, promptLineRe); err != nil {
		// ログインプロンプト前にプロンプトが出た場合はログイン不要の可能性
		// （パスワード認証なし）。その場合はそのままプロンプトを学習する。
		if !errors.Is(err, errPromptEarly) {
			return "", classifyLoginErr(ctx, err)
		}
		// プロンプトが先に出た → ユーザー名/パスワード送信せず学習へ。
		p, lerr := learnPrompt(ctx, conn, parser, timeout)
		if lerr != nil {
			return "", classifyLoginErr(ctx, lerr)
		}
		return p, nil
	}

	// ユーザー名送信。
	if err := sendLine(conn, cfg.Username); err != nil {
		return "", NewError(CodeConnectFailed, "failed to send username", err)
	}

	// Password プロンプトを待つ。
	if err := waitFor(ctx, conn, parser, timeout, passwordRe); err != nil {
		return "", classifyLoginErr(ctx, err)
	}

	// パスワード送信（エコーを避けるため CR のみ）。
	if err := sendLine(conn, cfg.Password); err != nil {
		return "", NewError(CodeConnectFailed, "failed to send password", err)
	}

	// ログイン成功を確認: プロンプトが出るか、再度認証プロンプトが出るか。
	// 再度 password/login プロンプトが出れば auth_failed。
	buf, err := readUntilMatch(ctx, conn, parser, timeout, passwordRe, loginPromptRe, promptLineRe)
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
		prompt, err = learnPrompt(ctx, conn, parser, timeout)
		if err != nil {
			return "", err
		}
	}
	return prompt, nil
}

// doEnable は enable 昇格を行う。prompt は現在のプロンプト（待ち判定に使う）。
func doEnable(ctx context.Context, conn net.Conn, parser *iacParser, cfg *Config, prompt string, timeout time.Duration) error {
	if err := sendLine(conn, "enable"); err != nil {
		return NewError(CodeConnectFailed, "failed to send enable command", err)
	}
	if err := waitFor(ctx, conn, parser, timeout, passwordRe); err != nil {
		// 既に特権モード（# プロンプト）なら Password プロンプトは来ない。
		// その場合は成功とみなす。
		if !errors.Is(err, errPromptEarly) {
			return classifyLoginErr(ctx, err)
		}
		return nil
	}
	if err := sendLine(conn, cfg.EnablePassword); err != nil {
		return NewError(CodeConnectFailed, "failed to send enable password", err)
	}
	// 昇格後のプロンプト（#）を待つ。
	if err := waitFor(ctx, conn, parser, timeout, promptLineRe); err != nil {
		return classifyLoginErr(ctx, err)
	}
	return nil
}

// doFetch はページング抑制 + コンフィグ取得を実行し、生バイト列を返す。
func doFetch(ctx context.Context, conn net.Conn, parser *iacParser, cfg *Config, prompt string, timeout time.Duration) ([]byte, error) {
	// ページング抑制（空でなければ）。
	if cfg.PagerSuppress != "" {
		if err := sendLine(conn, cfg.PagerSuppress); err != nil {
			return nil, NewError(CodeConnectFailed, "failed to send pager suppress", err)
		}
		// 抑制コマンドの応答（プロンプトに戻る）を待つ。
		if err := waitFor(ctx, conn, parser, timeout, promptLineRe); err != nil {
			return nil, classifyLoginErr(ctx, err)
		}
	}

	// コンフィグ取得コマンド送信。
	if err := sendLine(conn, cfg.FetchCommand); err != nil {
		return nil, NewError(CodeConnectFailed, "failed to send fetch command", err)
	}

	// プロンプトが再び現れるまで読む（プロンプトが出たらコマンド完了）。
	// 大容量 running-config は時間がかかるため CommandTimeout を使う。
	raw, err := readUntilPrompt(ctx, conn, parser, timeout, prompt)
	if err != nil {
		return nil, err
	}
	return raw, nil
}

// ----- IAC / 読み書きヘルパ -----

// sendLine はテキスト + CR を送信する。Telnet の行終端は CR (\r) が標準。
// LF は付けない（機器によっては二重改行になるため）。
func sendLine(conn net.Conn, s string) error {
	_, err := io.WriteString(conn, s+"\r")
	return err
}

// iacParser は Telnet IAC ネゴシエーションのストリームパーサー。
// Telnet は TCP ストリーム上のプロトコルであり、IAC シーケンスが
// Read チャンク境界をまたぐ場合がある（例: IAC が前チャンク末尾、DO が次チャンク先頭）。
// 本構造体は未処理の末尾バイトを pending に退避し、次回呼び出し時に先頭へ結合して
// 解釈する。接続（Fetch 呼び出し）毎に新規生成すること。
type iacParser struct {
	// pending は前回チャンクの末尾にあった未確定バイト（不完全な IAC シーケンス）。
	// 次回 stripIAC 呼び出し時に新しい入力の先頭へ結合される。
	pending []byte
	// inSubneg は IAC SB 開始後・IAC SE 終了前の状態か。
	inSubneg bool
}

// stripIAC はバイト列から IAC 制御シーケンスを取り除き、プレーンテキスト部を返す。
// 同時に、ネゴシエーション要求（DO/WILL 等）には消極応答（WONT/DONT）を返す。
//
// チャンク境界をまたぐ IAC シーケンス（IAC 単独、IAC DO/WILL の途中、
// IAC SB ... IAC SE の途中）は pending へ退避し、次回呼び出しで解釈を完了する。
//
// 戻り値: (クリーンアップ済みバイト列, 送信すべき応答バイト列)
func (p *iacParser) stripIAC(raw []byte) ([]byte, []byte) {
	// 前回の未確定バイトを先頭へ結合。
	if len(p.pending) > 0 {
		raw = append(p.pending, raw...)
		p.pending = p.pending[:0] // 下限を戻して再利用（capacity は維持）
	}

	var out bytes.Buffer
	var resp bytes.Buffer
	n := len(raw)
	i := 0
	for i < n {
		// サブネゴシエーション中は IAC SE が来るまで全バイトをスキップ。
		// IAC がチャンク末尾で途切れる場合は pending へ退避し、次回 IAC SE を補完する。
		if p.inSubneg {
			if raw[i] == iac {
				if i+1 < n {
					if raw[i+1] == se {
						p.inSubneg = false
						i += 2
						continue
					}
					if raw[i+1] == iac {
						// SB 内のエスケープされた 0xFF。スキップ。
						i += 2
						continue
					}
				}
				// IAC の次が未確定（チャンク末尾）。次回へ退避して中断。
				p.pending = append(p.pending, raw[i:]...)
				i = n
				continue
			}
			i++
			continue
		}

		b := raw[i]
		if b != iac {
			out.WriteByte(b)
			i++
			continue
		}

		// IAC シーケンス処理。末尾で途切れている場合は pending へ退避。
		if i+1 >= n {
			// IAC 単独（不完全）。次回へ退避。
			p.pending = append(p.pending, raw[i])
			break
		}
		cmd := raw[i+1]
		switch cmd {
		case do:
			// DO X → WONT X（受け入れない）。3 バイト揃っている必要がある。
			if i+2 < n {
				resp.Write([]byte{iac, wont, raw[i+2]})
				i += 3
			} else {
				// IAC DO の途中。次回へ退避。
				p.pending = append(p.pending, raw[i], raw[i+1])
				i = n
			}
		case dont:
			// DONT X → 応答不要。3 バイト必要。
			if i+2 < n {
				i += 3
			} else {
				p.pending = append(p.pending, raw[i], raw[i+1])
				i = n
			}
		case will:
			// WILL X → DONT X。3 バイト必要。
			if i+2 < n {
				resp.Write([]byte{iac, dont, raw[i+2]})
				i += 3
			} else {
				p.pending = append(p.pending, raw[i], raw[i+1])
				i = n
			}
		case wont:
			// WONT X → 応答不要。3 バイト必要。
			if i+2 < n {
				i += 3
			} else {
				p.pending = append(p.pending, raw[i], raw[i+1])
				i = n
			}
		case sb:
			// Subnegotiation 開始: IAC SB ... IAC SE。
			p.inSubneg = true
			i += 2
		case iac:
			// IAC IAC = エスケープされた 0xFF
			out.WriteByte(0xFF)
			i += 2
		default:
			// その他の 2 バイトコマンド（AYT, NOP 等）はスキップ。
			i += 2
		}
	}
	return out.Bytes(), resp.Bytes()
}

// readLoop は conn から読み続け、IAC を除去しながら accumulator へ追記する。
// 応答すべき IAC ネゴシエーションがあれば即座に送信する。
// コンテキストのタイムアウトで中断する。
//
// parser は接続単位の IAC パーサー。チャンク境界をまたぐシーケンス状態を保持する。
//
// 戻り値の bool は「タイムアウトで止まったか」。
func readLoop(ctx context.Context, conn net.Conn, parser *iacParser, acc *bytes.Buffer, timeout time.Duration) (bool, error) {
	// 読み取りの都度タイムアウトを設定。
	_ = conn.SetReadDeadline(time.Now().Add(timeout))
	buf := make([]byte, 4096)
	for {
		select {
		case <-ctx.Done():
			return true, ctx.Err()
		default:
		}
		nr, err := conn.Read(buf)
		if nr > 0 {
			clean, resp := parser.stripIAC(buf[:nr])
			if len(clean) > 0 {
				acc.Write(clean)
			}
			if len(resp) > 0 {
				_, _ = conn.Write(resp)
			}
		}
		if err != nil {
			if isTimeout(err) {
				return true, nil // ループの呼び出し側でマッチ判定
			}
			return false, err
		}
		// タイムアウト延長（データが来ている間は延ばす）。
		_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	}
}

// errPromptEarly は「待機中にプロンプトが先に現れた」ことを示すセンチネル。
var errPromptEarly = errors.New("prompt appeared before expected login prompt")

// waitFor はいずれかの正規表現にマッチするまで読み続ける。
// promptLineRe が含まれていて、かつそれが先にマッチした場合は errPromptEarly を返す。
func waitFor(ctx context.Context, conn net.Conn, parser *iacParser, timeout time.Duration, res ...*regexp.Regexp) error {
	acc := new(bytes.Buffer)
	deadline := time.Now().Add(timeout)
	for {
		if time.Now().After(deadline) {
			if isContextTimeout(ctx, nil) {
				return NewError(CodeTimeout, "login timeout (context deadline)", nil)
			}
			return NewError(CodeAuthFailed, "login prompt timeout", nil)
		}
		timedOut, err := readLoop(ctx, conn, parser, acc, 300*time.Millisecond)
		if err != nil && !errors.Is(err, context.DeadlineExceeded) {
			return NewError(CodeConnectFailed, "read error during wait", err)
		}
		text := acc.String()
		// プロンプト行が先に来たか判定（promptLineRe が指定されている場合）。
		hasPromptLine := false
		for _, re := range res {
			if re == promptLineRe {
				hasPromptLine = true
				break
			}
		}
		for _, re := range res {
			if re.MatchString(text) {
				if hasPromptLine && re == promptLineRe {
					// ログインプロンプト待ちの途中でプロンプトが出た。
					return errPromptEarly
				}
				return nil
			}
		}
		_ = timedOut // ループ継続
	}
}

// readUntilMatch はいずれかの正規表現にマッチするまで読み続け、バッファ全文を返す。
func readUntilMatch(ctx context.Context, conn net.Conn, parser *iacParser, timeout time.Duration, res ...*regexp.Regexp) (string, error) {
	acc := new(bytes.Buffer)
	deadline := time.Now().Add(timeout)
	for {
		if time.Now().After(deadline) {
			return acc.String(), NewError(CodeTimeout, "read timeout", nil)
		}
		_, err := readLoop(ctx, conn, parser, acc, 300*time.Millisecond)
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
// エラーを返す（フェーズ 1 ではスペース送信による回復を行わない）。
func readUntilPrompt(ctx context.Context, conn net.Conn, parser *iacParser, timeout time.Duration, prompt string) ([]byte, error) {
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
		_, err := readLoop(ctx, conn, parser, acc, 500*time.Millisecond)
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
func learnPrompt(ctx context.Context, conn net.Conn, parser *iacParser, timeout time.Duration) (string, error) {
	// 改行送信でプロンプト再表示を促す。
	if err := sendLine(conn, ""); err != nil {
		return "", NewError(CodeConnectFailed, "failed to send newline for prompt learning", err)
	}
	acc := new(bytes.Buffer)
	deadline := time.Now().Add(timeout)
	// プロンプトらしき行が末尾に出るまで読む。
	for {
		if time.Now().After(deadline) {
			return "", NewError(CodePromptNotFound, "prompt not detected after login", nil)
		}
		_, err := readLoop(ctx, conn, parser, acc, 400*time.Millisecond)
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

// cleanBody はコマンドエコー・プロンプト行を除去し、純粋なコンフィグ本文を抽出する。
//
// 除去対象:
//   - コマンドエコー行（送信したコマンドそのもの）
//   - プロンプトで始まる行（"router#" 等）
//   - 末尾のプロンプト
//   - Telnet の CR を LF に正規化
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
	if errors.Is(err, errPromptEarly) {
		// プロンプトが先に出た → ログイン不要 → 呼び出し側で処理されるはず。
		return NewError(CodePromptNotFound, "unexpected prompt before login", err)
	}
	var te *Error
	if errors.As(err, &te) {
		return te
	}
	if isContextTimeout(ctx, err) {
		return NewError(CodeTimeout, "login timeout (total deadline)", err)
	}
	return NewError(CodeAuthFailed, "login negotiation failed", err)
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
