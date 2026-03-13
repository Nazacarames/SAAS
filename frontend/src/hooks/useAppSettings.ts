import { useQuery } from '@tanstack/react-query';
import api from '../services/api';

export interface AppSettings {
    leadScoreHot: number;
    leadScoreWarm: number;
    leadScoreContacted: number;
    conversationPollIntervalMs: number;
    dashboardPollIntervalMs: number;
}

const defaults: AppSettings = {
    leadScoreHot: 75,
    leadScoreWarm: 50,
    leadScoreContacted: 25,
    conversationPollIntervalMs: 30000,
    dashboardPollIntervalMs: 60000,
};

export const useAppSettings = () => {
    return useQuery<AppSettings>({
        queryKey: ['app-settings'],
        queryFn: async () => {
            try {
                const { data } = await api.get('/settings/public');
                return { ...defaults, ...data };
            } catch {
                return defaults;
            }
        },
        staleTime: 5 * 60 * 1000,
    });
};
