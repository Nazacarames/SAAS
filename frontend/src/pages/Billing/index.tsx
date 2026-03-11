import { useEffect, useState } from 'react';
import { Box, Typography, Paper, Button, Stack, Chip, Table, TableHead, TableRow, TableCell, TableBody } from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const Billing = () => {
  const [data, setData] = useState<any>({ subscription: null, transactions: [] });
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const { data } = await api.get('/billing/status');
    setData(data || { subscription: null, transactions: [] });
  };

  useEffect(() => { load().catch(() => toast.error('No se pudo cargar billing')); }, []);

  const startCheckout = async () => {
    setLoading(true);
    try {
      const { data } = await api.post('/billing/checkout', { planCode: 'pro_monthly' });
      toast.success('Orden de pago creada (sandbox)');
      if (data?.checkoutUrl) window.open(data.checkoutUrl, '_blank');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.error || 'No se pudo crear checkout');
    } finally {
      setLoading(false);
    }
  };

  const s = data.subscription;

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Billing</Typography>
      <Typography variant='body2' color='text.secondary' sx={{ mb: 2 }}>Suscripción, trial y pagos Skrill.</Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        {s ? (
          <Stack spacing={1}>
            <Stack direction='row' spacing={1}>
              <Chip label={`Plan: ${s.planName || s.planCode || '-'}`} />
              <Chip color={s.status === 'active' ? 'success' : 'warning'} label={`Estado: ${s.status}`} />
            </Stack>
            <Typography variant='body2'>Trial termina: {s.trialEndsAt ? new Date(s.trialEndsAt).toLocaleString() : '-'}</Typography>
            <Typography variant='body2'>Periodo actual: {s.currentPeriodStart ? new Date(s.currentPeriodStart).toLocaleDateString() : '-'} → {s.currentPeriodEnd ? new Date(s.currentPeriodEnd).toLocaleDateString() : '-'}</Typography>
            <Button variant='contained' onClick={startCheckout} disabled={loading}>{loading ? 'Generando...' : 'Upgrade a Pro (Skrill sandbox)'}</Button>
          </Stack>
        ) : (
          <Typography variant='body2'>No hay suscripción activa para esta empresa.</Typography>
        )}
      </Paper>

      <Paper sx={{ p: 2 }}>
        <Typography variant='h6' sx={{ mb: 1 }}>Transacciones</Typography>
        <Table size='small'>
          <TableHead>
            <TableRow>
              <TableCell>ID</TableCell>
              <TableCell>Estado</TableCell>
              <TableCell>Monto</TableCell>
              <TableCell>Moneda</TableCell>
              <TableCell>Provider Tx</TableCell>
              <TableCell>Fecha</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(data.transactions || []).map((t: any) => (
              <TableRow key={t.id}>
                <TableCell>{t.id}</TableCell>
                <TableCell>{t.status}</TableCell>
                <TableCell>{t.amount}</TableCell>
                <TableCell>{t.currency}</TableCell>
                <TableCell>{t.providerTransactionId || '-'}</TableCell>
                <TableCell>{t.createdAt ? new Date(t.createdAt).toLocaleString() : '-'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Paper>
    </Box>
  );
};

export default Billing;
