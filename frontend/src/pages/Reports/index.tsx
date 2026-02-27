import { useEffect, useMemo, useState } from 'react';
import { Box, Typography, Paper, Stack, Grid, TextField, MenuItem, Button, Table, TableHead, TableRow, TableCell, TableBody } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const Reports = () => {
  const [source, setSource] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<any>({ totals: {}, bySource: [], byCampaign: [], byForm: [] });

  const load = async () => {
    try {
      const { data } = await api.get('/ai/reports/leads', { params: { source, from, to } });
      setData(data || { totals: {}, bySource: [], byCampaign: [], byForm: [] });
    } catch {
      toast.error('No se pudieron cargar reportes');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const cards = useMemo(
    () => [
      { title: 'Leads totales', value: data?.totals?.totalLeads || 0 },
      { title: 'Con campaña', value: data?.totals?.withCampaign || 0 },
      { title: 'Con formulario', value: data?.totals?.withForm || 0 },
      { title: 'Contactados', value: data?.totals?.withTicket || 0 }
    ],
    [data]
  );

  return (
    <Box>
      <Typography variant='h4' gutterBottom>
        Reportes
      </Typography>
      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>
        Atribución de leads por origen, campaña y formulario.
      </Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction='row' spacing={1.5}>
          <TextField select label='Origen' value={source} onChange={(e) => setSource(e.target.value)} sx={{ minWidth: 180 }}>
            <MenuItem value=''>Todos</MenuItem>
            <MenuItem value='meta_lead_ads'>Meta Lead Ads</MenuItem>
            <MenuItem value='whatsapp'>WhatsApp</MenuItem>
          </TextField>
          <TextField type='date' label='Desde' InputLabelProps={{ shrink: true }} value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField type='date' label='Hasta' InputLabelProps={{ shrink: true }} value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant='contained' onClick={load}>
            Aplicar
          </Button>
        </Stack>
      </Paper>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        {cards.map((c) => (
          <Grid key={c.title} item xs={12} md={3}>
            <Paper sx={{ p: 2 }}>
              <Typography variant='caption'>{c.title}</Typography>
              <Typography variant='h5'>{c.value}</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Grid container spacing={2}>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant='h6'>Por origen</Typography>
            <Table size='small'>
              <TableHead>
                <TableRow>
                  <TableCell>Origen</TableCell>
                  <TableCell align='right'>Leads</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data.bySource || []).map((r: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell>{r.source || 'sin_dato'}</TableCell>
                    <TableCell align='right'>{r.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant='h6'>Por campaña</Typography>
            <Table size='small'>
              <TableHead>
                <TableRow>
                  <TableCell>Campaña</TableCell>
                  <TableCell align='right'>Leads</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data.byCampaign || []).map((r: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell>{r.campaign_id || 'sin_dato'}</TableCell>
                    <TableCell align='right'>{r.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
        <Grid item xs={12} md={4}>
          <Paper sx={{ p: 2 }}>
            <Typography variant='h6'>Por formulario</Typography>
            <Table size='small'>
              <TableHead>
                <TableRow>
                  <TableCell>Formulario</TableCell>
                  <TableCell align='right'>Leads</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data.byForm || []).map((r: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell>{r.form_id || 'sin_dato'}</TableCell>
                    <TableCell align='right'>{r.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Grid>
      </Grid>
    </Box>
  );
};

export default Reports;
