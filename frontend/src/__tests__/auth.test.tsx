import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from '../context/Auth/AuthContext';
import { ThemeProvider } from '@mui/material/styles';
import theme from '../theme';

// Mock api module
vi.mock('../services/api', () => {
    return {
        default: {
            post: vi.fn(),
            get: vi.fn(),
            interceptors: {
                request: { use: vi.fn() },
                response: { use: vi.fn() },
            },
            defaults: { baseURL: '/api', headers: { common: {} } },
        },
    };
});

const TestComponent = () => {
    const { user, isAuth, loading } = useAuth();
    return (
        <div>
            <span data-testid="loading">{String(loading)}</span>
            <span data-testid="isAuth">{String(isAuth)}</span>
            <span data-testid="user">{user ? user.name : 'null'}</span>
        </div>
    );
};

const renderWithProviders = (ui: React.ReactElement) => {
    return render(
        <BrowserRouter>
            <ThemeProvider theme={theme}>
                <AuthProvider>{ui}</AuthProvider>
            </ThemeProvider>
        </BrowserRouter>
    );
};

describe('AuthContext', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('starts with no user when localStorage is empty', async () => {
        renderWithProviders(<TestComponent />);

        await waitFor(() => {
            expect(screen.getByTestId('loading')).toHaveTextContent('false');
        });

        expect(screen.getByTestId('isAuth')).toHaveTextContent('false');
        expect(screen.getByTestId('user')).toHaveTextContent('null');
    });

    it('restores user from localStorage on mount', async () => {
        const mockUser = { id: 1, name: 'Test User', email: 'test@test.com', profile: 'admin', companyId: 1 };
        localStorage.setItem('user', JSON.stringify(mockUser));

        renderWithProviders(<TestComponent />);

        await waitFor(() => {
            expect(screen.getByTestId('loading')).toHaveTextContent('false');
        });

        expect(screen.getByTestId('isAuth')).toHaveTextContent('true');
        expect(screen.getByTestId('user')).toHaveTextContent('Test User');
    });

    it('clears invalid user data from localStorage', async () => {
        localStorage.setItem('user', 'not-valid-json');

        renderWithProviders(<TestComponent />);

        await waitFor(() => {
            expect(screen.getByTestId('loading')).toHaveTextContent('false');
        });

        expect(screen.getByTestId('isAuth')).toHaveTextContent('false');
        expect(localStorage.getItem('user')).toBeNull();
    });
});
