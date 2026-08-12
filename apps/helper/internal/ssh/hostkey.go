package ssh

import (
	"errors"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// ホスト鍵の検証方針は TOFU（Trust On First Use）である。
//
//   - 初回接続時のホスト鍵は known_hosts へ記録して受け入れる
//   - 2 回目以降は記録した鍵と一致することを検証し、不一致なら
//     host_key_mismatch で失敗させる（中間者攻撃・機器交換の検知）
//   - 鍵が失効（@revoked）として記録されている場合は常に拒否する
//
// 機器交換や初期化で鍵が正当に変わった場合は、known_hosts の該当行を削除して
// もう一度取得すれば再記録される（運用手順は apps/helper/README.md に記載）。

// knownHostsEnv は known_hosts の保存先を上書きする環境変数。
// 運用上、共有の known_hosts を使いたい場合や検証時に使う。
const knownHostsEnv = "HELPER_KNOWN_HOSTS"

// helperConfigDirName は既定の保存先ディレクトリ名。
const helperConfigDirName = "config-manager-helper"

// knownHostsMu は known_hosts への追記を直列化する。
// HTTP サーバは取得要求を並行に受け付けられるため、追記の競合を防ぐ。
var knownHostsMu sync.Mutex

// hostKeyError はホスト鍵検証の失敗。ハンドシェイクエラーのラップ形式に
// 依存せず原因を判定できるよう、専用型で持つ。
type hostKeyError struct {
	Message string
	Cause   error
}

func (e *hostKeyError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %v", e.Message, e.Cause)
	}
	return e.Message
}

func (e *hostKeyError) Unwrap() error { return e.Cause }

// DefaultKnownHostsPath は known_hosts の既定パスを返す。
// 環境変数 HELPER_KNOWN_HOSTS が設定されていればそれを優先する。
func DefaultKnownHostsPath() (string, error) {
	if p := os.Getenv(knownHostsEnv); p != "" {
		return p, nil
	}
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, helperConfigDirName, "known_hosts"), nil
	}
	// UserConfigDir が使えない環境（環境変数が空の場合など）はホームディレクトリへ。
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine known_hosts location: %w", err)
	}
	return filepath.Join(home, "."+helperConfigDirName, "known_hosts"), nil
}

// hostKeyVerifier は TOFU 方式のホスト鍵検証を行う。
type hostKeyVerifier struct {
	path string
	// mismatch は検証で不一致（または失効）を検出した際のエラー。
	mismatch *hostKeyError
}

// newHostKeyVerifier は known_hosts を用意して検証器を返す。
// path が空文字列なら DefaultKnownHostsPath を使う。
func newHostKeyVerifier(path string) (*hostKeyVerifier, error) {
	if path == "" {
		p, err := DefaultKnownHostsPath()
		if err != nil {
			return nil, err
		}
		path = p
	}
	// ディレクトリとファイルを用意する（他ユーザーから読めないパーミッション）。
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("cannot create known_hosts directory: %w", err)
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, fmt.Errorf("cannot open known_hosts: %w", err)
	}
	_ = f.Close()

	return &hostKeyVerifier{path: path}, nil
}

// check は ssh.HostKeyCallback として使う検証関数。
func (v *hostKeyVerifier) check(hostname string, remote net.Addr, key ssh.PublicKey) error {
	knownHostsMu.Lock()
	defer knownHostsMu.Unlock()

	cb, err := knownhosts.New(v.path)
	if err != nil {
		return &hostKeyError{Message: "cannot read known_hosts", Cause: err}
	}

	err = cb(hostname, remote, key)
	if err == nil {
		return nil
	}

	// 失効として記録された鍵は常に拒否する。
	var revoked *knownhosts.RevokedError
	if errors.As(err, &revoked) {
		v.mismatch = &hostKeyError{
			Message: fmt.Sprintf("host key for %s is marked revoked in %s", hostname, v.path),
			Cause:   err,
		}
		return v.mismatch
	}

	var keyErr *knownhosts.KeyError
	if errors.As(err, &keyErr) && len(keyErr.Want) == 0 {
		// 未知のホスト（記録が無い）→ TOFU で受け入れ、鍵を追記する。
		if aerr := appendKnownHost(v.path, hostname, key); aerr != nil {
			return &hostKeyError{Message: "cannot record host key", Cause: aerr}
		}
		// 【ログ出力】鍵の指紋は機密ではないため、後から突き合わせられるよう残す。
		log.Printf("[ssh] recorded new host key: host=%s type=%s fingerprint=%s file=%s",
			hostname, key.Type(), ssh.FingerprintSHA256(key), v.path)
		return nil
	}

	// 記録済みの鍵と不一致 → 中間者攻撃または機器交換の可能性。
	v.mismatch = &hostKeyError{
		Message: fmt.Sprintf(
			"host key mismatch for %s (fingerprint=%s). If the device was replaced or reinitialized, remove its line from %s and retry",
			hostname, ssh.FingerprintSHA256(key), v.path),
		Cause: err,
	}
	return v.mismatch
}

// appendKnownHost は known_hosts へ 1 行追記する。
// 呼び出し元で knownHostsMu を保持していること。
func appendKnownHost(path, hostname string, key ssh.PublicKey) error {
	// Normalize は "host:22" → "host"、非既定ポートは "[host]:2222" に整える。
	addr := knownhosts.Normalize(hostname)
	line := knownhosts.Line([]string{addr}, key) + "\n"

	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	if _, err := f.WriteString(line); err != nil {
		return err
	}
	return f.Sync()
}
