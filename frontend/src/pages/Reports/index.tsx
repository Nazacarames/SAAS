import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Stack,
  TextField,
  Button,
  Grid,
  Chip,
  Divider,
  Tooltip
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const AMBER = '#E8A020';
const GREEN = '#4AB87A';
const EASE = 'cubic-bezier(0.23, 1, 0.32, 1)';

// Animated counter: counts up on value change with rAF + cubic ease-out
const useCountUp = (target: number, durationMs = 700) => {
  const [value, setValue] = useState(0);
  const raf = useRef(0);
  useEffect(() => {
    const start = performance.now();
    const from = 0;
    cancelAnimationFrame(raf.current);
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, durationMs]);
  return value;
};

const StatCard = ({ label, value, accent = false, delay = 1 }: { label: string; value: number; accent?: boolean; delay?: number }) => {
  const display = useCountUp(value);
  return (
    <Paper className={`anim-fade-up anim-fade-up-${delay}`} sx={{ p: 2.5 }}>
      <Typography variant='caption' color='text.secondary' sx={{ textTransform: 'uppercase', letterSpacing: 0.8, fontSize: '0.65rem' }}>
        {label}
      </Typography>
      <Typography variant='h4' sx={{ mt: 0.5, fontWeight: 700, fontFamily: '"Syne", sans-serif', color: accent ? AMBER : 'inherit' }}>
        {display}
      </Typography>
    </Paper>
  );
};

