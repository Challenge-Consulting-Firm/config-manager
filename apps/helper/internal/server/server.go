// Package server は 127.0.0.1 にバインドする HTTP サーバを実装する。
//
// 役割:
//   - SPA（HTTPS パブリックオリジン）からのクロスオリジン要求を受け付ける
//   - Private Network Access のプリフライトに応答する
//   - Origin allowlist で不正オリジンを拒否する
//   - /api/status, /api/fetch, /api/shutdown を提供する
//
// バインドは 127.0.0.1 のみ（0.0.0.0 には絶対にバインドしない）。
// パスワード類は Telnet パッケージ経由でメモリ上のみ扱い、ログ/ファイルへ出さない。
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/commands"
	"github.com/Challenge-Consulting-Firm/config-manager/apps/helper/internal/telnet"
)

// Version はヘルパーのバージョン。ビルド時に ldflags で注入可能。
// 未注入時は "0.0.0-dev"。build-helper.sh で -X server.Version=$VERSION で上書きする。
var Version = "0.0.0-dev"

// BuildTimeAllowedOrigin はビルド時に ldflags で注入する本番 SPA の origin。
// 配布バイナリ起動時にユーザー PC で環境変数が設定されている保証がないため、
// 本番 origin はバイナリへ埋め込む。未注入時は空（開発用 localhost のみ許可）。
var BuildTimeAllowedOrigin = ""

// ポート候補。packages/shared/src/helper.ts の HELPER_PORT_CANDIDATES と一致。
var portCandidates = []int{53712, 53713, 53714, 53715, 53716}

// 既定タイムアウト（ミリ秒）。HELPER_DEFAULT_TIMEOUTS と一致。
const (
	defaultConnectMs = 10_000
	defaultLoginMs   = 15_000
	defaultCommandMs = 120_000
	defaultTotalMs   = 180_000
)

// タイムアウトの上下限（ミリ秒）。外部から指定された値を安全な範囲へクランプする。
// 負値・0 は既定値、上限超えは上限値にクランプされる。
const (
	minConnectMs, maxConnectMs = 1_000, 15_000
	minLoginMs, maxLoginMs     = 1_000, 30_000
	minCommandMs, maxCommandMs = 1_000, 180_000
	minTotalMs, maxTotalMs     = 1_000, 180_000
)

// maxBodyBytes はリクエストボディの上限。コンフィグ取得要求自体は小さいが、
// 不正な巨大ペイロードでメモリを圧迫されないよう制限する。
const maxBodyBytes = 1 << 20 // 1 MiB

// fetchRequest は POST /api/fetch の要求本体。
// packages/shared/src/helper.ts の HelperFetchRequest と一致。
type fetchRequest struct {
	Host            string             `json:"host"`
	Port            int                `json:"port"`
	Protocol        string             `json:"protocol"`
	Username        string             `json:"username"`
	Password        string             `json:"password"` // 機密: ログ/ファイル出力禁止
	EnablePassword  string             `json:"enablePassword"`
	OSHint          string             `json:"osHint"`
	CommandOverride *string            `json:"commandOverride"` // null 許容
	Timeouts        *fetchTimeoutsJSON `json:"timeouts,omitempty"`
}

type fetchTimeoutsJSON struct {
	ConnectMs *int `json:"connectMs,omitempty"`
	LoginMs   *int `json:"loginMs,omitempty"`
	CommandMs *int `json:"commandMs,omitempty"`
	TotalMs   *int `json:"totalMs,omitempty"`
}

// fetchOkResponse は成功レスポンス。HelperFetchOkResponse と一致。
type fetchOkResponse struct {
	OK   bool            `json:"ok"`
	Body string          `json:"body"`
	Meta fetchOkMetaJSON `json:"meta"`
}

type fetchOkMetaJSON struct {
	ElapsedMs      int64  `json:"elapsedMs"`
	Prompt         string `json:"prompt"`
	Command        string `json:"command"`
	SourceEncoding string `json:"sourceEncoding"`
}

