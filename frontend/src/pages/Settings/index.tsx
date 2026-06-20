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

  // Tokko
  const [tokkoEnabled, setTokkoEnabled] = useState(false);
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
        tokkoSyncLeadsEnabled: true,
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
