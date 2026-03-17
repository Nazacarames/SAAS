import axios from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_BACKEND_URL || '/api',
    headers: {
        'Content-Type': 'application/json',
    },
    withCredentials: true,
});

// Primary auth uses HttpOnly cookies; fallback to bearer token for browsers blocking auth cookies.
api.interceptors.request.use((config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
        config.headers = config.headers || {};
        (config.headers as any).Authorization = `Bearer ${token}`;
    }
    return config;
});

// Flag to prevent infinite refresh loops
let isRefreshing = false;
let failedQueue: Array<{ resolve: (v: unknown) => void; reject: (err: any) => void }> = [];

const processQueue = (error: any) => {
    failedQueue.forEach(({ resolve, reject }) => {
        if (error) reject(error);
        else resolve(undefined);
    });
    failedQueue = [];
};

// Response interceptor with automatic token refresh
api.interceptors.response.use(
    (response) => response,
    async (error) => {
        const originalRequest = error.config || {};
        const reqUrl = String(originalRequest?.url || "");
        const isAuthBootstrapCall = reqUrl.includes('/auth/me');
        const isLoginOrRegister = reqUrl.includes('/auth/login') || reqUrl.includes('/auth/register');

        if (error.response?.status === 401 && !originalRequest._retry && !isLoginOrRegister) {
            if (isRefreshing) {
                return new Promise((resolve, reject) => {
                    failedQueue.push({ resolve, reject });
                }).then(() => {
                    return api(originalRequest);
                });
            }

            originalRequest._retry = true;
            isRefreshing = true;

            try {
                const refreshResp = await axios.post(
                    `${api.defaults.baseURL}/auth/refresh`,
                    {},
                    { withCredentials: true }
                );
                const newToken = (refreshResp as any)?.data?.token;
                if (newToken) {
                    localStorage.setItem('authToken', newToken);
                }
                processQueue(null);
                return api(originalRequest);
            } catch (refreshError) {
                processQueue(refreshError);
                // Never force redirect from interceptor; caller/auth context decides UX.
                if (isAuthBootstrapCall) {
                    localStorage.removeItem('authToken');
                }
                return Promise.reject(refreshError);
            } finally {
                isRefreshing = false;
            }
        }

        return Promise.reject(error);
    }
);

export default api;
