import { useEffect, useState } from 'react';
import {
  Box, Typography, Stack, Button, TextField, Paper, CircularProgress, Chip,
} from '@mui/material';
import { QRCodeSVG } from 'qrcode.react';
import { toast } from 'react-toastify';
import api from '../../services/api';

const Security = () => {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [setupUri, setSetupUri] = useState('');
  const [setupSecret, setSetupSecret] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const loadStatus = async () => {
    try {
      const { data } = await api.get('/auth/2fa/status');
      setEnabled(!!data.enabled);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadStatus(); }, []);

  const startSetup = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/auth/2fa/setup');
      setSetupUri(data.otpauth_uri);
      setSetupSecret(data.secret);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al iniciar 2FA');
    } finally { setBusy(false); }
  };

  const confirmEnable = async () => {
    setBusy(true);
    try {
      await api.post('/auth/2fa/enable', { code: code.trim() });
      toast.success('2FA activado. Tu cuenta está más protegida.');
      setSetupUri(''); setSetupSecret(''); setCode('');
      setEnabled(true);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Código inválido');
    } finally { setBusy(false); }
  };

  const disable = async () => {
    const c = prompt('Ingresá un código de tu app de autenticación para desactivar 2FA:');
    if (!c) return;
    setBusy(true);
    try {
      await api.post('/auth/2fa/disable', { code: c.trim() });
      toast.success('2FA desactivado');
      setEnabled(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Código inválido');
    } finally { setBusy(false); }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: '#E8A020' }} /></Box>;
  }

  return (
    <Box sx={{ maxWidth: 620, mx: 'auto' }}>
      <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2', mb: 0.5 }}>
        Seguridad
      </Typography>
      <Typography sx={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.4)', mb: 3 }}>
        Verificación en dos pasos (2FA) para tu cuenta
      </Typography>

      <Paper sx={{ p: 3, borderRadius: '12px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
          <Box>
            <Typography sx={{ fontWeight: 600, color: '#E8EBF2', fontSize: '1rem' }}>Autenticación en dos pasos</Typography>
            <Typography sx={{ fontSize: '0.8rem', color: 'rgba(255,255,255,0.4)' }}>
              Con Google Authenticator, Authy o 1Password
            </Typography>
          </Box>
          <Chip
            label={enabled ? 'Activo' : 'Inactivo'}
            sx={{
              fontWeight: 600,
              backgroundColor: enabled ? 'rgba(52,211,153,0.15)' : 'rgba(255,255,255,0.08)',
              color: enabled ? '#34D399' : 'rgba(255,255,255,0.5)',
            }}
          />
        </Stack>

        {enabled ? (
          <Button variant="outlined" color="error" onClick={disable} disabled={busy}
            sx={{ borderColor: 'rgba(239,83,80,0.4)', color: '#EF5350' }}>
            Desactivar 2FA
          </Button>
        ) : !setupUri ? (
          <Button variant="contained" onClick={startSetup} disabled={busy}>
            {busy ? <CircularProgress size={18} /> : 'Activar 2FA'}
          </Button>
        ) : (
          <Box>
            <Typography sx={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', mb: 2 }}>
              1. Escaneá este código QR con tu app de autenticación:
            </Typography>
            <Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
              <Box sx={{ p: 2, background: '#fff', borderRadius: '10px' }}>
                <QRCodeSVG value={setupUri} size={168} />
              </Box>
            </Box>
            <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', textAlign: 'center', mb: 2 }}>
              ¿No podés escanear? Ingresá esta clave manualmente:<br />
              <Box component="span" sx={{ fontFamily: '"JetBrains Mono", monospace', color: '#E8A020', wordBreak: 'break-all' }}>{setupSecret}</Box>
            </Typography>
            <Typography sx={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', mb: 1 }}>
              2. Ingresá el código de 6 dígitos que muestra la app:
            </Typography>
            <Stack direction="row" spacing={1.5}>
              <TextField
                size="small"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                inputProps={{ inputMode: 'numeric', maxLength: 6, style: { textAlign: 'center', letterSpacing: '0.4em' } }}
                sx={{ width: 160 }}
              />
              <Button variant="contained" onClick={confirmEnable} disabled={busy || code.length < 6}>
                {busy ? <CircularProgress size={18} /> : 'Confirmar'}
              </Button>
            </Stack>
          </Box>
        )}
      </Paper>
    </Box>
  );
};

export default Security;
