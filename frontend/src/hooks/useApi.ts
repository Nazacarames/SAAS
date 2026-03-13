import { useQuery } from '@tanstack/react-query';
import api from '../services/api';

export const useContacts = (params?: { status?: string; page?: number; limit?: number }) => {
    return useQuery({
        queryKey: ['contacts', params],
        queryFn: async () => {
            const { data } = await api.get('/contacts', { params });
            return data;
        },
    });
};

export const useConversations = (params?: { status?: string; page?: number; limit?: number }) => {
    return useQuery({
        queryKey: ['conversations', params],
        queryFn: async () => {
            const { data } = await api.get('/conversations', { params });
            return data;
        },
    });
};

export const useMessages = (contactId: number | null, params?: { page?: number; limit?: number }) => {
    return useQuery({
        queryKey: ['messages', contactId, params],
        queryFn: async () => {
            if (!contactId) return [];
            const { data } = await api.get(`/messages/${contactId}`, { params });
            return data;
        },
        enabled: !!contactId,
    });
};

export const useFunnelStats = () => {
    return useQuery({
        queryKey: ['funnel-stats'],
        queryFn: async () => {
            const { data } = await api.get('/ai/funnel/stats');
            return data;
        },
    });
};

export const useUsers = () => {
    return useQuery({
        queryKey: ['users'],
        queryFn: async () => {
            const { data } = await api.get('/users');
            return Array.isArray(data) ? data : [];
        },
    });
};

export const useSavedReplies = () => {
    return useQuery({
        queryKey: ['saved-replies'],
        queryFn: async () => {
            const { data } = await api.get('/saved-replies');
            return Array.isArray(data) ? data : [];
        },
    });
};

export const useTemplates = () => {
    return useQuery({
        queryKey: ['templates'],
        queryFn: async () => {
            const { data } = await api.get('/ai/templates');
            return Array.isArray(data) ? data : [];
        },
    });
};

export const useWhatsapps = () => {
    return useQuery({
        queryKey: ['whatsapps'],
        queryFn: async () => {
            const { data } = await api.get('/whatsapps');
            return Array.isArray(data) ? data : [];
        },
    });
};
