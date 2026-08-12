// Package ssh は NW 機器への SSH 接続を提供する。
//
// 本パッケージの責務は「SSH ハンドシェイクと認証」「PTY 付きシェルの起動」
// 「期限付き読み取りができるストリームへの変換」であり、ログイン後の
// コンフィグ取得手順は internal/session が担う（Telnet と共通）。
//
// 設計上の要点:
//   - NW 機器は exec チャネル非対応が多いため、PTY を要求して対話シェルを開く
//   - 旧世代機（Cisco IOS 12/15 系、古い YAMAHA RT 等）は SHA-1 系 KEX や CBC 暗号
//     しか実装していないため、x/crypto/ssh が既定で除外する方式を明示的に許可する
//   - ホスト鍵は TOFU（初回受入・以降固定）で検証する。詳細は hostkey.go を参照
//
// パスワード類はログ出力・永続化しない。
package ssh

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/session"
)

// DefaultPort は SSH の既定ポート。
const DefaultPort = 22

// Options は SSH 固有の任意設定。nil を渡した場合は既定値が使われる。
type Options struct {
	// KnownHostsPath はホスト鍵を記録するファイル。空文字列なら既定パス
	// （DefaultKnownHostsPath）を使う。
	KnownHostsPath string
}

// PTY のサイズ。ページング抑制コマンドが効かない機種でも
// 極端な分割が起きないよう、行数・桁数を大きめに要求する。
const (
	ptyWidth  = 512
	ptyHeight = 1000
)

// Fetch は SSH でコンフィグ本文を取得する。失敗時は *session.Error を返す。
//
// ctx には全体タイムアウト（TotalTimeout）を設定したコンテキストを渡すこと。
func Fetch(ctx context.Context, cfg *session.Config, opts *Options) (*session.Result, error) {
	start := time.Now()

	knownHostsPath := ""
	if opts != nil {
		knownHostsPath = opts.KnownHostsPath
	}
	verifier, err := newHostKeyVerifier(knownHostsPath)
	if err != nil {
		return nil, session.NewError(session.CodeConnectFailed, "failed to prepare known_hosts", err)
	}

	// TCP 接続（ConnectTimeout）。ctx を尊重するため net.Dialer 経由で張り、
	// その上で SSH ハンドシェイクを行う。
	dialer := &net.Dialer{Timeout: cfg.ConnectTimeout}
	addr := net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port))
	tcpConn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		if session.IsContextTimeout(ctx, err) {
			return nil, session.NewError(session.CodeTimeout, "connect timeout", err)
		}
		return nil, session.NewError(session.CodeConnectFailed, "TCP connection failed", err)
	}
	// ハンドシェイク中のハングを避けるため、接続確立までの猶予を設定する
	// （ハンドシェイク完了後に解除する）。
	_ = tcpConn.SetDeadline(time.Now().Add(cfg.ConnectTimeout + cfg.LoginTimeout))

	clientCfg := &ssh.ClientConfig{
		User: cfg.Username,
		Auth: []ssh.AuthMethod{
			ssh.Password(cfg.Password),
			// 機器によっては password 認証が無効で keyboard-interactive のみ有効な
			// ことがある。質問文は機器依存のため、すべてパスワードで応答する。
			ssh.KeyboardInteractive(func(_, _ string, questions []string, _ []bool) ([]string, error) {
				answers := make([]string, len(questions))
				for i := range questions {
					answers[i] = cfg.Password
				}
				return answers, nil
			}),
		},
		HostKeyCallback:   verifier.check,
		HostKeyAlgorithms: hostKeyAlgorithms(),
		Config: ssh.Config{
			KeyExchanges: keyExchanges(),
			Ciphers:      ciphers(),
			MACs:         macs(),
		},
		Timeout: cfg.ConnectTimeout,
	}

	sshConn, chans, reqs, err := ssh.NewClientConn(tcpConn, addr, clientCfg)
	if err != nil {
		_ = tcpConn.Close()
		return nil, classifyHandshakeErr(ctx, err, verifier)
	}
	client := ssh.NewClient(sshConn, chans, reqs)
	defer func() { _ = client.Close() }()
	// ハンドシェイクが済んだので TCP レベルの期限を解除し、以降は
	// session 側の段階別タイムアウト（stream の読み取り期限）に委ねる。
	_ = tcpConn.SetDeadline(time.Time{})

	sess, err := client.NewSession()
	if err != nil {
		return nil, session.NewError(session.CodeConnectFailed, "failed to open SSH session", err)
	}
	defer func() { _ = sess.Close() }()

	// 対話シェル用の PTY を要求する。ECHO を有効にしておくことで、機器の
	// コマンドエコーを前提とした session 側の本文整形（cleanBody）がそのまま働く。
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 115200,
		ssh.TTY_OP_OSPEED: 115200,
	}
	if err := sess.RequestPty("vt100", ptyHeight, ptyWidth, modes); err != nil {
		return nil, session.NewError(session.CodeConnectFailed, "PTY request rejected", err)
	}

	stdin, err := sess.StdinPipe()
	if err != nil {
		return nil, session.NewError(session.CodeConnectFailed, "failed to open stdin", err)
	}
	stdout, err := sess.StdoutPipe()
	if err != nil {
		return nil, session.NewError(session.CodeConnectFailed, "failed to open stdout", err)
	}
	// PTY 付きシェルでは機器の出力はすべて stdout に流れるため、stderr は
	// x/crypto/ssh の既定（破棄）に任せる。

	if err := sess.Shell(); err != nil {
		return nil, session.NewError(session.CodeConnectFailed, "failed to start remote shell", err)
	}

	stream := newStream(stdin, stdout)
	defer stream.Close()

	// SSH は認証がプロトコル層で完了しているため ModePreAuthenticated。
	result, err := session.Run(ctx, stream, cfg, session.ModePreAuthenticated)
	if err != nil {
		return nil, err
	}
	result.ElapsedMs = time.Since(start).Milliseconds()
	return result, nil
}