// Horizontal funnel bar: width animates in, mono value at right
const FunnelBar = ({ label, value, max, color = AMBER, hint }: { label: string; value: number; max: number; color?: string; hint?: string }) => {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setWidth(pct), 60);
    return () => clearTimeout(t);
  }, [pct]);
  return (
    <Box sx={{ mb: 1.8 }}>
      <Stack direction='row' justifyContent='space-between' sx={{ mb: 0.5 }}>
        <Tooltip title={hint || ''} placement='top-start'>
          <Typography variant='body2' sx={{ fontWeight: 600 }}>{label}</Typography>
        </Tooltip>
        <Typography variant='body2' sx={{ fontFamily: '"JetBrains Mono", monospace', color, fontSize: '0.8rem' }}>{value}</Typography>
      </Stack>
      <Box sx={{ height: 8, borderRadius: 99, bgcolor: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
        <Box sx={{ height: '100%', width: `${width}%`, borderRadius: 99, background: `linear-gradient(90deg, ${color}66 0%, ${color} 100%)`, transition: `width 800ms ${EASE}` }} />
      </Box>
    </Box>
  );
};

// Mini bar chart for the daily timeline (pure CSS, no chart lib)
const TimelineChart = ({ data }: { data: Array<{ day: string; leads: number }> }) => {
  const max = Math.max(1, ...data.map((d) => Number(d.leads) || 0));
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 80);
    return () => clearTimeout(t);
  }, []);
  if (data.length === 0) {
    return <Typography variant='body2' color='text.secondary' sx={{ py: 4, textAlign: 'center' }}>Sin datos en el período.</Typography>;
  }
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: 140, mt: 2 }}>
      {data.map((d, i) => {
        const h = Math.max(3, Math.round((Number(d.leads) / max) * 100));
        const dayLabel = String(d.day).slice(5); // MM-DD
        return (
          <Tooltip key={d.day} title={`${d.day}: ${d.leads} leads`} placement='top'>
            <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, minWidth: 0, height: '100%', justifyContent: 'flex-end' }}>
              <Box sx={{
                width: '100%',
                maxWidth: 26,
                height: mounted ? `${h}%` : '0%',
                borderRadius: '4px 4px 0 0',
                background: Number(d.leads) > 0 ? `linear-gradient(180deg, ${AMBER} 0%, ${AMBER}55 100%)` : 'rgba(255,255,255,0.06)',
                transition: `height 600ms ${EASE} ${i * 18}ms`,
                cursor: 'default'
              }} />
              {data.length <= 16 && (
                <Typography variant='caption' sx={{ fontSize: '0.55rem', fontFamily: '"JetBrains Mono", monospace', color: 'text.secondary', whiteSpace: 'nowrap' }}>
                  {dayLabel}
                </Typography>
              )}
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
};

// Ranked horizontal bars for source/campaign/form breakdowns
const RankedBars = ({ title, rows, keyField, valueField = 'leads', labelField }: { title: string; rows: any[]; keyField: string; valueField?: string; labelField?: string }) => {
  const max = Math.max(1, ...rows.map((r) => Number(r[valueField]) || 0));
  return (
    <Paper sx={{ p: 2.5, height: '100%' }}>
      <Typography variant='h6' sx={{ mb: 1.5, fontSize: '1rem' }}>{title}</Typography>
      {rows.length === 0 ? (
        <Typography variant='body2' color='text.secondary'>Sin datos.</Typography>
      ) : (
        <Stack spacing={1.2}>
          {rows.slice(0, 8).map((r) => {
            const v = Number(r[valueField]) || 0;
            const label = String(r[labelField || keyField] || r[keyField] || 'desconocido');
            return (
              <Box key={String(r[keyField]) + label}>
                <Stack direction='row' justifyContent='space-between' sx={{ mb: 0.3 }}>
                  <Typography variant='caption' noWrap sx={{ maxWidth: '75%' }}>{label}</Typography>
                  <Typography variant='caption' sx={{ fontFamily: '"JetBrains Mono", monospace', color: AMBER }}>{v}</Typography>
                </Stack>
                <Box sx={{ height: 5, borderRadius: 99, bgcolor: 'rgba(255,255,255,0.05)', overflow: 'hidden' }}>
                  <Box sx={{ height: '100%', width: `${Math.max(2, (v / max) * 100)}%`, borderRadius: 99, bgcolor: 'rgba(232,160,32,0.55)', transition: `width 600ms ${EASE}` }} />
                </Box>
              </Box>
            );
          })}
        </Stack>
      )}
    </Paper>
  );
};

const Reports = () => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState('');
  const [campaign, setCampaign] = useState('');
  const [form, setForm] = useState('');
  const [data, setData] = useState<any>({ summary: {}, lifecycleBreakdown: [], bySource: [], byCampaign: [], byForm: [], timeline: [] });
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/ai/reports/attribution', { params: { from, to, source, campaign, form } });
      setData(data || { summary: {}, lifecycleBreakdown: [], bySource: [], byCampaign: [], byForm: [], timeline: [] });
    } catch {
      toast.error('No se pudo cargar reportes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const s = data.summary || {};
  const received = Number(s.received_events ?? s.total_leads ?? 0);
  const converted = Number(s.converted_contacts ?? 0);
  const withConv = Number(s.with_conversation ?? 0);
  const funnelMax = Math.max(received, 1);
  const convRate = received > 0 ? Math.round((converted / received) * 100) : 0;

  const timeline = useMemo(() => (data.timeline || []).map((r: any) => ({ day: String(r.day), leads: Number(r.leads) || 0 })), [data.timeline]);

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Reportes</Typography>
      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
        Del anuncio en Meta a la conversación en el CRM: dónde se ganan y se pierden tus leads.
      </Typography>

      <Paper className='anim-fade-up anim-fade-up-1' sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
          <TextField label='Desde' type='date' size='small' value={from} onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label='Hasta' type='date' size='small' value={to} onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label='Origen' size='small' value={source} onChange={(e) => setSource(e.target.value)} placeholder='meta_lead_ads' />
          <TextField label='Campaña' size='small' value={campaign} onChange={(e) => setCampaign(e.target.value)} />
          <TextField label='Formulario' size='small' value={form} onChange={(e) => setForm(e.target.value)} />
          <Button variant='contained' onClick={load} disabled={loading}>{loading ? 'Cargando...' : 'Filtrar'}</Button>
        </Stack>
      </Paper>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><StatCard label='Eventos recibidos' value={received} delay={1} /></Grid>
        <Grid item xs={6} md={3}><StatCard label='Convertidos a contacto' value={converted} accent delay={2} /></Grid>
        <Grid item xs={6} md={3}><StatCard label='Con conversación' value={withConv} delay={3} /></Grid>
        <Grid item xs={6} md={3}><StatCard label='Tasa de conversión %' value={convRate} accent delay={4} /></Grid>
      </Grid>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} md={7}>
          <Paper className='anim-fade-up anim-fade-up-3' sx={{ p: 2.5, height: '100%' }}>
            <Typography variant='h6' sx={{ mb: 2, fontSize: '1rem' }}>Embudo de conversión</Typography>
            <FunnelBar label='Eventos recibidos de Meta' value={received} max={funnelMax} hint='Leads que llegaron al webhook' />
            <FunnelBar label='Convertidos a contacto' value={converted} max={funnelMax} hint='Con teléfono o email válido' />
            <FunnelBar label='Con conversación abierta' value={withConv} max={funnelMax} color={GREEN} hint='Contacto + ticket en el CRM' />
            <Divider sx={{ my: 2 }} />
            <Stack direction='row' spacing={1} flexWrap='wrap' useFlexGap>
              <Chip size='small' variant='outlined' label={`Sin teléfono: ${s.no_phone ?? 0}`} />
              <Chip size='small' variant='outlined' label={`Teléfonos únicos: ${s.unique_phones ?? 0}`} />
              <Chip size='small' variant='outlined' label={`Campañas: ${s.campaigns ?? 0}`} />
              <Chip size='small' variant='outlined' label={`Formularios: ${s.forms ?? 0}`} />
            </Stack>
          </Paper>
        </Grid>
        <Grid item xs={12} md={5}>
          <Paper className='anim-fade-up anim-fade-up-4' sx={{ p: 2.5, height: '100%' }}>
            <Typography variant='h6' sx={{ mb: 1, fontSize: '1rem' }}>¿Por qué se pierden leads?</Typography>
            <Stack spacing={1.2} sx={{ mt: 1.5 }}>
              <Box sx={{ p: 1.5, borderRadius: 2, border: '1px solid rgba(248,113,113,0.25)', bgcolor: 'rgba(248,113,113,0.05)' }}>
                <Stack direction='row' justifyContent='space-between' alignItems='center'>
                  <Typography variant='subtitle2'>Llegaron sin teléfono</Typography>
                  <Typography sx={{ fontFamily: '"JetBrains Mono", monospace', color: '#F87171', fontWeight: 600 }}>{s.no_phone ?? 0}</Typography>
                </Stack>
                <Typography variant='caption' color='text.secondary'>
                  Meta no envió número: no se puede iniciar conversación automática. Revisá que el formulario pida teléfono obligatorio.
                </Typography>
              </Box>
              <Box sx={{ p: 1.5, borderRadius: 2, border: '1px solid rgba(251,146,60,0.25)', bgcolor: 'rgba(251,146,60,0.05)' }}>
                <Stack direction='row' justifyContent='space-between' alignItems='center'>
                  <Typography variant='subtitle2'>Otros no convertidos</Typography>
                  <Typography sx={{ fontFamily: '"JetBrains Mono", monospace', color: '#FB923C', fontWeight: 600 }}>
                    {Math.max(0, (s.not_converted ?? 0) - (s.no_phone ?? 0))}
                  </Typography>
                </Stack>
                <Typography variant='caption' color='text.secondary'>
                  Datos incompletos o sin match con contacto existente.
                </Typography>
              </Box>
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Paper className='anim-fade-up anim-fade-up-5' sx={{ p: 2.5, mb: 2 }}>
        <Stack direction='row' justifyContent='space-between' alignItems='center'>
          <Typography variant='h6' sx={{ fontSize: '1rem' }}>Tendencia diaria</Typography>
          <Typography variant='caption' color='text.secondary' sx={{ fontFamily: '"JetBrains Mono", monospace' }}>
            últimos {timeline.length} días
          </Typography>
        </Stack>
        <TimelineChart data={timeline} />
      </Paper>

      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <RankedBars title='Por origen' rows={data.bySource || []} keyField='source' />
        </Grid>
        <Grid item xs={12} md={4}>
          <RankedBars title='Por campaña' rows={data.byCampaign || []} keyField='campaign' />
        </Grid>
        <Grid item xs={12} md={4}>
          <RankedBars title='Por formulario' rows={(data.byForm || []).map((r: any) => ({ ...r, _label: r.formName || r.form || 'desconocido' }))} keyField='formId' labelField='_label' />
        </Grid>
      </Grid>
    </Box>
  );
};

export default Reports;
