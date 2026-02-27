import { useEffect, useState } from 'react';
import { Typography, Box, Grid, Paper, Card, CardContent } from '@mui/material';
import {
  Chat as ChatIcon,
  Contacts as ContactsIcon,
  WhatsApp as WhatsAppIcon,
  CheckCircle as CheckCircleIcon,
  AccountTree as AccountTreeIcon
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
      // silent dashboard fallback
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
    { title: 'Tickets Abiertos', value: String(openTickets), icon: <ChatIcon fontSize='large' />, color: '#3b82f6' },
    { title: 'Contactos', value: String(contacts.length), icon: <ContactsIcon fontSize='large' />, color: '#8b5cf6' },
    { title: 'WhatsApp', value: String(connections.length), icon: <WhatsAppIcon fontSize='large' />, color: '#10b981' },
    { title: 'Resueltos Hoy', value: String(closedToday), icon: <CheckCircleIcon fontSize='large' />, color: '#f59e0b' }
  ];

  const funnelCards = [
    { title: 'Funnel · Nuevo', value: funnel.nuevo, color: '#64748b' },
    { title: 'Funnel · Contactado', value: funnel.contactado, color: '#0ea5e9' },
    { title: 'Funnel · Calificado', value: funnel.calificado, color: '#a855f7' },
    { title: 'Funnel · Interesado', value: funnel.interesado, color: '#22c55e' }
  ];

  return (
    <Box>
      <Typography variant='h4' gutterBottom>
        Dashboard
      </Typography>

      <Grid container spacing={3} sx={{ mt: 1 }}>
        {stats.map((stat, index) => (
          <Grid item xs={12} sm={6} md={3} key={index}>
            <Card>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Box>
                    <Typography color='text.secondary' gutterBottom>
                      {stat.title}
                    </Typography>
                    <Typography variant='h4'>{stat.value}</Typography>
                  </Box>
                  <Box sx={{ color: stat.color }}>{stat.icon}</Box>
                </Box>
              </CardContent>
            </Card>
          </Grid>
        ))}
      </Grid>

      <Paper sx={{ mt: 3, p: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
          <AccountTreeIcon fontSize='small' />
          <Typography variant='h6'>Funnel unificado</Typography>
        </Box>
        <Grid container spacing={2}>
          {funnelCards.map((item) => (
            <Grid item xs={12} md={3} key={item.title}>
              <Paper variant='outlined' sx={{ p: 1.5 }}>
                <Typography variant='caption' color='text.secondary'>
                  {item.title}
                </Typography>
                <Typography variant='h5' sx={{ color: item.color }}>
                  {item.value}
                </Typography>
              </Paper>
            </Grid>
          ))}
        </Grid>
      </Paper>
    </Box>
  );
};

export default Dashboard;
