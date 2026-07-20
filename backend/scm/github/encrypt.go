package github

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"

	"golang.org/x/crypto/nacl/box"
)

// encryptSecret seals secretValue with a NaCl box for GitHub Actions secret storage.
func encryptSecret(publicKeyBase64, secretValue string) (string, error) {
	recipientKeyBytes, err := base64.StdEncoding.DecodeString(publicKeyBase64)
	if err != nil {
		return "", fmt.Errorf("decode public key: %w", err)
	}
	if len(recipientKeyBytes) != 32 {
		return "", fmt.Errorf("public key must be 32 bytes, got %d", len(recipientKeyBytes))
	}
	var recipientKey [32]byte
	copy(recipientKey[:], recipientKeyBytes)

	encrypted, err := box.SealAnonymous(nil, []byte(secretValue), &recipientKey, rand.Reader)
	if err != nil {
		return "", fmt.Errorf("seal secret: %w", err)
	}
	return base64.StdEncoding.EncodeToString(encrypted), nil
}

// base64ToUTF8 decodes GitHub API blob content, which is base64 with line breaks.
func base64ToUTF8(encoded string) (string, error) {
	var stripped []byte
	for _, b := range []byte(encoded) {
		if b != '\n' && b != '\r' {
			stripped = append(stripped, b)
		}
	}
	decoded, err := base64.StdEncoding.DecodeString(string(stripped))
	if err != nil {
		return "", fmt.Errorf("decode base64 content: %w", err)
	}
	return string(decoded), nil
}
