import { useEffect } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { AuthProvider, useAuth } from './context/Auth/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import Routes from './routes';
import theme from './theme';
import { socketConnection } from './services/socket';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30 * 1000,
            retry: 1,
            refetchOnWindowFocus: false,
        },
    },
});

const SocketInitializer = () => {
    const { isAuth } = useAuth();

    useEffect(() => {
        if (isAuth) {
            socketConnection.connect();
        } else {
            socketConnection.disconnect();
        }
        return () => { socketConnection.disconnect(); };
    }, [isAuth]);

    return null;
};

function App() {
    return (
        <ErrorBoundary>
            <ThemeProvider theme={theme}>
                <QueryClientProvider client={queryClient}>
                    <CssBaseline />
                    <BrowserRouter>
                        <AuthProvider>
                            <SocketInitializer />
                            <Routes />
                            <ToastContainer
                                position="top-right"
                                autoClose={3000}
                                hideProgressBar={false}
                                newestOnTop
                                closeOnClick
                                rtl={false}
                                pauseOnFocusLoss
                                draggable
                                pauseOnHover
                            />
                        </AuthProvider>
                    </BrowserRouter>
                </QueryClientProvider>
            </ThemeProvider>
        </ErrorBoundary>
    );
}

export default App;
