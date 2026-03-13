import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simple test to verify the api module structure
describe('API Service', () => {
    beforeEach(() => {
        vi.resetModules();
        localStorage.clear();
    });

    it('should export a default axios instance', async () => {
        vi.mock('axios', () => {
            const mockInstance = {
                get: vi.fn(),
                post: vi.fn(),
                put: vi.fn(),
                delete: vi.fn(),
                interceptors: {
                    request: { use: vi.fn() },
                    response: { use: vi.fn() },
                },
                defaults: {
                    baseURL: '/api',
                    headers: { common: {} },
                },
            };
            return {
                default: {
                    create: vi.fn(() => mockInstance),
                    post: vi.fn(),
                },
            };
        });

        const { default: api } = await import('../services/api');
        expect(api).toBeDefined();
        expect(api.defaults).toBeDefined();
    });
});