// classifyHandshakeErr は SSH ハンドシェイク失敗を ErrorCode に分類する。
//
// ホスト鍵の不一致は検証器が記録した結果で判定する（ハンドシェイクエラーの
// ラップ形式に依存しないため）。それ以外は x/crypto/ssh がメッセージ文字列で
// 返すので、代表的なパターンで判別する。
func classifyHandshakeErr(ctx context.Context, err error, verifier *hostKeyVerifier) *session.Error {
	if verifier != nil && verifier.mismatch != nil {
		return session.NewError(session.CodeHostKeyMismatch, verifier.mismatch.Message, err)
	}
	var hkErr *hostKeyError
	if errors.As(err, &hkErr) {
		return session.NewError(session.CodeHostKeyMismatch, hkErr.Message, err)
	}
	if session.IsContextTimeout(ctx, err) {
		return session.NewError(session.CodeTimeout, "SSH handshake timeout", err)
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "unable to authenticate"),
		strings.Contains(msg, "no supported methods remain"),
		strings.Contains(msg, "permission denied"):
		return session.NewError(session.CodeAuthFailed, "SSH authentication failed", err)
	case strings.Contains(msg, "no common algorithm"),
		strings.Contains(msg, "no common algorithms"),
		strings.Contains(msg, "unsupported key exchange"),
		strings.Contains(msg, "ssh: overflow reading version string"),
		strings.Contains(msg, "protocol version"):
		return session.NewError(session.CodeHandshakeFailed, "SSH algorithm negotiation failed", err)
	default:
		return session.NewError(session.CodeConnectFailed, "SSH handshake failed", err)
	}
}

// ----- 暗号方式の選択 -----
//
// 旧世代の NW 機器は SHA-1 系 KEX・CBC 暗号しか実装していないことが多い。
// x/crypto/ssh の既定はこれらを除外するため、明示的に許可リストへ加える。
// 追加分は必ず末尾（低優先）に置くので、機器が新しい方式に対応していれば
// ネゴシエーションで自動的にそちらが選ばれる。Telnet（平文）の代替として
// 使えることを優先した判断である。

// レガシー方式の許可リスト。x/crypto/ssh が実装していない名前を渡すと
// ハンドシェイク自体が失敗するため、実装済みのものだけに絞って使う
// （filterImplemented）。
var (
	legacyKeyExchanges = []string{
		"diffie-hellman-group14-sha1",
		"diffie-hellman-group1-sha1",
		"diffie-hellman-group-exchange-sha1",
	}
	legacyCiphers = []string{
		"aes256-cbc",
		"aes192-cbc",
		"aes128-cbc",
		"3des-cbc",
	}
	legacyMACs = []string{
		"hmac-sha1",
		"hmac-sha1-96",
	}
	legacyHostKeys = []string{
		"ssh-rsa",
		"ssh-dss",
	}
)

func keyExchanges() []string {
	return mergeAlgorithms(
		ssh.SupportedAlgorithms().KeyExchanges,
		legacyKeyExchanges,
		ssh.InsecureAlgorithms().KeyExchanges,
	)
}

func ciphers() []string {
	return mergeAlgorithms(
		ssh.SupportedAlgorithms().Ciphers,
		legacyCiphers,
		ssh.InsecureAlgorithms().Ciphers,
	)
}

func macs() []string {
	return mergeAlgorithms(
		ssh.SupportedAlgorithms().MACs,
		legacyMACs,
		ssh.InsecureAlgorithms().MACs,
	)
}

func hostKeyAlgorithms() []string {
	return mergeAlgorithms(
		ssh.SupportedAlgorithms().HostKeys,
		legacyHostKeys,
		ssh.InsecureAlgorithms().HostKeys,
	)
}

// mergeAlgorithms は安全側リスト（secure）の後ろにレガシー方式（legacy）を足した
// 優先順リストを返す。
//
//   - legacy のうち x/crypto/ssh が実装していない名前は落とす。未実装の名前を
//     ClientConfig へ渡すとハンドシェイク自体がエラーになるため
//     （例: aes192-cbc / aes256-cbc は未実装で aes128-cbc のみ実装されている）。
//   - secure に既に含まれる名前は重複させない（例: hmac-sha1 は既定に含まれる）。
func mergeAlgorithms(secure, legacy, insecureImplemented []string) []string {
	seen := make(map[string]struct{}, len(secure))
	for _, a := range secure {
		seen[a] = struct{}{}
	}
	implemented := make(map[string]struct{}, len(secure)+len(insecureImplemented))
	for _, a := range secure {
		implemented[a] = struct{}{}
	}
	for _, a := range insecureImplemented {
		implemented[a] = struct{}{}
	}

	out := make([]string, 0, len(secure)+len(legacy))
	out = append(out, secure...)
	for _, a := range legacy {
		if _, ok := implemented[a]; !ok {
			continue
		}
		if _, dup := seen[a]; dup {
			continue
		}
		seen[a] = struct{}{}
		out = append(out, a)
	}
	return out
}
