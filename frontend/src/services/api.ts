import axios from 'axios';

const api = axios.create({
    baseURL: import.meta.env.VITE_BACKEND_URL || '/api',
    headers: {
        'Content-Type': 'application/json',
    },
    withCredentials: true,
});

// No need to add token in request interceptor - cookies are sent automatically

// Flag to prevent concurrent refresh loops and failed queue
let isRefreshing = false;
let failedQueue: Array<{ resolve: (v: unknown) => void; reject: (err: any) => void }> = [];
let refreshCooldown = false;
const COOLDOWN_MS = 5000;

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
        const originalRequest = error.config;

        if (error.response?.status === 401 && !originalRequest._retry) {
            // If refresh recently failed, don't retry - fail immediately
            if (refreshCooldown) {
                return Promise.reject(new Error('Token refresh cooldown'));
            }

            if (isRefreshing) {
                return new Promise((resolve, reject) => {
                    failedQueue.push({ resolve, reject });
                }).then(() => {
                    return api(originalRequest);
                }).catch(err => {
                    return Promise.reject(err);
                });
            }

            originalRequest._retry = true;
            isRefreshing = true;

            try {
                await axios.post(
                    `${api.defaults.baseURL}/auth/refresh`,
                    {},
                    { withCredentials: true }
                );
                processQueue(null);
                return api(originalRequest);
            } catch (refreshError: any) {
                processQueue(refreshError);
                // Enter cooldown to prevent rapid retry loops
                refreshCooldown = true;
                setTimeout(() => { refreshCooldown = false; }, COOLDOWN_MS);

                // Only redirect to login if not already on login page
                if (!window.location.pathname.includes('/login')) {
                    localStorage.removeItem('user');
                    window.location.href = '/login';
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
