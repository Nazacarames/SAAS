import { useMemo, useEffect, useRef, useState } from 'react';
import { Typography, Box, Grid, Paper, Card, CardContent, Stack, Chip } from '@mui/material';
import {
  Chat as ChatIcon, Contacts as ContactsIcon, WhatsApp as WhatsAppIcon,
  CheckCircle as CheckCircleIcon, TrendingUp as TrendingUpIcon
} from '@mui/icons-material';
import { useQueryClient } from '@tanstack/react-query';
import { useConversations, useContacts, useChannels, useFunnelStats, useConversions, useCampanas } from '../../hooks/useApi';
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

const ESTADO_VENTA: Record<string, { label: string; color: string }> = {
  enviado: { label: 'avisada', color: '#34D399' },
  error: { label: 'rechazada por Meta', color: '#EF5350' },
  sin_pixel: { label: 'sin píxel', color: '#FB923C' },
  pendiente: { label: 'pendiente', color: 'rgba(255,255,255,0.35)' },
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
  const { data: connectionsRaw } = useChannels();
  const { data: funnel } = useFunnelStats();
  const { data: ventasRaw } = useConversions();
  const ventas = (ventasRaw as any) || null;
  const { data: campanasRaw } = useCampanas();
  const campanas: any[] = (campanasRaw as any)?.campanas || [];

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
      queryClient.invalidateQueries({ queryKey: ['conversions'] });
      queryClient.invalidateQueries({ queryKey: ['campanas'] });
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

  const activeChannels = connections.filter((c: any) => c.status === 'active');
  const channelRows = [
    { type: 'whatsapp',  label: 'WhatsApp' },
    { type: 'instagram', label: 'Instagram' },
    { type: 'messenger', label: 'Messenger' },
  ].map(({ type, label }) => {
    const n = activeChannels.filter((c: any) => c.channel_type === type).length;
    return n > 0
      ? { label, color: '#34D399', status: n > 1 ? `operational (${n})` : 'operational' }
      : { label, color: '#FB923C', status: 'sin conexión' };
  });
  const todayStr = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  // Estado del pixel: lo importante es que se vea cuando las ventas se estan
  // registrando pero no llegan a Meta, que es la falla silenciosa.
  const pixelEstado = !ventas?.pixel?.pixel_id ? 'píxel sin configurar'
    : ventas.con_error > 0 ? `${ventas.con_error} con error`
    : 'píxel conectado';
  const pixelColor = !ventas?.pixel?.pixel_id ? '#FB923C' : ventas.con_error > 0 ? '#EF5350' : '#34D399';

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
        <Grid item xs={6} lg={3}><StatCard title="Canales"           value={activeChannels.length} icon={<WhatsAppIcon sx={{ fontSize: '1.1rem' }} />} color="#34D399" delay={3} /></Grid>
        <Grid item xs={6} lg={3}><StatCard title="Resueltos hoy"     value={closedToday}    icon={<CheckCircleIcon sx={{ fontSize: '1.1rem' }} />}   color="#A78BFA" delay={4} /></Grid>
      </Grid>

      {/* Ventas cerradas + estado del aviso al pixel de Meta */}
      <Paper sx={{ p: 2.5, mb: 3 }} className="anim-fade-up anim-fade-up-5">
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} sx={{ mb: 2, gap: 1 }}>
          <Box>
            <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#E8EBF2' }}>
              Ventas cerradas
            </Typography>
            <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', mt: 0.25 }}>
              últimos {ventas?.dias || 30} días · se avisan al píxel de Meta al mover el lead a la etapa de cierre
            </Typography>
          </Box>
          {ventas && (
            <Stack direction="row" spacing={0.75} alignItems="center">
              <Box sx={{ width: 6, height: 6, borderRadius: '50%', background: pixelColor }} />
              <Typography sx={{ fontSize: '0.75rem', color: pixelColor, fontWeight: 500 }}>{pixelEstado}</Typography>
            </Stack>
          )}
        </Stack>

        <Stack direction="row" spacing={4} sx={{ mb: ventas?.ultimas?.length ? 2 : 0, flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Facturado</Typography>
            <Typography sx={{ fontSize: '1.9rem', fontWeight: 700, fontFamily: '"JetBrains Mono", monospace', color: '#34D399', lineHeight: 1.2 }}>
              {(ventas?.monto || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 })}
              <span style={{ fontSize: '0.85rem', opacity: 0.5, marginLeft: 6 }}>{ventas?.moneda || 'ARS'}</span>
            </Typography>
          </Box>
          <Box>
            <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Ventas</Typography>
            <Typography sx={{ fontSize: '1.9rem', fontWeight: 700, fontFamily: '"JetBrains Mono", monospace', color: '#E8EBF2', lineHeight: 1.2 }}>{ventas?.ventas || 0}</Typography>
          </Box>
          <Box>
            <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: 1, fontWeight: 600 }}>Avisadas al píxel</Typography>
            <Typography sx={{ fontSize: '1.9rem', fontWeight: 700, fontFamily: '"JetBrains Mono", monospace', color: '#60A5FA', lineHeight: 1.2 }}>{ventas?.enviadas || 0}</Typography>
          </Box>
        </Stack>

        {(ventas?.ultimas || []).map((u: any) => (
          <Stack key={u.id} direction="row" alignItems="center" justifyContent="space-between" sx={{ py: 0.9, borderTop: '1px solid rgba(255,255,255,0.05)', gap: 1 }}>
            <Box sx={{ minWidth: 0 }}>
              <Typography sx={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.75)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.contacto}</Typography>
              {u.detail && <Typography sx={{ fontSize: '0.66rem', color: '#FB923C' }}>{u.detail}</Typography>}
            </Box>
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexShrink: 0 }}>
              <Typography sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace', color: '#E8EBF2' }}>
                {u.value > 0 ? `${u.value.toLocaleString('es-AR', { maximumFractionDigits: 0 })} ${u.currency}` : 'sin monto'}
              </Typography>
              <Typography sx={{ fontSize: '0.66rem', color: ESTADO_VENTA[u.status]?.color || 'rgba(255,255,255,0.3)' }}>
                {ESTADO_VENTA[u.status]?.label || u.status}
              </Typography>
            </Stack>
          </Stack>
        ))}

        {ventas && ventas.ventas === 0 && (
          <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.3)', py: 1 }}>
            Todavía no se cerró ninguna venta en el pipeline.
          </Typography>
        )}
      </Paper>

      {/* De que pauta viene cada lead, y cual de esas pautas termina en venta */}
      {campanas.length > 0 && (
        <Paper sx={{ p: 2.5, mb: 3 }} className="anim-fade-up anim-fade-up-5">
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '0.95rem', color: '#E8EBF2' }}>
            Leads por campaña
          </Typography>
          <Typography sx={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.35)', mt: 0.25, mb: 2 }}>
            últimos 30 días · ordenado por ventas cerradas
          </Typography>
          <Stack direction="row" sx={{ pb: 0.75, borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
            <Typography sx={{ flexGrow: 1, fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 1 }}>Campaña</Typography>
            {['Leads', 'Score', 'Ventas', 'Monto'].map((h) => (
              <Typography key={h} sx={{ width: h === 'Monto' ? 110 : 60, textAlign: 'right', fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 1 }}>{h}</Typography>
            ))}
          </Stack>
          {campanas.map((c: any) => (
            <Stack key={c.campana} direction="row" alignItems="center" sx={{ py: 1, borderBottom: '1px solid rgba(255,255,255,0.04)', '&:last-child': { borderBottom: 0 } }}>
              <Typography title={c.campana} sx={{ flexGrow: 1, minWidth: 0, fontSize: '0.8rem', color: c.campana === 'Sin pauta identificada' ? 'rgba(255,255,255,0.35)' : '#E8EBF2', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', pr: 1 }}>
                {c.campana}
              </Typography>
              <Typography sx={{ width: 60, textAlign: 'right', fontSize: '0.8rem', fontFamily: '"JetBrains Mono", monospace', color: 'rgba(255,255,255,0.7)' }}>{c.leads}</Typography>
              {/* score promedio: dos campanas con los mismos leads no valen lo
                  mismo si una los trae tibios */}
              <Typography
                title="Score promedio de los leads de esta campana"
                sx={{ width: 60, textAlign: 'right', fontSize: '0.8rem', fontFamily: '"JetBrains Mono", monospace',
                      color: c.score >= 60 ? '#34D399' : c.score >= 30 ? '#E8A020' : 'rgba(255,255,255,0.4)' }}
              >
                {c.score > 0 ? c.score : '-'}
              </Typography>
              <Typography sx={{ width: 60, textAlign: 'right', fontSize: '0.8rem', fontFamily: '"JetBrains Mono", monospace', color: c.ventas > 0 ? '#34D399' : 'rgba(255,255,255,0.25)' }}>{c.ventas}</Typography>
              <Typography sx={{ width: 110, textAlign: 'right', fontSize: '0.8rem', fontFamily: '"JetBrains Mono", monospace', color: c.monto > 0 ? '#34D399' : 'rgba(255,255,255,0.25)' }}>
                {c.monto > 0 ? c.monto.toLocaleString('es-AR', { maximumFractionDigits: 0 }) : '—'}
              </Typography>
            </Stack>
          ))}
        </Paper>
      )}

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
              {[...systemServices, ...channelRows].map((item) => (
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