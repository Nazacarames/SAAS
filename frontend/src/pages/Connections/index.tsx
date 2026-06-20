import {
  Typography,
  Box,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  Button,
  TextField,
  Stack,
  Divider,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  CircularProgress,
  Alert,
  IconButton,
  Tooltip
} from '@mui/material';
import {
  CheckCircleRounded as CheckIcon,
  RadioButtonUncheckedRounded as PendingIcon,
  ContentCopyRounded as CopyIcon
} from '@mui/icons-material';
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../../services/api';

interface WhatsAppConnection {
  id: number;
  name: string;
  status: string;
  battery?: number;
  isDefault: boolean;
}

const CALLBACK_URL = 'https://login.charlott.ai/api/whatsapp-cloud/webhook';

const Connections = () => {
  const [connections, setConnections] = useState<WhatsAppConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const [openNewConnection, setOpenNewConnection] = useState(false);
  const [waCloudVerifyToken, setWaCloudVerifyToken] = useState('');
  const [waCloudPhoneNumberId, setWaCloudPhoneNumberId] = useState('');
  const [waCloudAccessToken, setWaCloudAccessToken] = useState('');
  const [waCloudAppSecret, setWaCloudAppSecret] = useState('');
  const [waCloudDefaultWhatsappId, setWaCloudDefaultWhatsappId] = useState('1');
  const [showWaSecrets, setShowWaSecrets] = useState(false);
  const [savingWaCloud, setSavingWaCloud] = useState(false);

  // Setup progress
  const [credsConfigured, setCredsConfigured] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; name?: string; phone?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    fetchConnections();
    fetchCloudSettings();
  }, []);

  const fetchConnections = async () => {
    try {
      const { data } = await api.get('/whatsapps');
      setConnections(Array.isArray(data) ? data : []);
    } catch (error) {
      console.error('Error fetching connections:', error);
      toast.error('Error al cargar conexiones');
    } finally {
      setLoading(false);
    }
  };

  const fetchCloudSettings = async () => {
    try {
      const { data } = await api.get('/settings/whatsapp-cloud');
      const s = data?.settings || {};
      const c = data?.configured || {};
      setWaCloudVerifyToken(s.waCloudVerifyToken || '');
      setWaCloudPhoneNumberId(s.waCloudPhoneNumberId || '');
      setWaCloudAccessToken('');
      setWaCloudAppSecret('');
      setWaCloudDefaultWhatsappId(String(s.waCloudDefaultWhatsappId || 1));
      setCredsConfigured(Boolean(c.phoneNumberId && c.accessToken));
    } catch {
      // ignore
    }
  };

  const testConnection = async (useFormValues: boolean) => {
    setTesting(true);
    setTestResult(null);
    try {
      const body: any = {};
      if (useFormValues) {
        if (waCloudAccessToken.trim()) body.accessToken = waCloudAccessToken.trim();
        if (waCloudPhoneNumberId.trim()) body.phoneNumberId = waCloudPhoneNumberId.trim();
      }
      const { data } = await api.post('/settings/whatsapp-cloud/test', body);
      setTestResult({ ok: true, name: data.verifiedName, phone: data.displayPhoneNumber });
      toast.success(`Conexión OK: ${data.verifiedName || data.displayPhoneNumber}`);
    } catch (e: any) {
      const detail = e?.response?.data?.detail || 'No se pudo validar la conexión';
      setTestResult({ ok: false, error: detail });
      toast.error(detail);
    } finally {
      setTesting(false);
    }
  };

  const saveCloudSettings = async () => {
    // Validate before submitting: a silent save with missing credentials
    // leaves the user thinking they are connected when they are not.
    if (!waCloudPhoneNumberId.trim()) return toast.error('Falta el Phone Number ID (lo encontrás en Meta Developers → WhatsApp → Configuración de API)');
    if (!credsConfigured && !waCloudAccessToken.trim()) return toast.error('Falta el Access Token (generalo en Meta Developers)');

    setSavingWaCloud(true);
    try {
      const payload: any = {
        waCloudVerifyToken,
        waCloudPhoneNumberId: waCloudPhoneNumberId.trim(),
        waCloudDefaultWhatsappId: Number(waCloudDefaultWhatsappId || 1),
      };

      if (waCloudAccessToken.trim()) payload.waCloudAccessToken = waCloudAccessToken.trim();
      if (waCloudAppSecret.trim()) payload.waCloudAppSecret = waCloudAppSecret.trim();

      await api.put('/settings/whatsapp-cloud', { settings: payload });
      toast.success('Conexión Cloud API guardada');
      setOpenNewConnection(false);
      fetchConnections();
      fetchCloudSettings();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo guardar la conexión Cloud API');
    } finally {
      setSavingWaCloud(false);
    }
  };

  const copyText = (value: string, label: string) => {
    navigator.clipboard.writeText(value);
    toast.info(`${label} copiado`);
  };

  const steps = [
    {
      label: '1. Cargar credenciales de Meta',
      done: credsConfigured,
      hint: 'Access Token y Phone Number ID desde Meta Developers'
    },
    {
      label: '2. Probar la conexión',
      done: Boolean(testResult?.ok),
      hint: 'Validamos tus credenciales contra Meta en segundos'
    },
    {
      label: '3. Configurar el webhook en Meta',
      done: false,
      hint: 'Pegá la Callback URL y el Verify Token en Meta Developers → WhatsApp → Webhooks'
    }
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4">WhatsApp</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={() => testConnection(false)} disabled={testing || !credsConfigured}>
            {testing ? <CircularProgress size={18} /> : 'Probar conexión'}
          </Button>
          <Button variant="contained" onClick={() => setOpenNewConnection(true)}>
            {credsConfigured ? 'Editar conexión' : 'Conectar WhatsApp'}
          </Button>
        </Stack>
      </Box>

      {testResult && (
        <Alert severity={testResult.ok ? 'success' : 'error'} sx={{ mb: 2 }} onClose={() => setTestResult(null)}>
          {testResult.ok
            ? `Conectado correctamente: ${testResult.name || ''} (${testResult.phone || ''})`
            : testResult.error}
        </Alert>
      )}

      {/* Setup checklist for non-technical users */}
      <Paper className='anim-fade-up anim-fade-up-1' sx={{ p: 2.5, mb: 2 }}>
        <Typography variant="h6" sx={{ mb: 1.5 }}>Pasos para conectar tu WhatsApp Business</Typography>
        <Stack spacing={1.5}>
          {steps.map((s) => (
            <Stack key={s.label} direction="row" spacing={1.5} alignItems="flex-start">
              {s.done ? (
                <CheckIcon className='check-pop' sx={{ color: '#4AB87A', fontSize: 20, mt: 0.2 }} />
              ) : (
                <PendingIcon sx={{ color: 'rgba(255,255,255,0.3)', fontSize: 20, mt: 0.2, transition: 'color 200ms ease' }} />
              )}
              <Box sx={{ opacity: s.done ? 0.65 : 1, transition: 'opacity 300ms ease' }}>
                <Typography variant="body2" sx={{ fontWeight: 600, textDecoration: s.done ? 'line-through' : 'none', textDecorationColor: 'rgba(255,255,255,0.3)' }}>{s.label}</Typography>
                <Typography variant="caption" color="text.secondary">{s.hint}</Typography>
              </Box>
            </Stack>
          ))}
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
          Datos para el paso 3 (Meta Developers → WhatsApp → Configuración → Webhooks):
        </Typography>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>Callback URL: {CALLBACK_URL}</Typography>
          <Tooltip title="Copiar">
            <IconButton size="small" onClick={() => copyText(CALLBACK_URL, 'Callback URL')}><CopyIcon sx={{ fontSize: 14 }} /></IconButton>
          </Tooltip>
        </Stack>
        {waCloudVerifyToken && (
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>Verify Token: {waCloudVerifyToken}</Typography>
            <Tooltip title="Copiar">
              <IconButton size="small" onClick={() => copyText(waCloudVerifyToken, 'Verify Token')}><CopyIcon sx={{ fontSize: 14 }} /></IconButton>
            </Tooltip>
          </Stack>
        )}
      </Paper>

      <Paper className='anim-fade-up anim-fade-up-2'>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Nombre</TableCell>
                <TableCell>Estado</TableCell>
                <TableCell>Predeterminada</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} align="center">Cargando...</TableCell>
                </TableRow>
              ) : connections.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} align="center">No hay conexiones registradas</TableCell>
                </TableRow>
              ) : (
                connections.map((conn) => (
                  <TableRow key={conn.id}>
                    <TableCell>{conn.id}</TableCell>
                    <TableCell>{conn.name}</TableCell>
                    <TableCell>
                      {/* DB status is stale by design (Cloud API has no persistent
                          socket). Show live test result when available. */}
                      {testResult?.ok ? (
                        <Chip size="small" color="success" label="CONECTADO" />
                      ) : (
                        <Tooltip title='Usá "Probar conexión" para verificar el estado real'>
                          <Chip size="small" variant="outlined" label={credsConfigured ? 'SIN VERIFICAR' : 'SIN CONFIGURAR'} />
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>{conn.isDefault ? 'Sí' : 'No'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={openNewConnection} onClose={() => setOpenNewConnection(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{credsConfigured ? 'Editar conexión WhatsApp Cloud API' : 'Conectar WhatsApp Cloud API'}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField
              label="Phone Number ID"
              helperText="Meta Developers → WhatsApp → Configuración de API → Phone number ID"
              value={waCloudPhoneNumberId}
              onChange={(e) => setWaCloudPhoneNumberId(e.target.value)}
              fullWidth
              required
            />
            <TextField
              label="Access Token"
              helperText={credsConfigured ? 'Dejalo vacío para mantener el actual' : 'Token permanente generado en Meta Developers'}
              value={waCloudAccessToken}
              onChange={(e) => setWaCloudAccessToken(e.target.value)}
              type={showWaSecrets ? 'text' : 'password'}
              fullWidth
              required={!credsConfigured}
            />
            <TextField
              label="App Secret (opcional, recomendado)"
              helperText="Valida la firma de los webhooks de Meta"
              value={waCloudAppSecret}
              onChange={(e) => setWaCloudAppSecret(e.target.value)}
              type={showWaSecrets ? 'text' : 'password'}
              fullWidth
            />
            <TextField
              label="Verify Token"
              helperText="Se genera automáticamente; podés personalizarlo"
              value={waCloudVerifyToken}
              onChange={(e) => setWaCloudVerifyToken(e.target.value)}
              fullWidth
            />
            <TextField
              label="Default WhatsApp ID (CRM)"
              value={waCloudDefaultWhatsappId}
              onChange={(e) => setWaCloudDefaultWhatsappId(e.target.value)}
              fullWidth
            />
            <Stack direction="row" spacing={1}>
              <Button variant="outlined" size="small" onClick={() => setShowWaSecrets((s) => !s)}>
                {showWaSecrets ? 'Ocultar secretos' : 'Mostrar secretos'}
              </Button>
              <Button
                variant="outlined"
                size="small"
                onClick={() => testConnection(true)}
                disabled={testing || (!waCloudAccessToken.trim() && !credsConfigured) || !waCloudPhoneNumberId.trim()}
              >
                {testing ? <CircularProgress size={16} /> : 'Probar antes de guardar'}
              </Button>
            </Stack>
            {testResult && (
              <Alert severity={testResult.ok ? 'success' : 'error'}>
                {testResult.ok ? `OK: ${testResult.name || ''} (${testResult.phone || ''})` : testResult.error}
              </Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenNewConnection(false)}>Cancelar</Button>
          <Button variant="contained" onClick={saveCloudSettings} disabled={savingWaCloud}>
            {savingWaCloud ? 'Guardando...' : 'Guardar conexión'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Connections;
