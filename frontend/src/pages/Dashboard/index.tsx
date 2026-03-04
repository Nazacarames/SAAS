import { useEffect, useMemo, useState } from 'react';
import { Typography, Box, Grid, Paper, Card, CardContent, Stack, Chip, LinearProgress } from '@mui/material';
import {
  Chat as ChatIcon,
  Contacts as ContactsIcon,
  WhatsApp as WhatsAppIcon,
  CheckCircle as CheckCircleIcon,
  AccountTree as AccountTreeIcon,
  TrendingUp as TrendingUpIcon
} from '@mui/icons-material';
import api from '../../services/api';

const Dashboard = () => {
  const [tickets, setTickets] = useState<any[]>([]);
  const [contacts, setContacts] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [funnel, setFunnel] = useState({ nuevo: 0, contactado: 0, calificado: 0, interesado: 0 });

  const load = async () => {
    try {
      const [t, c, w, f] = await Promise.all([
        api.get('/conversations'),
        api.get('/contacts'),
        api.get('/whatsapps'),
        api.get('/ai/funnel/stats')
      ]);
      setTickets(Array.isArray(t.data) ? t.data : []);
      setContacts(Array.isArray(c.data) ? c.data : []);
      setConnections(Array.isArray(w.data) ? w.data : []);
      setFunnel(f.data || { nuevo: 0, contactado: 0, calificado: 0, interesado: 0 });
    } catch {
      // silent fallback
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  const openTickets = tickets.filter((x: any) => x.status === 'open' || x.status === 'pending').length;
  const closedToday = tickets.filter((x: any) => {
    if (x.status !== 'closed') return false;
    const d = new Date(x.updatedAt || x.createdAt);
    const n = new Date();
    return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  }).length;

  const stats = [
    { title: 'Tickets abiertos', value: String(openTickets), icon: <ChatIcon />, color: '#5BB2FF' },
    { title: 'Contactos', value: String(contacts.length), icon: <ContactsIcon />, color: '#8B7CFF' },
    { title: 'Canales WhatsApp', value: String(connections.length), icon: <WhatsAppIcon />, color: '#22C55E' },
    { title: 'Resueltos hoy', value: String(closedToday), icon: <CheckCircleIcon />, color: '#F59E0B' }
  ];

  const funnelCards = [
    { title: 'Nuevo', value: funnel.nuevo, color: '#7D8CA8' },
    { title: 'Contactado', value: funnel.contactado, color: '#5BB2FF' },
    { title: 'Calificado', value: funnel.calificado, color: '#A78BFA' },
    { title: 'Interesado', value: funnel.interesado, color: '#22C55E' }
  ];

  const funnelTotal = useMemo(
    () => funnel.nuevo + funnel.contactado + funnel.calificado + funnel.interesado,
    [funnel]
  );

  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' alignItems={{ xs: 'flex-start', md: 'center' }} sx={{ mb: 2, gap: 1 }}>
        <Box>
          <Typography variant='h4'>Dashboard ejecutivo</Typography>
          <Typography variant='body2' color='text.secondary'>Visión operativa en tiempo real de conversaciones, leads y conversión.</Typography>
        </Box>
        <Chip icon={<TrendingUpIcon />} label='Actualiza cada 15s' color='primary' variant='outlined' />
      </Stack>

      <Grid container spacing={2}>
        {stats.map((stat, index) => (
          <Grid item xs={12} sm={6} lg={3} key={index}>
            <Card sx={{ border: '1px solid', borderColor: 'divider' }}>
              <CardContent>
                <Stack direction='row' justifyContent='space-between' alignItems='center'>
                  <Box>
                    <Typography color='text.secondary' variant='body2'>
                      {stat.title}
                    </Typography>
                    <Typography variant='h4' sx={{ mt: 0.5 }}>{stat.value}</Typography>
                  </Box>
                  <Box sx={{ color: stat.color, p: 1, borderRadius: 2, bgcolor: 'rgba(255,255,255,0.03)' }}>{stat.icon}</Box>
                </Stack>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Paper sx={{ mt: 3, p: 2.5 }}>
        <Stack direction='row' alignItems='center' spacing={1} sx={{ mb: 2 }}>
          <AccountTreeIcon fontSize='small' color='primary' />
          <Typography variant='h6'>Funnel unificado</Typography>
        </Stack>

        <Grid container spacing={2}>
          {funnelCards.map((item) => {
            const pct = funnelTotal > 0 ? Math.round((item.value / funnelTotal) * 100) : 0;
            return (
              <Grid item xs={12} md={3} key={item.title}>
                <Paper variant='outlined' sx={{ p: 1.5, borderColor: 'divider' }}>
                  <Typography variant='caption' color='text.secondary'>
                    {item.title}
                  </Typography>
                  <Typography variant='h5' sx={{ color: item.color, mb: 1 }}>
                    {item.value}
                  </Typography>
                  <LinearProgress variant='determinate' value={pct} sx={{ height: 8, borderRadius: 10 }} />
                  <Typography variant='caption' color='text.secondary' sx={{ mt: 0.6, display: 'block' }}>{pct}% del funnel</Typography>
                </Paper>
              </Grid>
            );
          })}
        </Grid>
      </Paper>
    </Box>
  );
};

export default Dashboard;
