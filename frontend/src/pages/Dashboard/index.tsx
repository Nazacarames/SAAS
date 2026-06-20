import { useMemo, useEffect, useRef, useState } from 'react';
import { Typography, Box, Grid, Paper, Card, CardContent, Stack, Chip } from '@mui/material';
import {
  Chat as ChatIcon, Contacts as ContactsIcon, WhatsApp as WhatsAppIcon,
  CheckCircle as CheckCircleIcon, TrendingUp as TrendingUpIcon
} from '@mui/icons-material';
import { useQueryClient } from '@tanstack/react-query';
import { useConversations, useContacts, useWhatsapps, useFunnelStats } from '../../hooks/useApi';
import { socketConnection } from '../../services/socket';

function useCountUp(target: number, duration = 900) {
  const [value, setValue] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    if (target === prev.current) return;
    prev.current = target;
    const start = Date.now();
    const tick = () => {
      const p = Math.min((Date.now() - start) / duration, 1);
      const e = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(target * e));
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [target, duration]);
  return value;
}

const StatCard = ({ title, value, icon, color, delay }: {
  title: string; value: number; icon: React.ReactNode; color: string; delay: number;
}) => {
  const displayed = useCountUp(value);
  const cls = `anim-fade-up anim-fade-up-${delay}`;
  return (
    <Card className={cls}>
      <CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box>
            <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.40)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600, mb: 1 }}>
              {title}
            </Typography>
            <Typography sx={{ fontSize: '2rem', fontWeight: 700, fontFamily: '"JetBrains Mono", monospace', color: '#E8EBF2', lineHeight: 1 }}>
              {displayed.toLocaleString()}
            </Typography>
          </Box>
          <Box sx={{ width: 40, height: 40, borderRadius: '10px', bgcolor: color + '18', border: '1px solid ' + color + '30', display: 'flex', alignItems: 'center', justifyContent: 'center', color: color, flexShrink: 0 }}>
            {icon}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
};

const FunnelBar = ({ title, value, total, color, delay }: {
  title: string; value: number; total: number; color: string; delay: number;
}) => {
  const displayed = useCountUp(value, 700);
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const cls = `anim-fade-up anim-fade-up-${delay}`;
  return (
    <Box className={cls}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 0.75 }}>
        <Typography sx={{ fontSize: '0.8rem', fontWeight: 500, color: 'rgba(255,255,255,0.65)' }}>{title}</Typography>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.30)', fontFamily: '"JetBrains Mono", monospace' }}>{pct}%</Typography>
          <Typography sx={{ fontSize: '0.95rem', fontWeight: 700, fontFamily: '"JetBrains Mono", monospace', color: '#E8EBF2', minWidth: 28, textAlign: 'right' }}>{displayed}</Typography>
        </Stack>
      </Stack>
      <Box sx={{ height: 4, borderRadius: 99, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
        <Box sx={{ height: '100%', borderRadius: 99, background: color, width: pct + '%', transition: 'width 0.85s cubic-bezier(0.4,0,0.2,1)', boxShadow: '0 0 6px ' + color + '60' }} />
      </Box>
    </Box>
  );
};

const systemServices = [
  { label: 'API Backend',   color: '#34D399', status: 'operational' },
  { label: 'Agente IA',     color: '#34D399', status: 'operational' },
  { label: 'Meta Lead Ads', color: '#34D399', status: 'operational' },
];

