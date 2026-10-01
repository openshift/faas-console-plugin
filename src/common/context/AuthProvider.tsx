import { createContext, ReactNode, useCallback, useEffect, useState } from 'react';
import { isSessionActive, logout, resumeSession } from '../clients/sessionClient';
import { AuthUser, SESSION_EXPIRED_EVENT, USER_KEY } from '../types';

const NO_USER: AuthUser = { name: '', avatarUrl: '' };

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser;
  connectionId: number;
  onLogin: (user: AuthUser) => void;
  onLogout: () => Promise<void>;
}

export const AuthContext = createContext<AuthState>({
  isAuthenticated: false,
  user: NO_USER,
  connectionId: 0,
  onLogin: () => {},
  onLogout: async () => {},
});

export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(isSessionActive);
  const [user, setUser] = useState<AuthUser>(readStoredUser);
  const [connectionId, setConnectionId] = useState(0);

  const onLogin = (authUser: AuthUser) => {
    setUser(authUser);
    setIsAuthenticated(true);
    setConnectionId((id) => id + 1);
  };

  const clearAuth = useCallback(() => {
    setUser(NO_USER);
    setIsAuthenticated(false);
    setConnectionId((id) => id + 1);
  }, []);

  const onLogout = async () => {
    await logout();
    clearAuth();
  };

  // Authenticate the user if they have a session token stored in BE but not in the browser.
  useEffect(() => {
    if (isSessionActive()) return;
    let cancelled = false;
    resumeSession()
      .then((resumed) => {
        if (resumed && !cancelled) onLogin(resumed);
      })
      .catch(() => {
        // stay disconnected
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, clearAuth);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, clearAuth);
  }, [clearAuth]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, connectionId, onLogin, onLogout }}>
      {children}
    </AuthContext.Provider>
  );
}

function readStoredUser(): AuthUser {
  const userJson = sessionStorage.getItem(USER_KEY);
  if (!userJson) return NO_USER;
  try {
    return JSON.parse(userJson) as AuthUser;
  } catch {
    return NO_USER;
  }
}
