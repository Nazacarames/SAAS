import { useEffect, useState } from 'react';
import {
  Typography, Box, Paper, Divider, Tabs, Tab, Stack, Chip, Button, TextField, FormControlLabel, Switch
} from '@mui/material';
import api from '../../services/api';

const DEFAULT_META_LEADS_VERIFY_TOKEN = 'claw-meta-1771044100';

const Settings = () => {
  const [tab, setTab] = useState(0);
  const [saving, setSaving] = useState(false);
  const [tokkoEnabled, setTokkoEnabled] = useState(false);
  const [tokkoApiKey, setTokkoApiKey] = useState('');
  const [tokkoBaseUrl, setTokkoBaseUrl] = useState('https://www.tokkobroker.com/api/v1');
  const [tokkoLeadsPath, setTokkoLeadsPath] = useState('/webcontact/');
  const [tokkoPropertiesPath, setTokkoPropertiesPath] = useState('/property/');
  const [tokkoSyncLeadsEnabled, setTokkoSyncLeadsEnabled] = useState(true);
  const [tokkoAgentSearchEnabled, setTokkoAgentSearchEnabled] = useState(true);
  const [tokkoSyncContactsEnabled, setTokkoSyncContactsEnabled] = useState(false);
  const [tokkoSyncContactTagsEnabled, setTokkoSyncContactTagsEnabled] = useState(false);
  const [tokkoFallbackToLocalSearch, setTokkoFallbackToLocalSearch] = useState(true);
  const [tokkoDebugLogsEnabled, setTokkoDebugLogsEnabled] = useState(false);
  const [tokkoRateLimitEnabled, setTokkoRateLimitEnabled] = useState(true);
  const [tokkoCooldownSeconds, setTokkoCooldownSeconds] = useState('10');
  const [tokkoSafeWriteMode, setTokkoSafeWriteMode] = useState(true);

  const [metaLeadAdsEnabled, setMetaLeadAdsEnabled] = useState(false);
  const [metaLeadAdsWebhookVerifyToken, setMetaLeadAdsWebhookVerifyToken] = useState(DEFAULT_META_LEADS_VERIFY_TOKEN);
  const [metaLeadAdsAppId, setMetaLeadAdsAppId] = useState('');
  const [metaLeadAdsAppSecret, setMetaLeadAdsAppSecret] = useState('');
  const [metaLeadAdsPageId, setMetaLeadAdsPageId] = useState('');
  const [tokkoTabVisible, setTokkoTabVisible] = useState(true);
  const [waRecapEnabled, setWaRecapEnabled] = useState(true);
  const [waRecapTemplateName, setWaRecapTemplateName] = useState('recaptacion_3_dias');
  const [waRecapTemplateLang, setWaRecapTemplateLang] = useState('es_AR');
  const [waRecapInactivityHours, setWaRecapInactivityHours] = useState('72');
  const [webhookStatus, setWebhookStatus] = useState<any>(null);
  const [metaLeadAdsAppSecretSaved, setMetaLeadAdsAppSecretSaved] = useState(false);
  const [metaLastUpdatedAt, setMetaLastUpdatedAt] = useState<Date | null>(null);

  const [metaOauthStatus, setMetaOauthStatus] = useState<any>(null);
  const [metaOauthLoading, setMetaOauthLoading] = useState(false);

  const loadMetaOauthStatus = async () => {
    try {
      const { data } = await api.get('/ai/meta/oauth/status');
      setMetaOauthStatus(data || null);
    } catch {
      setMetaOauthStatus(null);
    }
  };

  const load = async () => {
    try {
      const { data } = await api.get('/settings/whatsapp-cloud');
      const s = data?.settings || {};

      setTokkoEnabled(Boolean(s.tokkoEnabled ?? false));
      setTokkoApiKey('');
      setTokkoBaseUrl(s.tokkoBaseUrl || 'https://www.tokkobroker.com/api/v1');
      setTokkoLeadsPath(s.tokkoLeadsPath || '/webcontact/');
      setTokkoPropertiesPath(s.tokkoPropertiesPath || '/property/');
      setTokkoSyncLeadsEnabled(Boolean(s.tokkoSyncLeadsEnabled ?? true));
      setTokkoAgentSearchEnabled(Boolean(s.tokkoAgentSearchEnabled ?? true));
      setTokkoSyncContactsEnabled(Boolean(s.tokkoSyncContactsEnabled ?? false));
      setTokkoSyncContactTagsEnabled(Boolean(s.tokkoSyncContactTagsEnabled ?? false));
      setTokkoFallbackToLocalSearch(Boolean(s.tokkoFallbackToLocalSearch ?? true));
      setTokkoDebugLogsEnabled(Boolean(s.tokkoDebugLogsEnabled ?? false));
      setTokkoRateLimitEnabled(Boolean(s.tokkoRateLimitEnabled ?? true));
      setTokkoCooldownSeconds(String(s.tokkoCooldownSeconds || 10));
      setTokkoSafeWriteMode(Boolean(s.tokkoSafeWriteMode ?? true));

      setMetaLeadAdsEnabled(Boolean(s.metaLeadAdsEnabled ?? false));
      setMetaLeadAdsWebhookVerifyToken(String(s.metaLeadAdsWebhookVerifyToken || DEFAULT_META_LEADS_VERIFY_TOKEN));
      setMetaLeadAdsAppId(String(s.metaLeadAdsAppId || ''));
      setMetaLeadAdsAppSecret('');
      setMetaLeadAdsAppSecretSaved(Boolean(s.metaLeadAdsAppSecretMasked || s.metaLeadAdsAppSecret));
      setMetaLeadAdsPageId(String(s.metaLeadAdsPageId || ''));
      setMetaLastUpdatedAt(new Date());
      setTokkoTabVisible(Boolean(s.tokkoTabVisible ?? true));
      setWaRecapEnabled(Boolean(s.waRecapEnabled ?? true));
      setWaRecapTemplateName(s.waRecapTemplateName || 'recaptacion_3_dias');
      setWaRecapTemplateLang(s.waRecapTemplateLang || 'es_AR');
      setWaRecapInactivityHours(String(Math.max(1, Math.round(Number(s.waRecapInactivityMinutes || 4320) / 60))));

      try {
        const ws = await api.get('/settings/meta/webhook-status');
        setWebhookStatus(ws.data || null);
      } catch {
        setWebhookStatus(null);
      }

      await loadMetaOauthStatus();
    } catch {
      // noop
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      const payload: any = {
        tokkoEnabled,
        tokkoBaseUrl,
        tokkoLeadsPath,
        tokkoPropertiesPath,
        tokkoSyncLeadsEnabled,
        tokkoAgentSearchEnabled,
        tokkoSyncContactsEnabled,
        tokkoSyncContactTagsEnabled,
        tokkoFallbackToLocalSearch,
        tokkoDebugLogsEnabled,
        tokkoRateLimitEnabled,
        tokkoCooldownSeconds: Number(tokkoCooldownSeconds || 10),
        tokkoSafeWriteMode,
        tokkoTabVisible,

        metaLeadAdsEnabled,
        metaLeadAdsAppId,
        metaLeadAdsPageId,
        waRecapEnabled,
        waRecapTemplateName,
        waRecapTemplateLang,
        waRecapInactivityMinutes: Math.max(60, Number(waRecapInactivityHours || 72) * 60)
      };

      if (tokkoApiKey && tokkoApiKey.trim()) payload.tokkoApiKey = tokkoApiKey.trim();
      if (metaLeadAdsWebhookVerifyToken && metaLeadAdsWebhookVerifyToken.trim()) payload.metaLeadAdsWebhookVerifyToken = metaLeadAdsWebhookVerifyToken.trim();
      if (metaLeadAdsAppSecret && metaLeadAdsAppSecret.trim()) payload.metaLeadAdsAppSecret = metaLeadAdsAppSecret.trim();

      await api.put('/settings/whatsapp-cloud', payload);
      await load();
      setMetaLastUpdatedAt(new Date());
    } finally {
      setSaving(false);
    }
  };

  const connectMetaOauth = async () => {
    setMetaOauthLoading(true);
    try {
      const redirectAfter = `${window.location.origin}/settings`;
      const { data } = await api.get(`/ai/meta/oauth/start?redirectAfter=${encodeURIComponent(redirectAfter)}`);
      if (data?.oauthUrl) {
        window.location.href = data.oauthUrl;
        return;
      }
    } catch (e: any) {
    } finally {
      setMetaOauthLoading(false);
    }
  };


  const metaLinked = Boolean(metaLeadAdsEnabled && metaLeadAdsAppId && metaLeadAdsPageId && metaLeadAdsAppSecretSaved && webhookStatus?.verifyTokenConfigured);

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Configuración</Typography>
      <Paper sx={{ p: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant='scrollable' scrollButtons='auto'>
          <Tab label={tokkoTabVisible ? 'Tokko' : 'Tokko (oculta en menú)'} />
          <Tab label='Configuración Meta' />
          <Tab label='Templates' />
        </Tabs>
        <Divider sx={{ my: 2 }} />

        {tab === 0 && (
          <Stack spacing={1.2}>
            <Stack direction='row' spacing={1} alignItems='center'>
              <Typography variant='h6'>Integración Tokko Broker</Typography>
              <Chip size='small' color={tokkoEnabled ? 'success' : 'default'} label={tokkoEnabled ? 'Activa' : 'Inactiva'} />
            </Stack>
            <FormControlLabel control={<Switch checked={tokkoTabVisible} onChange={(e) => setTokkoTabVisible(e.target.checked)} />} label='Mostrar pestaña Tokko en UI' />
            <FormControlLabel control={<Switch checked={tokkoEnabled} onChange={(e) => setTokkoEnabled(e.target.checked)} />} label='Master enable Tokko' />
            <FormControlLabel control={<Switch checked={tokkoSyncLeadsEnabled} onChange={(e) => setTokkoSyncLeadsEnabled(e.target.checked)} />} label='Auto sync de leads' />
            <FormControlLabel control={<Switch checked={tokkoAgentSearchEnabled} onChange={(e) => setTokkoAgentSearchEnabled(e.target.checked)} />} label='Búsqueda de propiedades para IA' />
            <FormControlLabel control={<Switch checked={tokkoSyncContactsEnabled} onChange={(e) => setTokkoSyncContactsEnabled(e.target.checked)} />} label='Sync de contactos' />
            <FormControlLabel control={<Switch checked={tokkoSyncContactTagsEnabled} onChange={(e) => setTokkoSyncContactTagsEnabled(e.target.checked)} />} label='Sync de tags de contacto' />
            <FormControlLabel control={<Switch checked={tokkoFallbackToLocalSearch} onChange={(e) => setTokkoFallbackToLocalSearch(e.target.checked)} />} label='Fallback a búsqueda local' />
            <FormControlLabel control={<Switch checked={tokkoDebugLogsEnabled} onChange={(e) => setTokkoDebugLogsEnabled(e.target.checked)} />} label='Debug logs' />
            <FormControlLabel control={<Switch checked={tokkoRateLimitEnabled} onChange={(e) => setTokkoRateLimitEnabled(e.target.checked)} />} label='Rate limit habilitado' />
            <FormControlLabel control={<Switch checked={tokkoSafeWriteMode} onChange={(e) => setTokkoSafeWriteMode(e.target.checked)} />} label='Safe write mode (evita escrituras peligrosas)' />
            <TextField label='Tokko API Key' type='password' value={tokkoApiKey} onChange={(e) => setTokkoApiKey(e.target.value)} />
            <TextField label='Tokko Base URL (editable)' value={tokkoBaseUrl} onChange={(e) => setTokkoBaseUrl(e.target.value)} />
            <TextField label='Tokko Leads endpoint path (editable)' value={tokkoLeadsPath} onChange={(e) => setTokkoLeadsPath(e.target.value)} />
            <TextField label='Tokko Properties endpoint path (editable)' value={tokkoPropertiesPath} onChange={(e) => setTokkoPropertiesPath(e.target.value)} />
            <TextField label='Cooldown (segundos)' type='number' value={tokkoCooldownSeconds} onChange={(e) => setTokkoCooldownSeconds(e.target.value)} />
          </Stack>
        )}

        {tab === 1 && (
          <Stack spacing={1.5}>
            <Typography variant='h6'>Configuración Meta (Lead Ads)</Typography>
            <Typography variant='caption' color={metaLinked ? 'success.main' : 'warning.main'}>{metaLinked ? '✅ Meta vinculada' : '⚠️ Falta vincular Meta'}</Typography>
            <Typography variant='caption' color='text.secondary'>Última actualización: {metaLastUpdatedAt ? metaLastUpdatedAt.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) : '-'}</Typography>
            <FormControlLabel control={<Switch checked={metaLeadAdsEnabled} onChange={(e) => setMetaLeadAdsEnabled(e.target.checked)} />} label='Habilitar conexión Meta Lead Ads' />
            <TextField label='Webhook Verify Token' value={metaLeadAdsWebhookVerifyToken} InputProps={{ readOnly: true }} helperText='Token fijo por defecto para Meta Developers.' />
            <TextField label='Meta App ID (placeholder)' value={metaLeadAdsAppId} onChange={(e) => setMetaLeadAdsAppId(e.target.value)} />
            <TextField label='Meta App Secret (placeholder)' type='password' value={metaLeadAdsAppSecret} onChange={(e) => { setMetaLeadAdsAppSecret(e.target.value); setMetaLeadAdsAppSecretSaved(false); }} helperText={metaLeadAdsAppSecretSaved ? 'Secreto guardado en CRM.' : 'Si lo cambiás, guardá configuración Meta.'} />
            <TextField label='Meta Page ID (placeholder)' value={metaLeadAdsPageId} onChange={(e) => setMetaLeadAdsPageId(e.target.value)} />
            <Typography variant='body2' color='text.secondary'>Webhook: https://login.charlott.ai/api/ai/meta-leads/webhook</Typography>
            <Typography variant='caption' color='text.secondary'>Estado webhook: {webhookStatus ? (webhookStatus.verifyTokenConfigured ? 'verify token OK' : 'falta verify token') : 'sin datos'}</Typography>
            <Button variant='contained' onClick={save} disabled={saving} sx={{ alignSelf: 'flex-start' }}>{saving ? 'Guardando…' : 'Guardar configuración Meta'}</Button>

            <Divider />
            <Typography variant='h6'>Recaptación por inactividad</Typography>
            <FormControlLabel control={<Switch checked={waRecapEnabled} onChange={(e) => setWaRecapEnabled(e.target.checked)} />} label='Activar recaptación automática' />
            <TextField label='Template de recaptación' value={waRecapTemplateName} onChange={(e) => setWaRecapTemplateName(e.target.value)} helperText='Ej: recaptacion_3_dias' />
            <TextField label='Idioma template' value={waRecapTemplateLang} onChange={(e) => setWaRecapTemplateLang(e.target.value)} helperText='Ej: es_AR o en' />
            <TextField label='Tiempo de inactividad (horas)' type='number' value={waRecapInactivityHours} onChange={(e) => setWaRecapInactivityHours(e.target.value)} helperText='Solo se recapta si el lead está abierto y el último mensaje fue del agente.' />

            <Divider />
            <Typography variant='h6'>Meta OAuth (WhatsApp Cloud)</Typography>
            <Typography variant='caption' color='text.secondary'>
              Estado OAuth: {metaOauthStatus?.status === 'connected' ? `conectado (phone ${metaOauthStatus?.phone_number_display || metaOauthStatus?.phone_number_id || '-'})` : 'sin conexión'}
            </Typography>
            <Stack direction='row' spacing={1}>
              <Button variant='contained' onClick={connectMetaOauth} disabled={metaOauthLoading}>
                {metaOauthLoading ? 'Conectando…' : 'Conectar con Meta'}
              </Button>
              <Button variant='outlined' onClick={loadMetaOauthStatus}>Actualizar estado</Button>
            </Stack>
            {/* Controles de mensaje de prueba ocultos por solicitud */}
          </Stack>
        )}

        {tab === 2 && (
          <Stack spacing={1.2}>
            <Typography variant='h6'>Templates (scaffold)</Typography>
            <Typography variant='body2' color='text.secondary'>La gestión CRUD está disponible en /templates (nuevo módulo inicial).</Typography>
          </Stack>
        )}

        <Divider sx={{ my: 2 }} />
        <Button variant='contained' onClick={save} disabled={saving}>{saving ? 'Guardando…' : 'Guardar configuración'}</Button>
      </Paper>
    </Box>
  );
};

export default Settings;