const Dashboard = () => {
  const queryClient = useQueryClient();
  const { data: ticketsRaw } = useConversations();
  const { data: contactsRaw } = useContacts();
  const { data: connectionsRaw } = useWhatsapps();
  const { data: funnel } = useFunnelStats();

  const tickets    = Array.isArray(ticketsRaw) ? ticketsRaw : Array.isArray((ticketsRaw as any)?.data) ? (ticketsRaw as any).data : [];
  const contacts   = Array.isArray(contactsRaw) ? contactsRaw : Array.isArray((contactsRaw as any)?.data) ? (contactsRaw as any).data : [];
  const connections = Array.isArray(connectionsRaw) ? connectionsRaw : [];
  const funnelData = (funnel as any) || { nuevo: 0, contactado: 0, calificado: 0, interesado: 0 };

  useEffect(() => {
    const socket = socketConnection.connect();
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['funnel-stats'] });
    };
    if (socket) { socket.on('newMessage', refresh); socket.on('ticketUpdate', refresh); }
    return () => { if (socket) { socket.off('newMessage', refresh); socket.off('ticketUpdate', refresh); } };
  }, [queryClient]);

  const openTickets = tickets.filter((x: any) => x.status === 'open' || x.status === 'pending').length;
  const closedToday = tickets.filter((x: any) => {
    if (x.status !== 'closed') return false;
    const d = new Date(x.updatedAt || x.createdAt);
    return d.toDateString() === new Date().toDateString();
  }).length;

  const funnelTotal = useMemo(
    () => funnelData.nuevo + funnelData.contactado + funnelData.calificado + funnelData.interesado,
    [funnelData]
  );

  const funnelStages = [
    { title: 'Interesado',  value: funnelData.interesado, color: '#34D399' },
    { title: 'Calificado',  value: funnelData.calificado, color: '#E8A020' },
    { title: 'Contactado',  value: funnelData.contactado, color: '#60A5FA' },
    { title: 'Nuevo',       value: funnelData.nuevo,      color: '#8A8FA0' },
  ];

  const waStatus = connections.length > 0 ? 'operational' : 'sin conexion';
  const waColor  = connections.length > 0 ? '#34D399'     : '#FB923C';
  const todayStr = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} sx={{ mb: 3, gap: 1 }} className="anim-fade-up">
        <Box>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2', mb: 0.25 }}>
            Dashboard
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box className="live-dot" />
            <Typography sx={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.35)', textTransform: 'capitalize' }}>{todayStr}</Typography>
          </Stack>
        </Box>
        <Chip icon={<TrendingUpIcon sx={{ fontSize: '0.85rem !important' }} />} label="Tiempo real" size="small" color="primary" variant="outlined" />
      </Stack>

      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={6} lg={3}><StatCard title="Tickets abiertos" value={openTickets}      icon={<ChatIcon sx={{ fontSize: '1.1rem' }} />}         color="#60A5FA" delay={1} /></Grid>
        <Grid item xs={6} lg={3}><StatCard title="Contactos"         value={contacts.length} icon={<ContactsIcon sx={{ fontSize: '1.1rem' }} />}     color="#E8A020" delay={2} /></Grid>
        <Grid item xs={6} lg={3}><StatCard title="Canales WA"        value={connections.length} icon={<WhatsAppIcon sx={{ fontSize: '1.1rem' }} />} color="#34D399" delay={3} /></Grid>
        <Grid item xs={6} lg={3}><StatCard title="Resueltos hoy"     value={closedToday}    icon={<CheckCircleIcon sx={{ fontSize: '1.1rem' }} />}   color="#A78BFA" delay={4} /></Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2.5 }} className="anim-fade-up anim-fade-up-5">
            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2.5 }}>
              <Box>
                <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#E8EBF2' }}>Funnel comercial</Typography>
                <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', mt: 0.25 }}>{funnelTotal} contactos en total</Typography>
              </Box>
              <Box sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.7rem', color: 'rgba(255,255,255,0.25)', px: 1, py: 0.4, borderRadius: '5px', border: '1px solid rgba(255,255,255,0.07)' }}>
                {funnelTotal > 0 ? funnelData.interesado + ' hot' : 'sin datos'}
              </Box>
            </Stack>
            <Stack spacing={2.5}>
              {funnelStages.map((s, i) => (
                <FunnelBar key={s.title} title={s.title} value={s.value} total={funnelTotal} color={s.color} delay={i + 1} />
              ))}
            </Stack>
          </Paper>
        </Grid>

        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2.5 }} className="anim-fade-up anim-fade-up-6">
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#E8EBF2', mb: 2.5 }}>Estado del sistema</Typography>
            <Stack spacing={0}>
              {[...systemServices, { label: 'WhatsApp Cloud', color: waColor, status: waStatus }].map((item) => (
                <Stack key={item.label} direction="row" alignItems="center" justifyContent="space-between" sx={{ py: 1.2, borderBottom: '1px solid rgba(255,255,255,0.05)', '&:last-child': { borderBottom: 0 } }}>
                  <Typography sx={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.65)' }}>{item.label}</Typography>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <Box sx={{ width: 6, height: 6, borderRadius: '50%', background: item.color, boxShadow: item.color === '#34D399' ? '0 0 5px rgba(52,211,153,0.5)' : 'none' }} />
                    <Typography sx={{ fontSize: '0.75rem', color: item.color, fontWeight: 500 }}>{item.status}</Typography>
                  </Stack>
                </Stack>
              ))}
            </Stack>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};

export default Dashboard;