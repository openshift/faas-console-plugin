package config

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// ParseSATokenExpiry converts the --sa-token-expiry value into a token lifetime in
// seconds. The value is a duration in common notation, e.g. 30d, 10h, or
// 7d12h. The 'd' (days) unit extends Go's standard duration units (h, m, s).
// An empty value yields DefaultSATokenExpiry.
func ParseSATokenExpiry(s string) (int64, error) {
	if s == "" {
		return DefaultSATokenExpiry, nil
	}
	d, err := parseExpiryDuration(s)
	if err != nil {
		return 0, fmt.Errorf("invalid token expiry %q: %w", s, err)
	}
	secs := int64(d / time.Second)
	if secs <= 0 {
		return 0, fmt.Errorf("invalid token expiry %q: must be at least one second", s)
	}
	return secs, nil
}

func ParseWorkflowPollingInterval(s string) (time.Duration, error) {
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("invalid workflow polling interval %q: must be a positive duration such as 3s, 30s, or 1m", s)
	}
	return d, nil
}

// parseExpiryDuration parses a duration that may include a leading days
// component (e.g. 7d or 7d12h). time.ParseDuration handles h/m/s but not d.
func parseExpiryDuration(s string) (time.Duration, error) {
	var total time.Duration
	var errExpiryFormat = errors.New("must be a duration such as 30d, 10h, or 7d12h")
	rest := s
	if i := strings.IndexByte(rest, 'd'); i >= 0 {
		days, err := strconv.Atoi(rest[:i])
		if err != nil {
			return 0, errExpiryFormat
		}
		total += time.Duration(days) * 24 * time.Hour
		rest = rest[i+1:]
	}
	if rest != "" {
		d, err := time.ParseDuration(rest)
		if err != nil {
			return 0, errExpiryFormat
		}
		total += d
	}
	return total, nil
}
