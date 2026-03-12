import { useEffect, useState } from 'react';
import {
  Typography, Box, Paper, Divider, Tabs, Tab, Stack, Chip, Button, TextField, FormControlLabel, Switch, Alert
} from '@mui/material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const DEFAULT_META_LEADS_VERIFY_TOKEN = import.meta.env.VITE_META_LEADS_VERIFY_TOKEN || '';

const Settings = () => {
  const [tab, setTab] = useState(0);
  const [saving, setSaving] = useState(false);
  const [tokkoEnabled, setTokkoEnabled] = useState(false);
  const [tokkoApiKey, setTokkoApiKey] = useState('');
  const [tokkoBaseUrl, setTokkoBaseUrl] = useState('https://www.tokkobroker.com/api/v1');
  const [tokkoLeadsPath, setTokkoLeadsPath] = useState('/webcontact/');
  const [tokkoPropertiesPath, setTokkoPropertiesPath] = useState('/property/');
  const [tokkoCooldownSeconds, setTokkoCooldownSeconds] = useState('10');

  const [metaLeadAdsEnabled, setMetaLeadAdsEnabled] = useState(false);
  const [metaLeadAdsWebhookVerifyToken, setMetaLeadAdsWebhookVerifyToken] = useState(DEFAULT_META_LEADS_VERIFY_TOKEN);
  const [metaLeadAdsAppId, setMetaLeadAdsAppId] = useState('');
  const [metaLeadAdsAppSecret, setMetaLeadAdsAppSecret] = useState('');
  const [metaLeadAdsPageId, setMetaLeadAdsPageId] = useState('');
  const [webhookStatus, setWebhookStatus] = useState<any>(null);

  const [metaOauthStatus, setMetaOauthStatus] = useState<any>(null);
  const [metaOauthLoading, setMetaOauthLoading] = useState(false);
  const [routingRules, setRoutingRules] = useState<any[]>([]);
  const [duplicates, setDuplicates] = useState<any[]>([]);

  const tokkoConfigValid = (() => {
    const cooldown = Number(tokkoCooldownSeconds);
    return tokkoBaseUrl.startsWith('http') && tokkoLeadsPath.startsWith('/') && tokkoPropertiesPath.startsWith('/') && Number.isFinite(cooldown) && cooldown >= 0;
  })();

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
      setTokkoCooldownSeconds(String(s.tokkoCooldownSeconds || 10));

      setMetaLeadAdsEnabled(Boolean(s.metaLeadAdsEnabled ?? false));
      setMetaLeadAdsWebhookVerifyToken(String(s.metaLeadAdsWebhookVerifyToken || DEFAULT_META_LEADS_VERIFY_TOKEN));
      setMetaLeadAdsAppId(String(s.metaLeadAdsAppId || ''));
      setMetaLeadAdsAppSecret('');
      setMetaLeadAdsPageId(String(s.metaLeadAdsPageId || ''));

      try {
        const ws = await api.get('/settings/meta/webhook-status');
        setWebhookStatus(ws.data || null);
      } catch {
        setWebhookStatus(null);
      }

      await loadMetaOauthStatus();

      try {
        const [{ data: routing }, { data: dups }] = await Promise.all([
          api.get('/ai/routing/rules').catch(() => ({ data: { rules: [] } })),
          api.get('/ai/dedupe/candidates').catch(() => ({ data: [] }))
        ]);
        setRoutingRules(Array.isArray(routing?.rules) ? routing.rules : []);
        setDuplicates(Array.isArray(dups) ? dups : []);
      } catch {
        setRoutingRules([]);
        setDuplicates([]);
      }
    } catch {
      // noop
    }
  };

  useEffect(() => { load(); }, []);

  const save = async () => {
    if (!tokkoConfigValid) {
      toast.error('Revisá URL de Tokko, paths y cooldown');
      return;
    }

    setSaving(true);
    try {
      const payload: any = {
        tokkoEnabled,
        tokkoBaseUrl,
        tokkoLeadsPath,
        tokkoPropertiesPath,
        tokkoSyncLeadsEnabled: true,
        tokkoAgentSearchEnabled: true,
        tokkoSyncContactsEnabled: true,
        tokkoSyncContactTagsEnabled: true,
        tokkoFallbackToLocalSearch: true,
        tokkoDebugLogsEnabled: false,
        tokkoRateLimitEnabled: true,
        tokkoCooldownSeconds: Number(tokkoCooldownSeconds || 10),
        tokkoSafeWriteMode: true,
        tokkoTabVisible: true,

        metaLeadAdsEnabled,
        metaLeadAdsAppId,
        metaLeadAdsPageId
      };

      if (tokkoApiKey && tokkoApiKey.trim()) payload.tokkoApiKey = tokkoApiKey.trim();
      if (metaLeadAdsWebhookVerifyToken && metaLeadAdsWebhookVerifyToken.trim()) payload.metaLeadAdsWebhookVerifyToken = metaLeadAdsWebhookVerifyToken.trim();
      if (metaLeadAdsAppSecret && metaLeadAdsAppSecret.trim()) payload.metaLeadAdsAppSecret = metaLeadAdsAppSecret.trim();

      await Promise.all([
        api.put('/settings/whatsapp-cloud', payload),
        api.put('/ai/routing/rules', {
          rules: routingRules.map((r) => ({
            id: r.id,
            name: r.name,
            source: r.source || '',
            tagsAny: Array.isArray(r.tagsAny) ? r.tagsAny : [],
            assignUserId: r.assignUserId ? Number(r.assignUserId) : null,
            queue: r.queue || '',
            weight: Number(r.weight || 0),
            enabled: r.enabled !== false
          }))
        })
      ]);
      await loadMetaOauthStatus();
      toast.success('Configuración guardada');
    } catch {
      toast.error('No se pudo guardar la Configuración');
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
        try {
          const oauthHost = new URL(data.oauthUrl).hostname;
          if (!oauthHost.endsWith('facebook.com') && !oauthHost.endsWith('meta.com')) {
            toast.error('URL de OAuth no válida');
            return;
          }
        } catch {
          toast.error('URL de OAuth malformada');
          return;
        }
        window.location.href = data.oauthUrl;
        return;
      }
    } catch {
      toast.error('No se pudo iniciar conexión con Meta');
    } finally {
      setMetaOauthLoading(false);
    }
  };

  return (
    <Box>
      <Typography variant='h4' gutterBottom>Configuración</Typography>
      <Paper sx={{ p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} sx={{ mb: 1.5 }}>
          <Chip size='small' color={tokkoEnabled ? 'success' : 'default'} label={`Tokko ${tokkoEnabled ? 'ON' : 'OFF'}`} />
          <Chip size='small' color={metaLeadAdsEnabled ? 'success' : 'default'} label={`Meta Lead Ads ${metaLeadAdsEnabled ? 'ON' : 'OFF'}`} />
          <Chip size='small' color={metaOauthStatus?.status === 'connected' ? 'success' : 'warning'} label={`OAuth ${metaOauthStatus?.status === 'connected' ? 'conectado' : 'pendiente'}`} />
        </Stack>

        <Alert severity='info' sx={{ mb: 2 }}>
          Guía rápida: 1) Configurá Tokko, 2) Conectá Meta OAuth, 3) Probá envío, 4) Guardá. Si algo falla, no se pierde el estado actual.
        </Alert>

        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant='scrollable' scrollButtons='auto'>
          <Tab label='Tokko' />
          <Tab label='Configuración Meta' />
          <Tab label='Templates' />
          <Tab label='Enrutamiento & Score' />
          <Tab label='Duplicados & Merge' />
        </Tabs>
        <Divider sx={{ my: 2 }} />

        {tab === 0 && (
          <Stack spacing={1.2}>
            {!tokkoConfigValid && (
              <Alert severity='warning'>
                Configuración inválida: la URL debe empezar con http(s), los endpoints con '/' y el cooldown debe ser mayor o igual a 0.
              </Alert>
            )}
            <Stack direction='row' spacing={1} alignItems='center'>
              <Typography variant='h6'>Integración Tokko Broker</Typography>
              <Chip size='small' color={tokkoEnabled ? 'success' : 'default'} label={tokkoEnabled ? 'Activa' : 'Inactiva'} />
            </Stack>
            <FormControlLabel control={<Switch checked={tokkoEnabled} onChange={(e) => setTokkoEnabled(e.target.checked)} />} label='Sincronización general Tokko (incluye todos los sync)' />
            <TextField label='Tokko API Key' type='password' value={tokkoApiKey} onChange={(e) => setTokkoApiKey(e.target.value)} />
            <TextField label='Tokko Base URL (editable)' value={tokkoBaseUrl} onChange={(e) => setTokkoBaseUrl(e.target.value)} />
            <TextField label='Tokko Leads endpoint path (editable)' value={tokkoLeadsPath} onChange={(e) => setTokkoLeadsPath(e.target.value)} />
            <TextField label='Tokko Properties endpoint path (editable)' value={tokkoPropertiesPath} onChange={(e) => setTokkoPropertiesPath(e.target.value)} />
            <TextField label='Cooldown (segundos)' type='number' value={tokkoCooldownSeconds} onChange={(e) => setTokkoCooldownSeconds(e.target.value)} />
          </Stack>
        )}

        {tab === 1 && (
          <Stack spacing={1.5}>
            <Typography variant='h6'>Configuración Meta</Typography>
            <Typography variant='body2' color='text.secondary'>
              Todo el flujo de Meta queda separado en 3 bloques: credenciales, webhook y OAuth. Guardá al final.
            </Typography>

            <Paper variant='outlined' sx={{ p: 1.5 }}>
              <Stack spacing={1.2}>
                <Stack direction='row' spacing={1} alignItems='center'>
                  <Typography variant='subtitle1'>1) Lead Ads (credenciales)</Typography>
                  <Chip size='small' color={metaLeadAdsEnabled ? 'success' : 'default'} label={metaLeadAdsEnabled ? 'Activo' : 'Inactivo'} />
                </Stack>
                <FormControlLabel control={<Switch checked={metaLeadAdsEnabled} onChange={(e) => setMetaLeadAdsEnabled(e.target.checked)} />} label='Habilitar conexión Meta Lead Ads' />
                <TextField label='Meta App ID' value={metaLeadAdsAppId} onChange={(e) => setMetaLeadAdsAppId(e.target.value)} />
                <TextField label='Meta App Secret' type='password' value={metaLeadAdsAppSecret} onChange={(e) => setMetaLeadAdsAppSecret(e.target.value)} helperText='Dejar vacío = no cambiar. Completar solo para actualizar secreto.' />
                <TextField label='Meta Page ID' value={metaLeadAdsPageId} onChange={(e) => setMetaLeadAdsPageId(e.target.value)} />
              </Stack>
            </Paper>

            <Paper variant='outlined' sx={{ p: 1.5 }}>
              <Stack spacing={1.2}>
                <Typography variant='subtitle1'>2) Webhook (Meta Developers)</Typography>
                <TextField label='Webhook Verify Token' value={metaLeadAdsWebhookVerifyToken} InputProps={{ readOnly: true }} helperText='Usar este valor en Meta Developers.' />
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

            <Paper variant='outlined' sx={{ p: 1.5 }}>
              <Stack spacing={1.2}>
                <Typography variant='subtitle1'>3) OAuth (WhatsApp Cloud)</Typography>
                <Typography variant='caption' color='text.secondary'>
                  Estado OAuth: {metaOauthStatus?.status === 'connected' ? `conectado (phone ${metaOauthStatus?.phone_number_display || metaOauthStatus?.phone_number_id || '-'})` : 'sin conexión'}
                </Typography>
                <Stack direction='row' spacing={1}>
                  <Button variant='contained' onClick={connectMetaOauth} disabled={metaOauthLoading}>
                    {metaOauthLoading ? 'Conectando…' : 'Conectar con Meta'}
                  </Button>
                  <Button variant='outlined' onClick={loadMetaOauthStatus}>Actualizar estado</Button>
                </Stack>
              </Stack>
            </Paper>
          </Stack>
        )}

        {tab === 2 && (
          <Stack spacing={1.2}>
            <Typography variant='h6'>Templates (scaffold)</Typography>
            <Typography variant='body2' color='text.secondary'>La gestión CRUD está disponible en /templates (nuevo módulo inicial).</Typography>
          </Stack>
        )}

        {tab === 3 && (
          <Stack spacing={1.2}>
            <Typography variant='h6'>Reglas de enrutamiento y score</Typography>
            <Alert severity='info'>Persistencia backend activa. Se evalúa por fuente + tags y asignación por usuario o cola.</Alert>
            {routingRules.map((rule) => (
              <Paper key={rule.id} variant='outlined' sx={{ p: 1.2 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
                  <TextField size='small' label='Nombre' value={rule.name || ''} onChange={(e) => setRoutingRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, name: e.target.value } : r))} sx={{ flex: 1 }} />
                  <TextField size='small' label='Fuente (ej: meta)' value={rule.source || ''} onChange={(e) => setRoutingRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, source: e.target.value } : r))} sx={{ width: 180 }} />
                  <TextField size='small' label='Tags any (coma sep.)' value={Array.isArray(rule.tagsAny) ? rule.tagsAny.join(',') : ''} onChange={(e) => setRoutingRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, tagsAny: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } : r))} sx={{ flex: 1 }} />
                  <TextField size='small' label='Queue' value={rule.queue || ''} onChange={(e) => setRoutingRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, queue: e.target.value } : r))} sx={{ width: 150 }} />
                  <TextField size='small' type='number' label='Assign User ID' value={rule.assignUserId || ''} onChange={(e) => setRoutingRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, assignUserId: e.target.value ? Number(e.target.value) : null } : r))} sx={{ width: 140 }} />
                  <TextField size='small' type='number' label='Peso' value={rule.weight || 0} onChange={(e) => setRoutingRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, weight: Number(e.target.value || 0) } : r))} sx={{ width: 100 }} />
                  <FormControlLabel control={<Switch checked={rule.enabled !== false} onChange={(e) => setRoutingRules((prev) => prev.map((r) => r.id === rule.id ? { ...r, enabled: e.target.checked } : r))} />} label='Activa' />
                </Stack>
              </Paper>
            ))}
            <Button variant='outlined' onClick={() => setRoutingRules((prev) => [...prev, { id: Date.now(), name: 'Nueva regla', source: 'web', tagsAny: [], assignUserId: null, queue: 'default', weight: 50, enabled: true }])}>Agregar regla</Button>
          </Stack>
        )}

        {tab === 4 && (
          <Stack spacing={1.2}>
            <Typography variant='h6'>Detección de duplicados y merge asistido</Typography>
            <Typography variant='body2' color='text.secondary'>Fuente backend: /ai/dedupe/candidates. El merge conserva el principal y re-asigna tickets/mensajes.</Typography>
            {duplicates.length === 0 ? (
              <Alert severity='success'>No se detectaron duplicados.</Alert>
            ) : (
              duplicates.map((dup: any, idx: number) => {
                const ids = Array.isArray(dup.contact_ids) ? dup.contact_ids : [];
                const primaryId = Number(dup.primary_contact_id || ids[0] || 0);
                const secondaryId = Number(ids.find((x: any) => Number(x) !== primaryId) || 0);
                return (
                  <Paper key={`${dup.dedupe_key_type}-${dup.dedupe_key}-${idx}`} variant='outlined' sx={{ p: 1.2 }}>
                    <Stack direction='row' justifyContent='space-between' alignItems='center' sx={{ mb: 0.8 }}>
                      <Typography variant='subtitle2'>[{dup.dedupe_key_type}] {dup.dedupe_key} · {dup.qty} registros</Typography>
                      <Button
                        size='small'
                        variant='contained'
                        disabled={!primaryId || !secondaryId}
                        onClick={async () => {
                          try {
                            await api.post('/ai/dedupe/merge', { primaryContactId: primaryId, secondaryContactId: secondaryId });
                            toast.success(`Merge OK: ${secondaryId} â†’ ${primaryId}`);
                            await load();
                          } catch (e: any) {
                            toast.error(e?.response?.data?.error || 'No se pudo ejecutar merge');
                          }
                        }}
                      >
                        Merge asistido
                      </Button>
                    </Stack>
                    <Typography variant='caption'>Principal: #{primaryId} · Secundario sugerido: #{secondaryId || '-'}</Typography>
                    <Typography variant='caption' sx={{ display: 'block' }}>IDs detectados: {ids.join(', ') || '-'}</Typography>
                  </Paper>
                );
              })
            )}
          </Stack>
        )}

        <Divider sx={{ my: 2 }} />
        <Button variant='contained' onClick={save} disabled={saving || !tokkoConfigValid}>{saving ? 'Guardandoâ€¦' : 'Guardar Configuración'}</Button>
      </Paper>
    </Box>
  );
};

export default Settings;




