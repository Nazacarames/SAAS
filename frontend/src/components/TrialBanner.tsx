import { useEffect, useState } from 'react';
import { Box, Typography, Button } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';

// Barra fija durante el trial: dias restantes + CTA a billing.
const TrialBanner = () => {
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    api.get('/billing/current').then(({ data }) => {
      if (!mounted) return;
      const sub = data?.subscription;
      if (sub?.status === 'trialing' && sub?.trialEndsAt && !sub?.billingBypass) {
        const d = Math.ceil((new Date(sub.trialEndsAt).getTime() - Date.now()) / 86400000);
        setDaysLeft(d);
      }
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  if (daysLeft === null) return null;
  const urgent = daysLeft <= 5;
  return (
    <Box sx={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
      px: 2, py: 0.8, mb: 2, borderRadius: '10px',
      background: urgent ? 'rgba(239,83,80,0.10)' : 'rgba(232,160,32,0.08)',
      border: `1px solid ${urgent ? 'rgba(239,83,80,0.3)' : 'rgba(232,160,32,0.25)'}`,
    }}>
      <Typography sx={{ fontSize: '0.82rem', color: urgent ? '#EF5350' : '#E8A020', fontWeight: 600 }}>
        {daysLeft > 0
          ? `Prueba gratis: te quedan ${daysLeft} día${daysLeft === 1 ? '' : 's'}`
          : 'Tu prueba gratis terminó'}
      </Typography>
      <Button size='small' variant='contained' sx={{ fontSize: '0.72rem', py: 0.3 }} onClick={() => navigate('/billing')}>
        Ver planes
      </Button>
    </Box>
  );
};

export default TrialBanner;
