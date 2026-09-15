package config

import (
	"testing"
	"time"
)

func TestParseSATokenExpiry(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    int64
		wantErr bool
	}{
		{name: "empty value uses default", value: "", want: DefaultSATokenExpiry},
		{name: "days", value: "30d", want: int64(30 * 24 * 60 * 60)},
		{name: "hours", value: "10h", want: int64(10 * 60 * 60)},
		{name: "days and hours", value: "7d12h", want: int64(7*24*60*60 + 12*60*60)},
		{name: "hours and minutes", value: "1h30m", want: int64(90 * 60)},
		{name: "malformed value", value: "not-a-duration", wantErr: true},
		{name: "invalid days component", value: "days1h", wantErr: true},
		{name: "invalid duration component", value: "1d2d", wantErr: true},
		{name: "zero", value: "0s", wantErr: true},
		{name: "negative", value: "-1s", wantErr: true},
		{name: "less than one second", value: "500ms", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseSATokenExpiry(tt.value)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseSATokenExpiry(%q) error = %v, wantErr %v", tt.value, err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("ParseSATokenExpiry(%q) = %d, want %d", tt.value, got, tt.want)
			}
		})
	}
}

func TestParseExpiryDuration(t *testing.T) {
	tests := []struct {
		name    string
		value   string
		want    time.Duration
		wantErr bool
	}{
		{name: "days only", value: "2d", want: 48 * time.Hour},
		{name: "non-numeric days", value: "days1h", wantErr: true},
		{name: "invalid standard duration", value: "1d2d", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseExpiryDuration(tt.value)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseExpiryDuration(%q) error = %v, wantErr %v", tt.value, err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("parseExpiryDuration(%q) = %s, want %s", tt.value, got, tt.want)
			}
		})
	}
}
