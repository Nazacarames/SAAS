import { useEffect, useState } from 'react';
import {
  Box,
  Typography,
  Paper,
  Stack,
  TextField,
  Button,
  Grid,
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  Chip,
  Divider
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const Reports = () => {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [source, setSource] = useState('');
  const [campaign, setCampaign] = useState('');
  const [form, setForm] = useState('');
  const [data, setData] = useState<any>({ summary: {}, lifecycleBreakdown: [], bySource: [], byCampaign: [], byForm: [], timeline: [] });

  const load = async () => {
    try {
      const { data } = await api.get('/ai/reports/attribution', { params: { from, to, source, campaign, form } });
      setData(data || { summary: {}, lifecycleBreakdown: [], bySource: [], byCampaign: [], byForm: [], timeline: [] });
    } catch {
      toast.error('No se pudo cargar reportes');
    }
  };

  useEffect(() => { load(); }, []);

  const mainCards = [
    { label: 'Eventos recibidos', value: data.summary?.received_events ?? data.summary?.total_leads ?? 0 },
    { label: 'Convertidos a contacto', value: data.summary?.converted_contacts ?? 0 },
    { label: 'No convertidos', value: data.summary?.not_converted ?? 0 },
    { label: 'Con conversación', value: data.summary?.with_conversation ?? 0 }
  ];

  const secondaryCards = [
    { label: 'Sin teléfono', value: data.summary?.no_phone ?? 0 },
    { label: 'Teléfonos únicos', value: data.summary?.unique_phones || 0 },
    { label: 'Campañas', value: data.summary?.campaigns || 0 },
    { label: 'Formularios', value: data.summary?.forms || 0 }
  ];

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Reportes</Typography>
      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
        Estado del embudo desde evento recibido en Meta hasta contacto/conversación en CRM.
      </Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.25}>
          <TextField label='Desde' type='date' value={from} onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label='Hasta' type='date' value={to} onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label='Origen' value={source} onChange={(e) => setSource(e.target.value)} placeholder='meta_lead_ads' />
          <TextField label='Campaña' value={campaign} onChange={(e) => setCampaign(e.target.value)} />
          <TextField label='Formulario' value={form} onChange={(e) => setForm(e.target.value)} />
          <Button variant='contained' onClick={load}>Filtrar</Button>
        </Stack>
      </Paper>

      <Grid container spacing={2} sx={{ mb: 1.5 }}>
        {mainCards.map((c) => (
          <Grid item xs={12} sm={6} md={3} key={c.label}>
            <Paper sx={{ p: 2, minHeight: 104, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
              <Typography variant='caption' color='text.secondary'>{c.label}</Typography>
              <Typography variant='h4' sx={{ mt: 0.5, fontWeight: 700 }}>{c.value}</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Paper sx={{ p: 1.5, mb: 2 }}>
        <Stack direction='row' spacing={1} useFlexGap flexWrap='wrap'>
          {secondaryCards.map((c) => (
            <Chip key={c.label} label={`${c.label}: ${c.value}`} variant='outlined' />
          ))}
        </Stack>
      </Paper>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2, height: '100%' }}>
            <Typography variant='h6' sx={{ mb: 1 }}>Estado de conversión</Typography>
            <Divider sx={{ mb: 1 }} />
            <Table size='small'>
              <TableHead>
                <TableRow>
                  <TableCell>Estado</TableCell>
                  <TableCell align='right'>Cantidad</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data.lifecycleBreakdown || []).map((r: any) => (
                  <TableRow key={r.key || r.label}>
                    <TableCell>{r.label}</TableCell>
                    <TableCell align='right'>{r.value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>

        <Grid item xs={12} md={6}>
          <Paper sx={{ p: 2, height: '100%' }}>
            <Typography variant='h6' sx={{ mb: 1 }}>¿Por qué no se convierten?</Typography>
            <Divider sx={{ mb: 1 }} />
            <Stack spacing={1}>
              <Paper variant='outlined' sx={{ p: 1.2 }}>
                <Typography variant='subtitle2'>Sin teléfono</Typography>
                <Typography variant='body2' color='text.secondary'>
                  {data.summary?.no_phone ?? 0} evento(s): Meta envió lead sin número, entonces no se puede crear conversación automática.
                </Typography>
              </Paper>
              <Paper variant='outlined' sx={{ p: 1.2 }}>
                <Typography variant='subtitle2'>Otros no convertidos</Typography>
                <Typography variant='body2' color='text.secondary'>
                  {Math.max(0, (data.summary?.not_converted ?? 0) - (data.summary?.no_phone ?? 0))} evento(s): llegaron al webhook, pero no terminaron como contacto por datos incompletos o falta de match.
                </Typography>
              </Paper>
              <Typography variant='caption' color='text.secondary'>
                Con conversación = contacto creado + ticket abierto en CRM.
              </Typography>
            </Stack>
          </Paper>
        </Grid>
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2, height: '100%' }}>
            <Typography variant='h6'>Por Origen</Typography>
            <Table size='small'>
              <TableHead><TableRow><TableCell>Origen</TableCell><TableCell align='right'>Leads</TableCell></TableRow></TableHead>
              <TableBody>{(data.bySource || []).map((r: any) => <TableRow key={r.source}><TableCell>{r.source}</TableCell><TableCell align='right'>{r.leads}</TableCell></TableRow>)}</TableBody>
            </Table>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2, height: '100%' }}>
            <Typography variant='h6'>Por Campaña</Typography>
            <Table size='small'>
              <TableHead><TableRow><TableCell>Campaña</TableCell><TableCell align='right'>Leads</TableCell></TableRow></TableHead>
              <TableBody>{(data.byCampaign || []).map((r: any) => <TableRow key={r.campaign}><TableCell>{r.campaign}</TableCell><TableCell align='right'>{r.leads}</TableCell></TableRow>)}</TableBody>
            </Table>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2, height: '100%' }}>
            <Typography variant='h6'>Por Formulario</Typography>
            <Table size='small'>
              <TableHead><TableRow><TableCell>Formulario</TableCell><TableCell align='right'>Leads</TableCell></TableRow></TableHead>
              <TableBody>
                {(data.byForm || []).map((r: any) => (
                  <TableRow key={`${r.form || 'unknown'}-${r.formId || ''}`}>
                    <TableCell>
                      {r.formName || r.form || 'unknown'}
                      {r.formId && r.formName ? (
                        <Typography variant='caption' color='text.secondary' sx={{ display: 'block' }}>
                          ID: {r.formId}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell align='right'>{r.leads}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
      </Grid>

      <Paper sx={{ p: 2, mt: 2 }}>
        <Typography variant='h6'>Tendencia diaria (31 días)</Typography>
        <Table size='small'>
          <TableHead><TableRow><TableCell>Día</TableCell><TableCell align='right'>Leads</TableCell></TableRow></TableHead>
          <TableBody>{(data.timeline || []).map((r: any) => <TableRow key={r.day}><TableCell>{r.day}</TableCell><TableCell align='right'>{r.leads}</TableCell></TableRow>)}</TableBody>
        </Table>
      </Paper>
    </Box>
  );
};

export default Reports;
