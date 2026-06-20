import { useEffect, useState } from 'react';
import { Box, Typography, Stack } from '@mui/material';
import { Warning as WarningIcon } from '@mui/icons-material';
import api from '../services/api';

interface TokenStatus {
  companyId: number;
  name: string;
  status: string;
  detail?: string;
}

const HealthAlert = () => {
  const [alerts, setAlerts] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const check = async () => {
      try {
        const { data } = await api.get('/health/whatsapp-tokens');
        const problems: string[] = [];
        (data.tokens || []).forEach((t: TokenStatus) => {
          if (t.status === 'expired') {
            problems.push(`Token de WhatsApp expirado (${t.name || 'cuenta ' + t.companyId}). Renovalo en Conexiones.`);
          } else if (t.status === 'not_configured') {
            problems.push(`WhatsApp no configurado (${t.name || 'cuenta ' + t.companyId}).`);
          } else if (t.status === 'error') {
            problems.push(`Error en WhatsApp (${t.name}): ${t.detail?.slice(0, 80)}`);
          }
        });
        setAlerts(problems);
      } catch {
        // silently ignore
      }
    };

    check();
    const interval = setInterval(check, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  if (!alerts.length || dismissed) return null;

  return (
    <Box
      sx={{
        mx: { xs: 2, md: 3 }, mt: 1.5, p: 1.5, borderRadius: '10px',
        background: 'rgba(239,83,80,0.08)',
        border: '1px solid rgba(239,83,80,0.2)',
        cursor: 'pointer',
      }}
      onClick={() => setDismissed(true)}
    >
      {alerts.map((a, i) => (
        <Stack key={i} direction="row" spacing={1} alignItems="center" sx={{ mb: i < alerts.length - 1 ? 0.5 : 0 }}>
          <WarningIcon sx={{ fontSize: 16, color: '#EF5350' }} />
          <Typography sx={{ fontSize: '0.78rem', color: '#EF5350', fontWeight: 500 }}>{a}</Typography>
        </Stack>
      ))}
    </Box>
  );
};

export default HealthAlert;
