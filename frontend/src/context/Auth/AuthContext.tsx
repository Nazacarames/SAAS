import React, { createContext, useState, useEffect, useContext } from 'react';
import api from '../../services/api';

interface User {
    id: number;
    name: string;
    email: string;
    profile: string;
    companyId: number;
}

interface AuthContextData {
    user: User | null;
    isAuth: boolean;
    loading: boolean;
    handleLogin: (email: string, password: string) => Promise<void>;
    handleLogout: () => void;
}

const AuthContext = createContext<AuthContextData>({} as AuthContextData);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [user, setUser] = useState<User | null>(null);
    const [hasSession, setHasSession] = useState<boolean>(() => Boolean(localStorage.getItem('authToken') || localStorage.getItem('user')));
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const bootstrapAuth = async () => {
            const storedUser = localStorage.getItem('user');
            const storedToken = localStorage.getItem('authToken');

            let parsedUser: User | null = null;
            if (storedUser) {
                try {
                    const parsed = JSON.parse(storedUser);
                    if (parsed && typeof parsed.id === 'number') {
                        parsedUser = parsed;
                        setUser(parsed);
                        setHasSession(true);
                    }
                } catch {
                    localStorage.removeItem('user');
                }
            }

            if (!storedUser && !storedToken) {
                setHasSession(false);
                setLoading(false);
                return;
            }

            try {
                const { data } = await api.get('/auth/me');
                const safeUser = data?.user;
                if (safeUser?.id) {
                    localStorage.setItem('user', JSON.stringify(safeUser));
                    setUser(safeUser);
                    setHasSession(true);
                }
            } catch {
                // Prevent dashboard->login bounce on transient auth bootstrap failures.
                // Keep previously restored user; only clear if there was no valid local session at all.
                if (!parsedUser) {
                    localStorage.removeItem('user');
                    localStorage.removeItem('authToken');
                    setUser(null);
                    setHasSession(false);
                }
            } finally {
                setLoading(false);
            }
        };

        bootstrapAuth();
    }, []);

    const handleLogin = async (email: string, password: string) => {
        const { data } = await api.post('/auth/login', { email, password });
        // Primary auth: HttpOnly cookie. Fallback: bearer token in localStorage (for restrictive browser cookie settings).
        if (data?.token) {
            localStorage.setItem('authToken', data.token);
        }
        localStorage.setItem('user', JSON.stringify(data.user));
        setUser(data.user);
        setHasSession(true);
    };

    const handleLogout = async () => {
        try {
            await api.post('/auth/logout');
        } catch {
            // ignore logout errors
        }
        localStorage.removeItem('user');
        localStorage.removeItem('authToken');
        setUser(null);
        setHasSession(false);
        window.location.href = '/login';
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuth: !!user || hasSession,
                loading,
                handleLogin,
                handleLogout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within AuthProvider');
    }
    return context;
};

export default AuthContext;
