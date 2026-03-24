import { useEffect, useState } from 'react';
import {
  Typography, Box, Paper, Divider, Stack, Chip, Button, TextField, FormControlLabel, Switch, Alert, IconButton, InputAdornment
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';
import { Visibility, VisibilityOff } from '@mui/icons-material';

const Settings = () => {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Tokko
  const [tokkoEnabled, setTokkoEnabled] = useState(false);
  const [tokkoApiKey, setTokkoApiKey] = useState('');
  const [tokkoApiKeyMasked, setTokkoApiKeyMasked] = useState('');

  // Meta Lead Ads
  const [metaLeadAdsEnabled, setMetaLeadAdsEnabled] = useState(false);
  const [metaLeadAdsWebhookVerifyToken, setMetaLeadAdsWebhookVerifyToken] = useState('');
  const [metaLeadAdsAppId, setMetaLeadAdsAppId] = useState('');
  const [metaLeadAdsAppSecret, setMetaLeadAdsAppSecret] = useState('');
  const [metaLeadAdsPageId, setMetaLeadAdsPageId] = useState('');
  const [webhookStatus, setWebhookStatus] = useState<any>(null);
  const [showMetaSecret, setShowMetaSecret] = useState(false);

  const callbackUrl = `${window.location.origin}/api/ai/meta-leads/webhook`;

  const loadWebhookStatus = async () => {
    try {
      const { data } = await api.get('/settings/meta/webhook-status');
      setWebhookStatus(data || null);
    } catch {
      setWebhookStatus(null);
    }
  };

  const load = async () => {
    try {
      const { data } = await api.get('/settings/whatsapp-cloud');
      const s = data?.settings || {};
      setTokkoEnabled(Boolean(s.tokkoEnabled ?? false));
      setTokkoApiKeyMasked(s.tokkoApiKeyMasked || '');
      setTokkoApiKey('');
      setMetaLeadAdsEnabled(Boolean(s.metaLeadAdsEnabled ?? false));
      setMetaLeadAdsWebhookVerifyToken(String(s.metaLeadAdsWebhookVerifyToken || ''));
      setMetaLeadAdsAppId(String(s.metaLeadAdsAppId || ''));
      setMetaLeadAdsAppSecret('');
      setMetaLeadAdsPageId(String(s.metaLeadAdsPageId || ''));
      await loadWebhookStatus();
    } catch { /* noop */ }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const payload: any = {
        tokkoEnabled,
        tokkoBaseUrl: 'https://www.tokkobroker.com/api/v1',
        tokkoLeadsPath: '/webcontact/',
        tokkoPropertiesPath: '/property/',
        tokkoSyncLeadsEnabled: true,
        tokkoAgentSearchEnabled: true,
        tokkoSyncContactsEnabled: true,
        tokkoSyncContactTagsEnabled: true,
        tokkoFallbackToLocalSearch: true,
        tokkoDebugLogsEnabled: false,
        tokkoRateLimitEnabled: true,
        tokkoCooldownSeconds: 10,
        tokkoSafeWriteMode: true,
        tokkoTabVisible: true,
        metaLeadAdsEnabled,
        metaLeadAdsAppId,
        metaLeadAdsPageId,
      };
      if (tokkoApiKey.trim()) payload.tokkoApiKey = tokkoApiKey.trim();
      if (metaLeadAdsWebhookVerifyToken.trim()) payload.metaLeadAdsWebhookVerifyToken = metaLeadAdsWebhookVerifyToken.trim();
      if (metaLeadAdsAppSecret.trim()) payload.metaLeadAdsAppSecret = metaLeadAdsAppSecret.trim();
      await api.put('/settings/whatsapp-cloud', payload);
      setTokkoApiKey('');
      setMetaLeadAdsAppSecret('');
      if (payload.tokkoApiKey) setTokkoApiKeyMasked('••••••••••••');
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
      toast.success('Configuración guardada');
    } catch {
      toast.error('Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Configuración</Typography>

      <Paper sx={{ p: 2, mb: 2 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} flexWrap="wrap" useFlexGap>
          <Chip size='small' color={tokkoEnabled ? 'success' : 'default'} label={`Tokko ${tokkoEnabled ? 'Activo' : 'Inactivo'}`} />
          <Chip size='small' color={metaLeadAdsEnabled ? 'success' : 'default'} label={`Meta Lead Ads ${metaLeadAdsEnabled ? 'Activo' : 'Inactivo'}`} />
          {saved && <Chip size='small' color='success' label='Guardado' />}
        </Stack>
      </Paper>

      <Stack spacing={3}>
        {/* TOKKO */}
        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Box>
              <Typography variant='h6'>Tokko Broker</Typography>
              <Typography variant='body2' color='text.secondary'>
                Sincronizá leads automáticamente con Tokko cuando llegan desde Meta.
              </Typography>
            </Box>
            <FormControlLabel
              control={<Switch checked={tokkoEnabled} onChange={(e) => setTokkoEnabled(e.target.checked)} />}
              label='Activar sincronización con Tokko'
            />
            <TextField
              label='API Key'
              value={tokkoApiKey}
              onChange={(e) => setTokkoApiKey(e.target.value)}
              placeholder={tokkoApiKeyMasked ? `Actual: ${tokkoApiKeyMasked}` : 'Ingresá la API key de Tokko'}
              helperText={tokkoApiKeyMasked ? 'Dejar vacío = mantener la actual.' : 'La API key se guarda de forma segura.'}
              type='password'
              sx={{ maxWidth: 480 }}
            />
          </Stack>
        </Paper>

        {/* META LEAD ADS */}
        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Alert severity='info'>
              Configurá tu app de Meta para recibir leads de Facebook e Instagram automáticamente.
            </Alert>

            <FormControlLabel
              control={<Switch checked={metaLeadAdsEnabled} onChange={(e) => setMetaLeadAdsEnabled(e.target.checked)} />}
              label='Activar Meta Lead Ads'
            />

            <Paper variant='outlined' sx={{ p: 1.5 }}>
              <Stack spacing={1.5}>
                <Typography variant='subtitle2'>Credenciales</Typography>
                <TextField label='App ID' value={metaLeadAdsAppId} onChange={(e) => setMetaLeadAdsAppId(e.target.value)} size='small' fullWidth />
                <TextField
                  label='App Secret'
                  value={metaLeadAdsAppSecret}
                  onChange={(e) => setMetaLeadAdsAppSecret(e.target.value)}
                  type={showMetaSecret ? 'text' : 'password'}
                  size='small'
                  fullWidth
                  InputProps={{
                    endAdornment: <InputAdornment position='end'><IconButton onClick={() => setShowMetaSecret((s) => !s)} edge='end' size='small'>{showMetaSecret ? <VisibilityOff fontSize='small' /> : <Visibility fontSize='small' />}</IconButton></InputAdornment>
                  }}
                  helperText='Dejar vacío = mantener el actual.'
                />
                <TextField label='Page ID' value={metaLeadAdsPageId} onChange={(e) => setMetaLeadAdsPageId(e.target.value)} size='small' fullWidth />
              </Stack>
            </Paper>

            <Paper variant='outlined' sx={{ p: 1.5 }}>
              <Stack spacing={1.5}>
                <Typography variant='subtitle2'>Webhook</Typography>
                <TextField label='Verify Token' value={metaLeadAdsWebhookVerifyToken} InputProps={{ readOnly: true }} size='small' fullWidth helperText='Usar este valor en Meta Developers > Webhooks' />
                <TextField label='Callback URL' value={callbackUrl} InputProps={{ readOnly: true }} size='small' fullWidth helperText='Configurar en Meta Developers' />
                <Stack direction='row' spacing={1} flexWrap='wrap'>
                  <Chip size='small' color={webhookStatus?.verifyTokenConfigured ? 'success' : 'warning'} label={webhookStatus?.verifyTokenConfigured ? 'Token OK' : 'Sin token'} />
                  <Chip size='small' color={webhookStatus?.appIdConfigured ? 'success' : 'warning'} label={webhookStatus?.appIdConfigured ? 'App ID OK' : 'Sin App ID'} />
                  <Chip size='small' color={webhookStatus?.appSecretConfigured ? 'success' : 'warning'} label={webhookStatus?.appSecretConfigured ? 'Secret OK' : 'Sin Secret'} />
                  <Chip size='small' color={webhookStatus?.pageIdConfigured ? 'success' : 'warning'} label={webhookStatus?.pageIdConfigured ? 'Page ID OK' : 'Sin Page ID'} />
                </Stack>
              </Stack>
            </Paper>

          </Stack>
        </Paper>

        <Divider />

        <Stack direction='row' spacing={1} alignItems='center'>
          <Button variant='contained' onClick={save} disabled={saving}>
            {saving ? 'Guardando…' : 'Guardar configuración'}
          </Button>
          {saved && <Chip size='small' color='success' label='Cambios guardados' />}
        </Stack>
      </Stack>
    </Box>
  );
};

export default Settings;
