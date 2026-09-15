package config

import "time"

// DefaultSATokenExpiry is requested duration of validity of the requested ServiceAccount token
const DefaultSATokenExpiry int64 = 7 * 24 * 60 * 60 // 7 days

// TokenRefreshWindow is the remaining token lifetime at which credentials should be refreshed.
const TokenRefreshWindow = 24 * time.Hour
