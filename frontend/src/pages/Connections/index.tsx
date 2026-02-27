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
  FormControlLabel,
  Switch
} from '@mui/material';
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
  const [waRecapEnabled, setWaRecapEnabled] = useState(true);
  const [waRecapTemplateName, setWaRecapTemplateName] = useState('recaptacion_3_dias');
  const [waRecapTemplateLang, setWaRecapTemplateLang] = useState('es_AR');
  const [waRecapInactivityMinutes, setWaRecapInactivityMinutes] = useState('4320');
  const [agentGuardrailsEnabled, setAgentGuardrailsEnabled] = useState(true);
  const [agentConversationPoliciesJson, setAgentConversationPoliciesJson] = useState('{"sales":{"maxReplyChars":280},"support":{"maxReplyChars":320,"autoHandoffOnSensitive":true},"scheduling":{"maxReplyChars":220},"general":{"maxReplyChars":260}}');

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
      setWaCloudVerifyToken(s.waCloudVerifyToken || '');
      setWaCloudPhoneNumberId(s.waCloudPhoneNumberId || '');
      // Secrets are not returned by the API; keep inputs empty unless user types them.
      setWaCloudAccessToken('');
      setWaCloudAppSecret('');
      setWaCloudDefaultWhatsappId(String(s.waCloudDefaultWhatsappId || 1));
      setWaRecapEnabled(Boolean(s.waRecapEnabled ?? true));
      setWaRecapTemplateName(s.waRecapTemplateName || 'recaptacion_3_dias');
      setWaRecapTemplateLang(s.waRecapTemplateLang || 'es_AR');
      setWaRecapInactivityMinutes(String(s.waRecapInactivityMinutes || 4320));
      setAgentGuardrailsEnabled(Boolean(s.agentGuardrailsEnabled ?? true));
      setAgentConversationPoliciesJson(String(s.agentConversationPoliciesJson || agentConversationPoliciesJson));
    } catch {
      // ignore
    }
  };

  const saveCloudSettings = async () => {
    setSavingWaCloud(true);
    try {
            const payload: any = {
        waCloudVerifyToken,
        waCloudPhoneNumberId,
        waCloudDefaultWhatsappId: Number(waCloudDefaultWhatsappId || 1),
        waRecapEnabled,
        waRecapTemplateName,
        waRecapTemplateLang,
        waRecapInactivityMinutes: Number(waRecapInactivityMinutes || 4320),
        agentGuardrailsEnabled,
        agentConversationPoliciesJson
      };

      // Only send secrets when user explicitly typed them.
      if (waCloudAccessToken && waCloudAccessToken.trim()) payload.waCloudAccessToken = waCloudAccessToken.trim();
      if (waCloudAppSecret && waCloudAppSecret.trim()) payload.waCloudAppSecret = waCloudAppSecret.trim();

      await api.put('/settings/whatsapp-cloud', payload);
      toast.success('Conexión Cloud API guardada');
      setOpenNewConnection(false);
      fetchConnections();
    } catch {
      toast.error('No se pudo guardar la conexión Cloud API');
    } finally {
      setSavingWaCloud(false);
    }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h4">WhatsApp</Typography>
        <Stack direction="row" spacing={1}>
          <Chip color="warning" label="QR deshabilitado" />
          <Button variant="contained" onClick={() => setOpenNewConnection(true)}>
            Nueva conexión
          </Button>
        </Stack>
      </Box>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1">Modo activo: WhatsApp Cloud API</Typography>
        <Typography variant="body2" color="text.secondary">
          Para conectar, usá “Nueva conexión” y cargá las credenciales de Meta.
        </Typography>
        <Divider sx={{ my: 1.5 }} />
        <Typography variant="caption" color="text.secondary">
          Callback URL: https://login.charlott.ai/api/whatsapp-cloud/webhook
        </Typography>
      </Paper>

      <Paper>
        <TableContainer>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>ID</TableCell>
                <TableCell>Nombre</TableCell>
                <TableCell>Estado</TableCell>
                <TableCell>Batería</TableCell>
                <TableCell>Predeterminada</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={5} align="center">Cargando...</TableCell>
                </TableRow>
              ) : connections.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} align="center">No hay conexiones registradas</TableCell>
                </TableRow>
              ) : (
                connections.map((conn) => (
                  <TableRow key={conn.id}>
                    <TableCell>{conn.id}</TableCell>
                    <TableCell>{conn.name}</TableCell>
                    <TableCell>{conn.status}</TableCell>
                    <TableCell>{conn.battery || 'N/A'}%</TableCell>
                    <TableCell>{conn.isDefault ? 'Sí' : 'No'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <Dialog open={openNewConnection} onClose={() => setOpenNewConnection(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Nueva conexión WhatsApp Cloud API</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <TextField label="Verify Token" value={waCloudVerifyToken} onChange={(e) => setWaCloudVerifyToken(e.target.value)} fullWidth />
            <TextField label="Phone Number ID" value={waCloudPhoneNumberId} onChange={(e) => setWaCloudPhoneNumberId(e.target.value)} fullWidth />
            <TextField label="Default WhatsApp ID (CRM)" value={waCloudDefaultWhatsappId} onChange={(e) => setWaCloudDefaultWhatsappId(e.target.value)} fullWidth />
            <TextField
              label="Access Token"
              value={waCloudAccessToken}
              onChange={(e) => setWaCloudAccessToken(e.target.value)}
              type={showWaSecrets ? 'text' : 'password'}
              fullWidth
            />
            <TextField
              label="App Secret (opcional)"
              value={waCloudAppSecret}
              onChange={(e) => setWaCloudAppSecret(e.target.value)}
              type={showWaSecrets ? 'text' : 'password'}
              fullWidth
            />
            <Divider />
            <Typography variant="subtitle2">Recaptación automática (Meta Template)</Typography>
            <FormControlLabel
              control={<Switch checked={waRecapEnabled} onChange={(e) => setWaRecapEnabled(e.target.checked)} />}
              label="Activar recaptación por inactividad"
            />
            <TextField
              label="Template name"
              value={waRecapTemplateName}
              onChange={(e) => setWaRecapTemplateName(e.target.value)}
              fullWidth
              helperText="Ej: recaptacion_3_dias"
            />
            <TextField
              label="Template language"
              value={waRecapTemplateLang}
              onChange={(e) => setWaRecapTemplateLang(e.target.value)}
              fullWidth
              helperText="Ej: es_AR"
            />
            <TextField
              label="Inactividad (minutos)"
              value={waRecapInactivityMinutes}
              onChange={(e) => setWaRecapInactivityMinutes(e.target.value)}
              fullWidth
              helperText="3 días = 4320"
            />
            <Divider />
            <Typography variant="subtitle2">Guardrails IA por tipo de conversación</Typography>
            <FormControlLabel
              control={<Switch checked={agentGuardrailsEnabled} onChange={(e) => setAgentGuardrailsEnabled(e.target.checked)} />}
              label="Activar guardrails finos"
            />
            <TextField
              label="Policies JSON"
              value={agentConversationPoliciesJson}
              onChange={(e) => setAgentConversationPoliciesJson(e.target.value)}
              fullWidth
              multiline
              minRows={4}
              helperText='Ejemplo: {"sales":{"maxReplyChars":280},"support":{"autoHandoffOnSensitive":true}}'
            />
            <Button variant="outlined" onClick={() => setShowWaSecrets((s) => !s)}>
              {showWaSecrets ? 'Ocultar secretos' : 'Mostrar secretos'}
            </Button>
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
