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
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const token = localStorage.getItem('token');
        const storedUser = localStorage.getItem('user');

        if (token && storedUser) {
            setUser(JSON.parse(storedUser));
        }

        setLoading(false);
    }, []);

    const handleLogin = async (email: string, password: string) => {
        const { data } = await api.post('/auth/login', { email, password });

        localStorage.setItem('token', data.token);
        localStorage.setItem('user', JSON.stringify(data.user));

        setUser(data.user);
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        setUser(null);
        window.location.href = '/login';
    };

    return (
        <AuthContext.Provider
            value={{
                user,
                isAuth: !!user,
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