// fetchErrorResponse は失敗レスポンス。HelperFetchErrorResponse と一致。
type fetchErrorResponse struct {
	OK      bool   `json:"ok"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

// statusResponse は GET /api/status の応答。
type statusResponse struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
}

// shutdownResponse は POST /api/shutdown の応答。
type shutdownResponse struct {
	OK bool `json:"ok"`
}

// Server は HTTP サーバとシャットダウン制御を保持する。
type Server struct {
	httpServer *http.Server
	allowed    map[string]struct{}
	shutdownCh chan struct{}
}

// Config はサーバ起動のパラメータ。
type Config struct {
	// AllowedOrigins は許可する Origin のセット（スキーム://ホスト:ポート）。
	AllowedOrigins []string
	// OnShutdown はシャットダウン要求時に呼ばれる（プロセス終了用）。
	OnShutdown func()
}

// New は Config で Server を構築する。
func New(cfg Config) *Server {
	allowed := make(map[string]struct{}, len(cfg.AllowedOrigins))
	for _, o := range cfg.AllowedOrigins {
		allowed[normalizeOrigin(o)] = struct{}{}
	}
	return &Server{
		allowed:    allowed,
		shutdownCh: make(chan struct{}),
		httpServer: &http.Server{
			// 状態変更系は Origin チェックを厳密に、Handler で分岐。
			Handler:           nil, // Listen 内で設定
			ReadHeaderTimeout: 10 * time.Second,
		},
	}
}

// Listen はポート候補を順に試行し、最初に開いたポートで待ち受ける。
// 開いたポート番号を返す。
func (s *Server) Listen(ctx context.Context) (int, error) {
	var ln net.Listener
	var chosen int
	for _, p := range portCandidates {
		l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", p))
		if err == nil {
			ln = l
			chosen = p
			break
		}
		// 使用中なら次の候補へ。それ以外のエラーは致命的。
		var ne net.Error
		if !errors.As(err, &ne) || !isAddrInUse(err) {
			return 0, fmt.Errorf("listen 127.0.0.1:%d: %w", p, err)
		}
	}
	if ln == nil {
		return 0, errors.New("no available port in 53712-53716")
	}

	s.httpServer.Handler = s.routes()

	// バックグラウンドで Serve。
	go func() {
		_ = s.httpServer.Serve(ln)
	}()

	return chosen, nil
}

// Wait はシャットダウン信号またはコンテキスト終了までブロックする。
func (s *Server) Wait(ctx context.Context) error {
	select {
	case <-s.shutdownCh:
		return s.gracefulShutdown()
	case <-ctx.Done():
		return s.gracefulShutdown()
	}
}

func (s *Server) gracefulShutdown() error {
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return s.httpServer.Shutdown(shutCtx)
}

// routes は HTTP ルーティングを構築する。
func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", s.withCORS(s.handleStatus))
	mux.HandleFunc("/api/fetch", s.withCORS(s.handleFetch))
	mux.HandleFunc("/api/shutdown", s.withCORS(s.handleShutdown))
	return mux
}

// withCORS は CORS / Private Network Access のプリフライトと Origin チェックを適用する。
func (s *Server) withCORS(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		originAllowed := s.originAllowed(origin)

		// 共通: Vary ヘッダ（キャッシュが Origin 別に分かれるように）。
		w.Header().Add("Vary", "Origin")

		if r.Method == http.MethodOptions {
			// プリフライト応答。許可 Origin にのみ PNA・CORS ヘッダを付与。
			if origin != "" && originAllowed {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Access-Control-Allow-Private-Network", "true")
				w.Header().Set("Access-Control-Allow-Headers", "content-type")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			// 許可外 Origin のプリフライトは 403。
			w.WriteHeader(http.StatusForbidden)
			return
		}

		// 状態変更リクエスト（POST/PUT/DELETE）は厳密に Origin チェック。
		if isStateChanging(r.Method) {
			if origin == "" {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "missing Origin header"})
				return
			}
			if !originAllowed {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "origin not allowed"})
				return
			}
		}

		// 許可 Origin には CORS ヘッダを付与（GET も含む）。
		if origin != "" && originAllowed {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Private-Network", "true")
		}

		h(w, r)
	}
}

// originAllowed は Origin が allowlist に含まれるかを返す。
func (s *Server) originAllowed(origin string) bool {
	if origin == "" {
		return false
	}
	_, ok := s.allowed[normalizeOrigin(origin)]
	return ok
}

// handleStatus は GET /api/status のハンドラ。
// 死活・バージョン応答。Origin が許可されていなくても 200 を返すが、
// CORS ヘッダは許可 Origin にのみ付与（withCORS で処理済み）。
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, statusResponse{OK: true, Version: Version})
}

// handleFetch は POST /api/fetch のハンドラ。
//
// 【機密取り扱い】
// req.Password / req.EnablePassword はログ/ファイルへ絶対に出さない。
// ログ出力にはホスト・ポート・osHint のみを含める。パスワードは Telnet
// パッケージへ渡した後、本スコープを抜ける際に GC 対象となる。
func (s *Server) handleFetch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	// ボディサイズ制限。
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "failed to read body"})
		return
	}
	_ = r.Body.Close()

	// 【機密取り扱い】リクエストボディにはパスワードが含まれるため、
	// 処理完了後（成功・失敗問わず）にバイトスライスをゼロ化し、メモリ上の
	// 残存期間を最小化する。Go の string はイミュータブルでゼロ化できないが、
	// JSON ボディの生バイト列は可変のため確実に上書きする。
	defer zeroBytes(bodyBytes)

	var req fetchRequest
	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON body"})
		return
	}
	// 【機密取り扱い】req.Password / req.EnablePassword の string 参照を早めに切る。
	// defer で関数終了時にゼロ長へ置換し、GC 対象を早める。string 自体は
	// イミュータブルでバイト内容をゼロ化できないが、参照を切ることで
	// メモリ保持期間を短縮する。
	defer func() {
		req.Password = ""
		req.EnablePassword = ""
	}()

	// バリデーション。バリデーションエラーは 400 + {"error": ...} で返す。
	// Telnet 実行時のエラーコード（empty_body 等）は取得フェーズの失敗を表すもので、
	// リクエストバリデーションエラーには使わない。
	if req.Protocol != "telnet" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "protocol must be \"telnet\" in phase 1"})
		return
	}
	if req.Host == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "host is required"})
		return
	}
	if req.Port <= 0 {
		req.Port = 23
	}
	if !commands.Valid(req.OSHint) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "unsupported osHint"})
		return
	}

	// コマンド解決。
	cmdSet := commands.Lookup(req.OSHint)
	fetchCmd := cmdSet.Fetch
	if req.CommandOverride != nil && strings.TrimSpace(*req.CommandOverride) != "" {
		fetchCmd = strings.TrimSpace(*req.CommandOverride)
	}
	if fetchCmd == "" {
		// generic 等、commandOverride 必須。
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "commandOverride is required for this osHint"})
		return
	}

	// タイムアウト解決。
	to := resolveTimeouts(req.Timeouts)

	// 【ログ出力】パスワード類は絶対に出さない。ホスト・ポート・osHint のみ。
	log.Printf("[fetch] host=%s port=%d osHint=%s command=%q", req.Host, req.Port, req.OSHint, fetchCmd)

	// Telnet 取得実行。全体タイムアウトをコンテキストで管理。
	ctx, cancel := context.WithTimeout(r.Context(), to.total)
	defer cancel()

	tcfg := &telnet.Config{
		Host:            req.Host,
		Port:            req.Port,
		Username:        req.Username,
		Password:        req.Password,
		EnablePassword:  req.EnablePassword,
		OSHint:          req.OSHint,
		CommandOverride: optionalStr(req.CommandOverride),
		PagerSuppress:   cmdSet.PagerSuppress,
		FetchCommand:    fetchCmd,
		ConnectTimeout:  to.connect,
		LoginTimeout:    to.login,
		CommandTimeout:  to.command,
		TotalTimeout:    to.total,
	}

	result, err := telnet.Fetch(ctx, tcfg)
	if err != nil {
		var te *telnet.Error
		if errors.As(err, &te) {
			writeJSON(w, http.StatusOK, fetchErrorResponse{
				OK: false, Code: string(te.Code), Message: te.Message,
			})
			return
		}
		// 未知のエラーは generic timeout 扱い。
		writeJSON(w, http.StatusOK, fetchErrorResponse{
			OK: false, Code: string(telnet.CodeTimeout), Message: err.Error(),
		})
		return
	}

	writeJSON(w, http.StatusOK, fetchOkResponse{
		OK:   true,
		Body: result.Body,
		Meta: fetchOkMetaJSON{
			ElapsedMs:      result.ElapsedMs,
			Prompt:         result.Prompt,
			Command:        result.Command,
			SourceEncoding: result.SourceEncoding,
		},
	})
}

// handleShutdown は POST /api/shutdown のハンドラ。
// 200 を返してからプロセスを終了する。
func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, shutdownResponse{OK: true})
	// レスポンス送信後にシャットダウンシグナルを発火。
	go func() {
		// クライアントがレスポンスを読み切る猶予を与える。
		time.Sleep(100 * time.Millisecond)
		close(s.shutdownCh)
	}()
}

// ----- ヘルパ -----

// resolvedTimeouts は解決済みタイムアウト。
type resolvedTimeouts struct {
	connect time.Duration
	login   time.Duration
	command time.Duration
	total   time.Duration
}

func resolveTimeouts(t *fetchTimeoutsJSON) resolvedTimeouts {
	r := resolvedTimeouts{
		connect: msToDur(defaultConnectMs),
		login:   msToDur(defaultLoginMs),
		total:   msToDur(defaultTotalMs),
		command: msToDur(defaultCommandMs),
	}
	if t != nil {
		r.connect = msToDur(clampMs(t.ConnectMs, defaultConnectMs, minConnectMs, maxConnectMs))
		r.login = msToDur(clampMs(t.LoginMs, defaultLoginMs, minLoginMs, maxLoginMs))
		r.command = msToDur(clampMs(t.CommandMs, defaultCommandMs, minCommandMs, maxCommandMs))
		r.total = msToDur(clampMs(t.TotalMs, defaultTotalMs, minTotalMs, maxTotalMs))
	}
	return r
}

// clampMs はミリ秒値を安全な範囲へクランプする。
// 負値・0・nil の場合は既定値を採用。上限を超える場合は上限値にクランプ。
func clampMs(v *int, def, min, max int) int {
	if v == nil || *v <= 0 {
		return def
	}
	if *v < min {
		return min
	}
	if *v > max {
		return max
	}
	return *v
}

func msToDur(ms int) time.Duration {
	return time.Duration(ms) * time.Millisecond
}

// zeroBytes はバイトスライスの内容をゼロ化する。機密データ（パスワードを
// 含むリクエストボディ等）のメモリ残存期間を最小化するために使う。
func zeroBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}

func optionalStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// normalizeOrigin は Origin 文字列を正規化する（末尾スラッシュ除去・小文字化）。
func normalizeOrigin(o string) string {
	o = strings.TrimSpace(o)
	o = strings.TrimRight(o, "/")
	return strings.ToLower(o)
}

// isStateChanging は状態変更系メソッドかを返す。
func isStateChanging(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// isAddrInUse は EADDRINUSE 系エラーかを判定する。
func isAddrInUse(err error) bool {
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		// syscall errno の文字列表現で判定（ポータブルにするのは難しいため）。
		s := opErr.Err.Error()
		if strings.Contains(s, "address already in use") || strings.Contains(s, "in use") {
			return true
		}
	}
	return false
}

// writeJSON は JSON レスポンスを書き込む。
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

// DefaultAllowedOrigins は既定の許可 Origin リストを構築する。
// 優先順位: ビルド時注入 origin > PUBLIC_BASE_URL 環境変数 > 開発用 localhost。
// 配布バイナリでは本番 SPA の origin をビルド時に埋め込む（BuildTimeAllowedOrigin）。
// 起動時に PUBLIC_BASE_URL が設定されていれば追加で許可する（staging 切替等）。
func DefaultAllowedOrigins() []string {
	origins := []string{
		"http://localhost:3000",
		"http://127.0.0.1:3000",
		"http://localhost:5173",
		"http://127.0.0.1:5173",
	}
	// ビルド時注入された本番 origin。
	if bt := strings.TrimSpace(BuildTimeAllowedOrigin); bt != "" {
		origins = append(origins, originOf(bt))
	}
	// 起動時の環境変数（上書き・追加用）。
	if pub := strings.TrimSpace(os.Getenv("PUBLIC_BASE_URL")); pub != "" {
		origins = append(origins, originOf(pub))
	}
	return origins
}

// originOf は URL 文字列から origin（scheme://host[:port]）を取り出す。
func originOf(raw string) string {
	// 簡易パース: scheme://host[:port][/path]
	idx := strings.Index(raw, "://")
	if idx < 0 {
		return normalizeOrigin(raw)
	}
	scheme := raw[:idx]
	rest := raw[idx+3:]
	// 最初の / までを host 部とする。
	if slash := strings.Index(rest, "/"); slash >= 0 {
		rest = rest[:slash]
	}
	return normalizeOrigin(scheme + "://" + rest)
}

// PortCandidates は外部（main）からポート候補を参照するためのアクセサ。
func PortCandidates() []int {
	out := make([]int, len(portCandidates))
	copy(out, portCandidates)
	return out
}

// ParsePort は文字列からポート番号を解析する（CLI 用）。
func ParsePort(s string) (int, error) {
	p, err := strconv.Atoi(s)
	if err != nil {
		return 0, err
	}
	if p < 1 || p > 65535 {
		return 0, errors.New("port out of range")
	}
	return p, nil
}
