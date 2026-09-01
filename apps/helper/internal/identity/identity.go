// Package helperidentity はローカルヘルパーの永続 ID、Ed25519 署名鍵、
// ペアリングコードを管理する。
package helperidentity

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	identityFileEnv     = "HELPER_IDENTITY_FILE"
	helperConfigDirName = "config-manager-helper"
	identityFileName    = "identity.json"
	pairingSecretBytes  = 16
)

const PairingMessagePrefix = "config-manager-helper-pair-v1"
const RedeemMessagePrefix = "config-manager-helper-redeem-v1"

type storedIdentity struct {
	PrivateKey    string `json:"privateKey"`
	PairingSecret string `json:"pairingSecret"`
}

// Identity はヘルパー 1 インストールを識別する永続 ID と秘密鍵を保持する。
type Identity struct {
	privateKey    ed25519.PrivateKey
	publicKey     string
	id            string
	pairingSecret []byte
}

// DefaultPath は identity.json の既定保存先を返す。
func DefaultPath() (string, error) {
	if p := os.Getenv(identityFileEnv); p != "" {
		return p, nil
	}
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, helperConfigDirName, identityFileName), nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine helper identity location: %w", err)
	}
	return filepath.Join(home, "."+helperConfigDirName, identityFileName), nil
}

// LoadOrCreate は永続 identity を読み込み、未作成なら安全な乱数で生成する。
func LoadOrCreate(path string) (*Identity, error) {
	if path == "" {
		var err error
		path, err = DefaultPath()
		if err != nil {
			return nil, err
		}
	}
	if raw, err := os.ReadFile(path); err == nil {
		return parseStored(raw)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("cannot read helper identity: %w", err)
	}

	identity, stored, err := generate()
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("cannot create helper identity directory: %w", err)
	}
	raw, err := json.MarshalIndent(stored, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("cannot encode helper identity: %w", err)
	}
	// O_EXCL により同時起動時に互いの identity を上書きしない。
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			return nil, fmt.Errorf("cannot read concurrently created helper identity: %w", rerr)
		}
		return parseStored(raw)
	}
	if err != nil {
		return nil, fmt.Errorf("cannot create helper identity: %w", err)
	}
	if _, err := f.Write(raw); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("cannot write helper identity: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("cannot sync helper identity: %w", err)
	}
	if err := f.Close(); err != nil {
		return nil, fmt.Errorf("cannot close helper identity: %w", err)
	}
	return identity, nil
}

// GenerateEphemeral は永続化しない identity を生成する。テスト用サーバー等で使う。
func GenerateEphemeral() (*Identity, error) {
	identity, _, err := generate()
	return identity, err
}

func generate() (*Identity, storedIdentity, error) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, storedIdentity{}, fmt.Errorf("cannot generate helper signing key: %w", err)
	}
	pairingSecret := make([]byte, pairingSecretBytes)
	if _, err := rand.Read(pairingSecret); err != nil {
		return nil, storedIdentity{}, fmt.Errorf("cannot generate helper pairing code: %w", err)
	}
	identity, err := newIdentity(privateKey, pairingSecret)
	if err != nil {
		return nil, storedIdentity{}, err
	}
	stored := storedIdentity{
		PrivateKey:    base64.RawURLEncoding.EncodeToString(privateKey),
		PairingSecret: base64.RawURLEncoding.EncodeToString(pairingSecret),
	}
	return identity, stored, nil
}

func parseStored(raw []byte) (*Identity, error) {
	var stored storedIdentity
	if err := json.Unmarshal(raw, &stored); err != nil {
		return nil, fmt.Errorf("invalid helper identity file: %w", err)
	}
	privateKey, err := base64.RawURLEncoding.DecodeString(stored.PrivateKey)
	if err != nil || len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid helper identity private key")
	}
	pairingSecret, err := base64.RawURLEncoding.DecodeString(stored.PairingSecret)
	if err != nil || len(pairingSecret) != pairingSecretBytes {
		return nil, errors.New("invalid helper identity pairing secret")
	}
	return newIdentity(ed25519.PrivateKey(privateKey), pairingSecret)
}

func newIdentity(privateKey ed25519.PrivateKey, pairingSecret []byte) (*Identity, error) {
	publicKey := privateKey.Public().(ed25519.PublicKey)
	publicDER, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return nil, fmt.Errorf("cannot encode helper public key: %w", err)
	}
	digest := sha256.Sum256(publicDER)
	return &Identity{
		privateKey:    append(ed25519.PrivateKey(nil), privateKey...),
		publicKey:     base64.RawURLEncoding.EncodeToString(publicDER),
		id:            base64.RawURLEncoding.EncodeToString(digest[:]),
		pairingSecret: append([]byte(nil), pairingSecret...),
	}, nil
}

func (i *Identity) ID() string        { return i.id }
func (i *Identity) PublicKey() string { return i.publicKey }
func (i *Identity) PairingCode() string {
	return base64.RawURLEncoding.EncodeToString(i.pairingSecret)
}

// PairingProof は pairing code を送信せずに所有を証明する HMAC を返す。
func (i *Identity) PairingProof(nonce string) string {
	mac := hmac.New(sha256.New, i.pairingSecret)
	_, _ = mac.Write([]byte(PairingMessage(nonce, i.id, i.publicKey)))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// SignRedeem は credential token と接続先を Ed25519 で署名する。
func (i *Identity) SignRedeem(token, targetHost string) string {
	signature := ed25519.Sign(i.privateKey, []byte(RedeemMessage(token, targetHost)))
	return base64.RawURLEncoding.EncodeToString(signature)
}

func PairingMessage(nonce, helperID, publicKey string) string {
	return PairingMessagePrefix + "\n" + nonce + "\n" + helperID + "\n" + publicKey
}

func RedeemMessage(token, targetHost string) string {
	return RedeemMessagePrefix + "\n" + token + "\n" + targetHost
}
