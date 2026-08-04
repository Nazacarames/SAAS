import { useEffect, useState } from 'react';
import {
  Typography, Box, Paper, Divider, Stack, Chip, Button, TextField, FormControlLabel, Switch,
  InputAdornment, IconButton, Tooltip
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { toast } from 'react-toastify';
import api from '../../services/api';

const Settings = () => {
  const [saving, setSaving] = useState(false);

  // Números que el agente nunca contesta (contratistas, proveedores, clientes
  // de siempre). Se aplica también a los que todavía no escribieron al CRM.
  const [ignorados, setIgnorados] = useState<any[]>([]);
  const [nuevosNumeros, setNuevosNumeros] = useState('');
  const [notaIgnorados, setNotaIgnorados] = useState('');
  const [guardandoIgnorados, setGuardandoIgnorados] = useState(false);

  const cargarIgnorados = async () => {
    try {
      const { data } = await api.get('/contacts/ai-optouts');
      setIgnorados(data?.numeros || []);
    } catch { /* la sección queda vacía */ }
  };
  useEffect(() => { cargarIgnorados(); }, []);

  const agregarIgnorados = async () => {
    const numbers = nuevosNumeros.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
    if (!numbers.length) { toast.info('Pegá al menos un número'); return; }
    setGuardandoIgnorados(true);
    try {
      const { data } = await api.post('/contacts/ai-optouts', { numbers, note: notaIgnorados });
      toast.success(`${data.cargados} número(s) en la lista · ${data.contactos_pausados} chat(s) ya abiertos pausados`);
      setNuevosNumeros(''); setNotaIgnorados('');
      cargarIgnorados();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudieron cargar');
    } finally { setGuardandoIgnorados(false); }
  };

  const quitarIgnorado = async (numero: string) => {
    try {
      await api.delete(`/contacts/ai-optouts/${numero}`);
      cargarIgnorados();
    } catch { toast.error('No se pudo quitar'); }
  };

  // Tokko
  const [tokkoEnabled, setTokkoEnabled] = useState(false);
  const [tokkoSyncLeads, setTokkoSyncLeads] = useState(true);
  const [tokkoApiKey, setTokkoApiKey] = useState('');
  const [tokkoApiKeyConfigured, setTokkoApiKeyConfigured] = useState(false);

  // Meta
  const [metaLeadAdsEnabled, setMetaLeadAdsEnabled] = useState(false);
  const [metaLeadAdsAppId, setMetaLeadAdsAppId] = useState('');
  const [metaLeadAdsAppSecret, setMetaLeadAdsAppSecret] = useState('');
  const [metaLeadAdsAppSecretConfigured, setMetaLeadAdsAppSecretConfigured] = useState(false);
  const [metaLeadAdsPageId, setMetaLeadAdsPageId] = useState('');
  const [metaLeadAdsWebhookVerifyToken, setMetaLeadAdsWebhookVerifyToken] = useState('');
  const [webhookStatus, setWebhookStatus] = useState<any>(null);

  const load = async () => {
    try {
      const { data } = await api.get('/settings/whatsapp-cloud');
      const s = data?.settings || {};
      setTokkoEnabled(Boolean(s.tokkoEnabled ?? false));
      setTokkoSyncLeads(Boolean(s.tokkoSyncLeadsEnabled ?? true));
      setTokkoApiKey('');
      setTokkoApiKeyConfigured(Boolean(data?.configured?.tokkoApiKey));
      setMetaLeadAdsEnabled(Boolean(s.metaLeadAdsEnabled ?? false));
      setMetaLeadAdsWebhookVerifyToken(String(s.metaLeadAdsWebhookVerifyToken || ''));
      setMetaLeadAdsAppId(String(s.metaLeadAdsAppId || ''));
      setMetaLeadAdsAppSecret('');
      setMetaLeadAdsAppSecretConfigured(Boolean(data?.configured?.metaLeadAdsAppSecret));
      setMetaLeadAdsPageId(String(s.metaLeadAdsPageId || ''));
      try {
        const ws = await api.get('/settings/meta/webhook-status');
        setWebhookStatus(ws.data || null);
      } catch { setWebhookStatus(null); }
    } catch { /* noop */ }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const payload: any = {
        tokkoEnabled,
        tokkoBaseUrl: 'https://www.tokkobroker.com/api/v1',
        tokkoLeadsPath: '/webcontact/',
        tokkoPropertiesPath: '/property/',
        tokkoSyncLeadsEnabled: tokkoSyncLeads,
        tokkoAgentSearchEnabled: true,
        tokkoCooldownSeconds: 10,
        metaLeadAdsEnabled,
        metaLeadAdsAppId,
        metaLeadAdsPageId,
      };
      if (tokkoApiKey.trim()) payload.tokkoApiKey = tokkoApiKey.trim();
      if (metaLeadAdsAppSecret.trim()) payload.metaLeadAdsAppSecret = metaLeadAdsAppSecret.trim();
      // Note: metaLeadAdsWebhookVerifyToken is server-generated, never sent by client
      await api.put('/settings/whatsapp-cloud', { settings: payload });
      toast.success('Configuración guardada');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo guardar la configuración');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Configuración</Typography>
      <Stack spacing={2}>

        {/* Números que el agente ignora */}
        <Paper sx={{ p: 2 }}>
          <Stack direction='row' spacing={1} alignItems='center' sx={{ mb: 1.5 }}>
            <Typography variant='h6'>Números que el agente ignora</Typography>
            <Chip size='small' color={ignorados.length ? 'warning' : 'default'} label={`${ignorados.length} en la lista`} />
          </Stack>
          <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mb: 1.5 }}>
            Contratistas, proveedores, clientes de siempre. El agente no les contesta nunca, ni siquiera
            la primera vez que escriben: los atiende una persona. Se pueden pegar varios, uno por línea.
          </Typography>
          <Stack spacing={1.2}>
            <TextField
              label='Números'
              multiline
              minRows={3}
              value={nuevosNumeros}
              onChange={(e) => setNuevosNumeros(e.target.value)}
              placeholder={'+54 9 341 555-1234\n+54 9 11 4444-5555'}
              helperText='Con o sin +54, guiones o espacios: da igual.'
            />
            <TextField
              label='Nota (opcional)'
              value={notaIgnorados}
              onChange={(e) => setNotaIgnorados(e.target.value)}
              placeholder='Contratistas'
            />
            <Box>
              <Button variant='contained' disabled={guardandoIgnorados} onClick={agregarIgnorados}>
                Agregar a la lista
              </Button>
            </Box>
            {ignorados.length > 0 && (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.8, mt: 1 }}>
                {ignorados.map((n: any) => (
                  <Chip
                    key={n.number}
                    label={n.note ? `+${n.number} · ${n.note}` : `+${n.number}`}
                    onDelete={() => quitarIgnorado(n.number)}
                    size='small'
                  />
                ))}
              </Box>
            )}
          </Stack>
        </Paper>

        {/* Tokko */}
        <Paper sx={{ p: 2 }}>
          <Stack direction='row' spacing={1} alignItems='center' sx={{ mb: 1.5 }}>
            <Typography variant='h6'>Tokko Broker</Typography>
            <Chip size='small' color={tokkoEnabled ? 'success' : 'default'} label={tokkoEnabled ? 'Activo' : 'Inactivo'} />
          </Stack>
          <Stack spacing={1.2}>
            <FormControlLabel
              control={<Switch checked={tokkoEnabled} onChange={(e) => setTokkoEnabled(e.target.checked)} />}
              label='Habilitar integración Tokko'
            />
            <FormControlLabel
              disabled={!tokkoEnabled}
              control={<Switch checked={tokkoSyncLeads} onChange={(e) => setTokkoSyncLeads(e.target.checked)} />}
              label='Enviar leads calificados a Tokko'
            />
            <Typography variant='caption' color='text.secondary' sx={{ mt: -1, ml: 4 }}>
              Cuando un lead califica, se crea en Tokko con etiquetas (fase, canal, asesor)
              y un resumen de la conversación. Cada lead se envía una sola vez.
            </Typography>
            <TextField
              label='Tokko API Key'
              type='password'
              value={tokkoApiKey}
              onChange={(e) => setTokkoApiKey(e.target.value)}
              placeholder={tokkoApiKeyConfigured ? '••••••••••••••••' : 'Ingresar clave API'}
              helperText={tokkoApiKeyConfigured ? 'Clave configurada. Completar solo para actualizar.' : 'Ingresar la clave API de Tokko.'}
            />
          </Stack>
        </Paper>

        {/* Meta Lead Ads */}
        <Paper sx={{ p: 2 }}>
          <Stack direction='row' spacing={1} alignItems='center' sx={{ mb: 1.5 }}>
            <Typography variant='h6'>Meta Lead Ads</Typography>
            <Chip size='small' color={metaLeadAdsEnabled ? 'success' : 'default'} label={metaLeadAdsEnabled ? 'Activo' : 'Inactivo'} />
          </Stack>
          <Stack spacing={1.5}>
            <FormControlLabel
              control={<Switch checked={metaLeadAdsEnabled} onChange={(e) => setMetaLeadAdsEnabled(e.target.checked)} />}
              label='Habilitar conexión Meta Lead Ads'
            />
            <TextField label='Meta App ID' value={metaLeadAdsAppId} onChange={(e) => setMetaLeadAdsAppId(e.target.value)} />
            <TextField
              label='Meta App Secret'
              type='password'
              value={metaLeadAdsAppSecret}
              onChange={(e) => setMetaLeadAdsAppSecret(e.target.value)}
              placeholder={metaLeadAdsAppSecretConfigured ? '••••••••••••••••' : 'Ingresar App Secret'}
              helperText={metaLeadAdsAppSecretConfigured ? 'Secreto configurado. Completar solo para actualizar.' : 'Dejar vacío para no cambiar.'}
            />
            <TextField label='Meta Page ID' value={metaLeadAdsPageId} onChange={(e) => setMetaLeadAdsPageId(e.target.value)} />

            <Divider />
            <Typography variant='subtitle2' color='text.secondary'>Webhook (Meta Developers)</Typography>
            <TextField
              label='Webhook Verify Token'
              value={metaLeadAdsWebhookVerifyToken || 'Cargando…'}
              InputProps={{
                readOnly: true,
                endAdornment: metaLeadAdsWebhookVerifyToken ? (
                  <InputAdornment position='end'>
                    <Tooltip title='Copiar token'>
                      <IconButton size='small' onClick={() => {
                        navigator.clipboard.writeText(metaLeadAdsWebhookVerifyToken);
                        toast.success('Token copiado');
                      }}>
                        <ContentCopyIcon fontSize='small' />
                      </IconButton>
                    </Tooltip>
                  </InputAdornment>
                ) : undefined,
              }}
              helperText='Generado automáticamente. Usarlo en Meta Developers al configurar el webhook.'
            />
            <TextField
              label='Webhook Callback URL'
              value={webhookStatus?.callbackUrl || `${window.location.origin}/api/ai/meta-leads/webhook`}
              InputProps={{ readOnly: true }}
            />
            <Stack direction='row' spacing={1} flexWrap='wrap'>
              <Chip size='small' color={webhookStatus?.verifyTokenConfigured ? 'success' : 'warning'} label={webhookStatus?.verifyTokenConfigured ? 'Verify token OK' : 'Falta verify token'} />
              <Chip size='small' color={webhookStatus?.appIdConfigured ? 'success' : 'warning'} label={webhookStatus?.appIdConfigured ? 'App ID OK' : 'Falta App ID'} />
              <Chip size='small' color={webhookStatus?.appSecretConfigured ? 'success' : 'warning'} label={webhookStatus?.appSecretConfigured ? 'App Secret OK' : 'Falta App Secret'} />
              <Chip size='small' color={webhookStatus?.pageIdConfigured ? 'success' : 'warning'} label={webhookStatus?.pageIdConfigured ? 'Page ID OK' : 'Falta Page ID'} />
            </Stack>

          </Stack>
        </Paper>

        <Button variant='contained' size='large' onClick={save} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar configuración'}
        </Button>
      </Stack>
    </Box>
  );
};

export default Settings;
