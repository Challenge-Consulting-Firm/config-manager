// 機器認証情報の引き換え（Issue #53）。
//
// SPA は認証情報の平文を持たない。持っているのは BFF が発行した一回限りの
// 不透明トークンだけで、ヘルパーがそのトークンを BFF へ送って初めて
// ユーザー名とパスワードを受け取る。これにより平文がブラウザの JS ヒープ・
// DevTools・拡張機能に載らない。
//
// 【引き換え先の決め方】
// 引き換え先 URL はリクエストボディからは受け取らない。withCORS が検証済みの
// Origin ヘッダにパスを連結して組み立てる。SPA が任意の URL を指定できると、
// 許可 Origin から呼ばれた要求でトークンを外部へ送り出せてしまうため。
package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// credentialRedeemPath は BFF 側の引き換えエンドポイント。
// packages/shared/src/helper.ts の HELPER_CREDENTIAL_REDEEM_PATH と一致。
const credentialRedeemPath = "/helper/credentials/redeem"

// credentialRedeemTimeout は引き換え要求のタイムアウト。
// 機器への接続前に完了する必要があるので短めにする。
const credentialRedeemTimeout = 15 * time.Second

// maxRedeemResponseBytes は引き換え応答の読み取り上限。
const maxRedeemResponseBytes = 64 << 10 // 64 KiB

// errRedeemFailed はトークン引き換えの失敗。呼び出し側で
// credential_redeem_failed へ変換する。
var errRedeemFailed = errors.New("credential redeem failed")

// redeemedCredential は引き換えで得た平文。
//
// 【機密】この構造体の内容はログ・エラーメッセージへ絶対に出さない。
type redeemedCredential struct {
	Username       string `json:"username"`
	Password       string `json:"password"`
	EnablePassword string `json:"enablePassword"`
}

// redeemCredential は検証済み Origin の BFF へトークンを送り、
// ユーザー名とパスワードを受け取る。
//
// origin は withCORS で allowlist 照合済みの値であること。呼び出し側が
// 未検証の Origin を渡さないよう、この関数は http.Request を受け取らない。
func redeemCredential(ctx context.Context, origin, token string) (*redeemedCredential, error) {
	endpoint, err := redeemEndpoint(origin)
	if err != nil {
		return nil, err
	}

	// 【機密】トークンはボディにのみ載せる。URL に入れるとプロキシのアクセス
	// ログや Referer に残りうる。
	body, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		return nil, fmt.Errorf("%w: marshal request", errRedeemFailed)
	}

	reqCtx, cancel := context.WithTimeout(ctx, credentialRedeemTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("%w: build request", errRedeemFailed)
	}
	req.Header.Set("Content-Type", "application/json")

	// 既定の Transport を使う（TLS 証明書検証は有効のまま）。
	client := &http.Client{Timeout: credentialRedeemTimeout}
	res, err := client.Do(req)
	if err != nil {
		// 【機密】err にはトークンは含まれないが、URL は含まれうる。
		// エンドポイントは秘密ではないのでそのまま包んで返す。
		return nil, fmt.Errorf("%w: %v", errRedeemFailed, err)
	}
	defer func() { _ = res.Body.Close() }()

	raw, err := io.ReadAll(io.LimitReader(res.Body, maxRedeemResponseBytes))
	if err != nil {
		return nil, fmt.Errorf("%w: read response", errRedeemFailed)
	}
	// 【機密】応答本文にはパスワードが含まれる。処理後にゼロ化する。
	defer zeroBytes(raw)

	if res.StatusCode != http.StatusOK {
		// 本文はエラーメッセージのみのはずだが、念のため中身は返さない。
		return nil, fmt.Errorf("%w: server returned %d", errRedeemFailed, res.StatusCode)
	}

	var out redeemedCredential
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("%w: invalid response", errRedeemFailed)
	}
	if out.Password == "" {
		return nil, fmt.Errorf("%w: empty password", errRedeemFailed)
	}
	return &out, nil
}

// redeemEndpoint は Origin から引き換え URL を組み立てる。
//
// http は loopback（開発時の localhost / 127.0.0.1）に限って許す。それ以外で
// 平文 HTTP を許すと、トークンとパスワードが平文で流れることになる。
func redeemEndpoint(origin string) (string, error) {
	o := strings.TrimSpace(origin)
	if o == "" {
		return "", fmt.Errorf("%w: missing origin", errRedeemFailed)
	}
	u, err := url.Parse(o)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("%w: unparseable origin", errRedeemFailed)
	}
	if u.Scheme != "https" && !isLoopbackHost(u.Hostname()) {
		return "", fmt.Errorf("%w: refusing plaintext http to %s", errRedeemFailed, u.Host)
	}
	return strings.TrimRight(o, "/") + credentialRedeemPath, nil
}

// isLoopbackHost は開発用のループバックホスト名かを返す。
func isLoopbackHost(host string) bool {
	switch strings.ToLower(host) {
	case "localhost", "127.0.0.1", "::1":
		return true
	}
	return false
}
