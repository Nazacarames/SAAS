import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Box, Typography, Stack, Button, Chip, IconButton, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, Select, MenuItem, FormControl,
  InputLabel, CircularProgress, InputAdornment, Paper, Tooltip, Checkbox,
  Alert, Menu,
} from '@mui/material';
import {
  Add as AddIcon, Edit as EditIcon, Delete as DeleteIcon,
  ContentCopy as CopyIcon, CheckCircle as CheckIcon,
  Cancel as CancelIcon, Refresh as TestIcon,
  Visibility, VisibilityOff, Bolt as BoltIcon,
} from '@mui/icons-material';
import { toast } from 'react-toastify';
import api from '../../services/api';

const CHANNEL_META: Record<string, { label: string; color: string; icon: string; fields: string[] }> = {
  whatsapp:  { label: 'WhatsApp',  color: '#25D366', icon: 'W', fields: ['Phone Number ID', 'Access Token', 'App Secret'] },
  instagram: { label: 'Instagram', color: '#E1306C', icon: 'I', fields: ['IG Account ID', 'Access Token'] },
  messenger: { label: 'Messenger', color: '#0084FF', icon: 'M', fields: ['Page ID', 'Access Token'] },
};

const WEBHOOK_URL = `${window.location.origin}/webhooks/meta`;

const copyText = (text: string, label: string) => {
  navigator.clipboard.writeText(text);
  toast.success(`${label} copiado`);
};

interface Channel {
  id: number;
  channel_type: string;
  name: string;
  status: string;
  external_id: string;
  display?: string;
  verify_token: string;
  has_token: boolean;
  created_at: string;
}

// Assets discovered by POST /channels/discover
interface DiscoveredAssets {
  token_info: { type: string; expires_at: number; never_expires: boolean; app_id?: string; foreign_app?: boolean };
  whatsapp: { id: string; display_phone_number: string; verified_name: string; quality_rating: string; waba_name: string; already_connected: boolean }[];
  instagram: { id: string; username: string; page_name: string; access_token: string; already_connected: boolean }[];
  messenger: { id: string; name: string; access_token: string; already_connected: boolean }[];
  warnings: string[];
}

const Connections = () => {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; data?: any; error?: string }>>({});

  // Assisted "Conectar con Meta" wizard
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizToken, setWizToken] = useState('');
  const [wizShowToken, setWizShowToken] = useState(false);
  const [wizDiscovering, setWizDiscovering] = useState(false);
  const [wizAssets, setWizAssets] = useState<DiscoveredAssets | null>(null);
  const [wizSelected, setWizSelected] = useState<Set<string>>(new Set());
  const [wizConnecting, setWizConnecting] = useState(false);
  const [wizAppSecret, setWizAppSecret] = useState('');
  const [waMenuAnchor, setWaMenuAnchor] = useState<null | HTMLElement>(null);

  const [formType, setFormType] = useState('whatsapp');
  const [formName, setFormName] = useState('');
  const [formExternalId, setFormExternalId] = useState('');
  const [formToken, setFormToken] = useState('');
  const [formAppSecret, setFormAppSecret] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);
  const [saving, setSaving] = useState(false);

  const companyVerifyToken = channels.find((c) => c.verify_token)?.verify_token || '';

  // Embedded Signup oficial de WhatsApp (Tech Provider): popup de Meta,
  // el cliente elige su WABA y número, el backend canjea el code y conecta.
  const [esConfig, setEsConfig] = useState<{ app_id: string; config_id: string; login_config_id?: string; login_scopes?: string; ready: boolean } | null>(null);
  const [esConnecting, setEsConnecting] = useState(false);
  // ref (no variable de render): el listener se registra una sola vez y el
  // callback de FB.login corre en otro render — con una variable local el
  // waba_id capturado se perdía (stale closure) y el canal nunca se creaba
  const esSession = useRef({ waba_id: '', phone_number_id: '', event: '', step: '' });
  // una sola conexión por intento: el registro puede terminar por el mensaje de
  // Meta o por el callback de FB.login, y sin esto se dispararían las dos
  const esEnviado = useRef(false);
  const esTimer = useRef<any>(null);
  // el listener se registra una sola vez, así que llama por ref a la versión
  // actual de conectarES en vez de a la del primer render (stale closure)
  const conectarRef = useRef<(code: string, s: any) => void>(() => {});

  useEffect(() => {
    api.get('/channels/embedded-signup/config').then(({ data }) => setEsConfig(data)).catch(() => {});
    const onMsg = (event: MessageEvent) => {
      if (!String(event.origin).includes('facebook.com')) return;
      // Meta manda el session info como string JSON, pero según la versión de la
      // SDK puede llegar ya parseado. Con JSON.parse a secas ese caso explotaba
      // y el dato se perdía en silencio: el registro terminaba bien y el CRM
      // igual decía que Meta no había devuelto nada.
      let d: any = event.data;
      if (typeof d === 'string') {
        try { d = JSON.parse(d); } catch { return; }
      }
      if (!d || d.type !== 'WA_EMBEDDED_SIGNUP' || !d.data) return;
      const s = esSession.current;
      s.waba_id = d.data.waba_id || s.waba_id;
      s.phone_number_id = d.data.phone_number_id || s.phone_number_id;
      s.event = d.data.event || s.event;
      s.step = d.data.current_step || s.step;

      // El registro terminó. Se le da un margen al callback de FB.login para que
      // traiga el code (es el camino bueno: da también las páginas e Instagram);
      // si no llega —cookies de terceros bloqueadas, popup cerrado a mano— se
      // conecta igual con el WABA que ya mandó Meta.
      if (s.event === 'FINISH' && s.waba_id) {
        clearTimeout(esTimer.current);
        esTimer.current = setTimeout(() => conectarRef.current('', { ...s }), 2500);
      }
    };
    window.addEventListener('message', onMsg);
    return () => { window.removeEventListener('message', onMsg); clearTimeout(esTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const conectarES = (code: string, s: { waba_id: string; phone_number_id: string }) => {
    if (esEnviado.current) return;
    esEnviado.current = true;
    clearTimeout(esTimer.current);
    setEsConnecting(true);
    api.post('/channels/embedded-signup', {
      code, waba_id: s.waba_id, phone_number_id: s.phone_number_id,
    }).then(({ data }) => {
      toast.success(`WhatsApp ${data.phone || ''} conectado`);
      (data.warnings || []).forEach((w: string) => toast.warning(w, { autoClose: 10000 }));
      load();
      // El mismo permiso da acceso a sus páginas e Instagram: ofrecer conectarlos
      const extra = data.extra_assets || {};
      if ((extra.instagram || []).length || (extra.messenger || []).length) {
        setWizToken(extra.token || '');
        setWizAssets({
          token_info: { type: 'business', expires_at: 0, never_expires: true },
          whatsapp: [], instagram: extra.instagram || [], messenger: extra.messenger || [],
          warnings: [],
        });
        setWizSelected(new Set());
        setWizardOpen(true);
        toast.info('Encontramos Instagram/Facebook de tu negocio — elegí cuáles conectar', { autoClose: 8000 });
      }
    }).catch((e: any) => {
      toast.error(e?.response?.data?.detail || 'No se pudo conectar');
    }).finally(() => setEsConnecting(false));
  };
  conectarRef.current = conectarES;

  const withFbSdk = (fn: () => void) => {
    if ((window as any).FB) { fn(); return; }
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/es_LA/sdk.js';
    s.async = true;
    s.onload = () => {
      (window as any).FB.init({ appId: esConfig!.app_id, autoLogAppEvents: true, xfbml: false, version: 'v21.0' });
      fn();
    };
    document.body.appendChild(s);
  };

  // featureType '' = número nuevo Cloud API; 'whatsapp_business_app_onboarding'
  // = coexistencia (números que siguen usando la app WhatsApp Business del
  // celular — el popup los empareja por QR; sin esto NUNCA aparecen en la lista)
  const startEmbeddedSignup = (featureType: string = '') => {
    if (!esConfig?.ready) {
      toast.info('Falta configurar el Embedded Signup en la app de Meta (config_id)');
      return;
    }
    // Cada intento arranca limpio: si no, el WABA que quedó de un intento
    // anterior se manda en el siguiente y se conecta la cuenta equivocada.
    esSession.current = { waba_id: '', phone_number_id: '', event: '', step: '' };
    esEnviado.current = false;
    clearTimeout(esTimer.current);

    withFbSdk(() => {
      (window as any).FB.login((response: any) => {
        const code = response?.authResponse?.code || '';
        const s = esSession.current;
        // Sin code pero con session info (waba/número del popup) igual conectamos:
        // el backend usa el token de sistema del proveedor. Sin nada, fue cancelado
        // o el navegador bloqueó la respuesta de Meta.
        if (!code && !s.waba_id) {
          if (s.event === 'CANCEL') {
            toast.warning(s.step
              ? `Quedó a medias el registro en Meta (paso: ${s.step}). Volvé a intentarlo y completá todos los pasos.`
              : 'Cerraste la ventana de Meta antes de terminar el registro.');
          } else {
            toast.error('Meta no devolvió la autorización. Si completaste el registro, permití las cookies de terceros y probá de nuevo.');
          }
          return;
        }
        conectarES(code, s);
      }, {
        config_id: esConfig.config_id,
        response_type: 'code',
        override_default_response_type: true,
        extras: { setup: {}, featureType, sessionInfoVersion: '3' },
      });
    });
  };

  // Instagram / Messenger con login de Meta (sin pasar por el registro de WhatsApp)
  const startSocialLogin = () => {
    if (!esConfig?.app_id) {
      toast.info('Falta configurar el login de Meta');
      return;
    }
    // Sin una config propia de Facebook Login for Business, el login va por
    // scopes y devuelve el access_token directo (el flujo con code del login
    // por scopes va atado al redirect_uri del SDK y el canje server-side
    // falla). El backend lo alarga a ~60 días.
    const hasConfig = Boolean(esConfig.login_config_id);
    const loginOpts: any = hasConfig
      ? { config_id: esConfig.login_config_id, response_type: 'code', override_default_response_type: true }
      : { scope: esConfig.login_scopes || 'pages_show_list,pages_messaging,instagram_basic,instagram_manage_messages' };
    withFbSdk(() => {
      (window as any).FB.login((response: any) => {
        const code = response?.authResponse?.code;
        const accessToken = response?.authResponse?.accessToken;
        if (!code && !accessToken) { toast.info('Conexión cancelada'); return; }
        setEsConnecting(true);
        api.post('/channels/oauth-discover', code ? { code } : { access_token: accessToken }).then(({ data }) => {
          if (!data.ok) { toast.error(data.error || 'No se pudieron listar los activos'); return; }
          setWizToken(data.token || '');
          setWizAssets(data);
          setWizSelected(new Set());
          setWizardOpen(true);
        }).catch((e: any) => {
          toast.error(e?.response?.data?.detail || 'No se pudo conectar');
        }).finally(() => setEsConnecting(false));
      }, loginOpts);
    });
  };

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/channels');
      setChannels(data.channels || []);
    } catch {
      toast.error('No se pudieron cargar los canales');
    } finally {
      setLoading(false);
    }
  }, []);

  // Estado real contra Meta: un canal "activo" sin webhooks suscriptos no
  // recibe ningún mensaje, y eso antes no se veía en ningún lado
  // ── Pixel de Meta ──
  const [pixel, setPixel] = useState<any>({ pixel_id: '', currency: 'ARS', enabled: true });
  const [pixelId, setPixelId] = useState('');
  const [pixelToken, setPixelToken] = useState('');
  const [pixelTestCode, setPixelTestCode] = useState('');
  const [pixelOpciones, setPixelOpciones] = useState<any[]>([]);
  const [pixelBusy, setPixelBusy] = useState(false);

  const loadPixel = async () => {
    try {
      const { data } = await api.get('/integrations/pixel');
      setPixel(data);
      setPixelId(data.pixel_id || '');
    } catch { /* la tarjeta queda vacia */ }
  };
  useEffect(() => { loadPixel(); }, []);

  const buscarPixeles = async () => {
    setPixelBusy(true);
    try {
      const { data } = await api.get('/integrations/pixel/disponibles');
      setPixelOpciones(data.pixeles || []);
      if (!data.ok) toast.warning(data.detail || 'No se pudieron listar los píxeles');
      else if (!(data.pixeles || []).length) toast.info('El token de esta empresa no ve ningún píxel');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudieron buscar los píxeles');
    } finally { setPixelBusy(false); }
  };

  const guardarPixel = async () => {
    setPixelBusy(true);
    try {
      const { data } = await api.put('/integrations/pixel', {
        pixel_id: pixelId.trim(),
        token: pixelToken.trim() || undefined,
        currency: pixel.currency || 'ARS',
        enabled: pixel.enabled,
      });
      setPixel(data);
      setPixelToken('');
      if (data.verificacion?.ok) toast.success(`Píxel "${data.verificacion.name}" verificado`);
      else toast.warning(data.verificacion?.detail || 'Guardado, pero no se pudo verificar el píxel');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo guardar');
    } finally { setPixelBusy(false); }
  };

  const probarPixel = async () => {
    setPixelBusy(true);
    try {
      await api.post('/integrations/pixel/probar', { test_event_code: pixelTestCode.trim() });
      toast.success('Evento enviado. Miralo en Events Manager, pestaña "Eventos de prueba"');
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo enviar el evento de prueba');
    } finally { setPixelBusy(false); }
  };

  const [diag, setDiag] = useState<Record<number, { token_ok: boolean; webhooks_ok: boolean; problem: string; display?: string }>>({});
  const [checking, setChecking] = useState(false);
  const [repairing, setRepairing] = useState<number | null>(null);

  const runDiagnose = useCallback(async (silent = true) => {
    setChecking(true);
    try {
      const { data } = await api.get('/channels/diagnose');
      const map: Record<number, any> = {};
      (data.channels || []).forEach((c: any) => { map[c.id] = c; });
      setDiag(map);
      if (!silent) {
        if (data.problems) toast.warning(`${data.problems} canal(es) con problemas`);
        else toast.success('Todos los canales reciben mensajes correctamente');
      }
    } catch {
      if (!silent) toast.error('No se pudo verificar el estado de los canales');
    } finally {
      setChecking(false);
    }
  }, []);

  const repairChannel = async (ch: Channel) => {
    setRepairing(ch.id);
    try {
      const { data } = await api.post(`/channels/${ch.id}/repair`);
      toast.success(data.message || 'Canal reparado');
      await runDiagnose();
      load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo reparar el canal');
    } finally {
      setRepairing(null);
    }
  };

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (channels.length) runDiagnose(true); }, [channels.length, runDiagnose]);

  const openCreate = () => {
    setEditing(null);
    setFormType('whatsapp');
    setFormName('');
    setFormExternalId('');
    setFormToken('');
    setFormAppSecret('');
    setDialogOpen(true);
  };

  const openEdit = (ch: Channel) => {
    setEditing(ch);
    setFormType(ch.channel_type);
    setFormName(ch.name);
    setFormExternalId(ch.external_id);
    setFormToken('');
    setFormAppSecret('');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/channels/${editing.id}`, {
          name: formName || undefined,
          external_id: formExternalId || undefined,
          access_token: formToken || undefined,
          app_secret: formAppSecret || undefined,
        });
        toast.success('Canal actualizado');
      } else {
        const { data } = await api.post('/channels', {
          channel_type: formType,
          name: formName || CHANNEL_META[formType]?.label || formType,
          external_id: formExternalId,
          access_token: formToken,
          app_secret: formAppSecret,
        });
        toast.success('Canal creado');
        if (data?.channel?.id) handleTest(data.channel as Channel); // verificación inmediata
      }
      setDialogOpen(false);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (ch: Channel) => {
    const enable = ch.status !== 'active';
    try {
      await api.put(`/channels/${ch.id}`, { status: enable ? 'active' : 'disabled' });
      toast.success(enable ? 'Canal habilitado' : 'Canal deshabilitado — no recibe ni envía mensajes');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'No se pudo cambiar el estado');
    }
  };

  const handleDelete = async (ch: Channel) => {
    if (!confirm(`¿Eliminar DEFINITIVAMENTE el canal "${ch.name}"? Se borra su conexión con Meta y habrá que reconectarlo para volver a usarlo.`)) return;
    try {
      await api.delete(`/channels/${ch.id}?hard=true`);
      toast.success('Canal eliminado');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al eliminar');
    }
  };

  const handleTest = async (ch: Channel) => {
    setTestResults(prev => ({ ...prev, [ch.id]: { ok: false, error: 'testing...' } }));
    try {
      const { data } = await api.post(`/channels/${ch.id}/test`);
      setTestResults(prev => ({ ...prev, [ch.id]: data }));
      if (data.ok) toast.success(`${ch.name}: conexión verificada`);
      else toast.error(`${ch.name}: ${data.error || 'error'}`);
    } catch (e: any) {
      setTestResults(prev => ({ ...prev, [ch.id]: { ok: false, error: e?.response?.data?.detail || 'Error' } }));
      toast.error('Error al testear');
    }
  };

  const meta = (type: string) => CHANNEL_META[type] || { label: type, color: '#888', icon: '?', fields: [] };

  // ── Wizard "Conectar con Meta" ──────────────────────────────────────
  const openWizard = () => {
    setWizToken('');
    setWizAssets(null);
    setWizSelected(new Set());
    setWizardOpen(true);
  };

  const wizDiscover = async () => {
    if (!wizToken.trim()) return;
    setWizDiscovering(true);
    setWizAssets(null);
    try {
      const { data } = await api.post('/channels/discover', { access_token: wizToken.trim() });
      if (!data.ok) {
        toast.error(data.error || 'Token inválido');
        return;
      }
      setWizAssets(data);
      // Pre-select everything not yet connected
      const pre = new Set<string>();
      data.whatsapp.forEach((w: any) => { if (!w.already_connected) pre.add(`whatsapp:${w.id}`); });
      data.instagram.forEach((i: any) => { if (!i.already_connected) pre.add(`instagram:${i.id}`); });
      data.messenger.forEach((p: any) => { if (!p.already_connected) pre.add(`messenger:${p.id}`); });
      setWizSelected(pre);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Error al detectar activos');
    } finally {
      setWizDiscovering(false);
    }
  };

  const wizToggle = (key: string) => {
    setWizSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const wizConnect = async () => {
    if (!wizAssets || wizSelected.size === 0) return;
    setWizConnecting(true);
    let created = 0, failed = 0;
    // Token de otra app de Meta: adjuntar su App Secret a cada canal para que
    // el CRM pueda verificar la firma de esos webhooks
    const extraSecret = wizAssets.token_info?.foreign_app ? wizAppSecret.trim() : '';
    const jobs: { channel_type: string; name: string; external_id: string; access_token: string; app_secret?: string }[] = [];
    wizAssets.whatsapp.forEach(w => {
      if (wizSelected.has(`whatsapp:${w.id}`)) jobs.push({
        channel_type: 'whatsapp',
        name: w.verified_name || w.display_phone_number || 'WhatsApp',
        external_id: w.id,
        access_token: wizToken.trim(),
        app_secret: extraSecret,
      });
    });
    wizAssets.instagram.forEach(i => {
      if (wizSelected.has(`instagram:${i.id}`)) jobs.push({
        channel_type: 'instagram',
        name: i.username ? `@${i.username}` : 'Instagram',
        external_id: i.id,
        access_token: i.access_token || wizToken.trim(), // page token: mejor para mensajería
        app_secret: extraSecret,
      });
    });
    wizAssets.messenger.forEach(p => {
      if (wizSelected.has(`messenger:${p.id}`)) jobs.push({
        channel_type: 'messenger',
        name: p.name || 'Messenger',
        external_id: p.id,
        access_token: p.access_token || wizToken.trim(),
        app_secret: extraSecret,
      });
    });
    for (const job of jobs) {
      try {
        const { data } = await api.post('/channels', job);
        created++;
        if (data?.channel?.id) handleTest(data.channel as Channel); // verificación inmediata
      } catch (e: any) {
        failed++;
        toast.error(`${job.name}: ${e?.response?.data?.detail || 'error al crear'}`);
      }
    }
    setWizConnecting(false);
    if (created > 0) {
      toast.success(`${created} canal${created > 1 ? 'es' : ''} conectado${created > 1 ? 's' : ''}`);
      setWizardOpen(false);
      await load();
    } else if (failed === 0) {
      toast.info('No seleccionaste ningún activo');
    }
  };

  if (loading) {
    return <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}><CircularProgress sx={{ color: '#E8A020' }} /></Box>;
  }

  return (
    <Box sx={{ maxWidth: 900, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700, fontSize: '1.5rem', color: '#E8EBF2' }}>
            Canales
          </Typography>
          <Typography sx={{ fontSize: '0.82rem', color: 'rgba(255,255,255,0.4)' }}>
            WhatsApp, Instagram y Messenger conectados a tu CRM
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          {!!channels.length && (
            <Button variant="outlined" disabled={checking} onClick={() => runDiagnose(false)} sx={{ fontSize: '0.82rem' }}>
              {checking ? <CircularProgress size={16} /> : 'Verificar canales'}
            </Button>
          )}
          <Tooltip title="Avanzado: cargar un canal con IDs y token a mano">
            <Button variant="outlined" startIcon={<AddIcon />} onClick={openCreate} sx={{ fontSize: '0.82rem' }}>
              Carga manual
            </Button>
          </Tooltip>
          <Tooltip title="Avanzado: pegar un token de usuario del sistema y detectar todos los activos">
            <Button variant="outlined" startIcon={<BoltIcon />} onClick={openWizard} sx={{ fontSize: '0.82rem' }}>
              Conectar con token
            </Button>
          </Tooltip>
          <Tooltip title="Conectar Instagram y páginas de Facebook con tu login de Meta">
            <span>
              <Button variant="contained" onClick={startSocialLogin} disabled={esConnecting || !esConfig}
                sx={{ fontSize: '0.82rem', bgcolor: '#E1306C', '&:hover': { bgcolor: '#C13584' } }}>
                Conectar IG/Facebook
              </Button>
            </span>
          </Tooltip>
          <Tooltip title={esConfig && !esConfig.ready ? 'Pendiente de configuración en Meta (config_id)' : ''}>
            <span>
              <Button variant="contained" onClick={e => setWaMenuAnchor(e.currentTarget)} disabled={esConnecting || !esConfig}
                sx={{ fontSize: '0.82rem', bgcolor: '#25D366', '&:hover': { bgcolor: '#1DA851' } }}>
                {esConnecting ? <CircularProgress size={18} /> : 'Conectar WhatsApp'}
              </Button>
            </span>
          </Tooltip>
          <Menu anchorEl={waMenuAnchor} open={!!waMenuAnchor} onClose={() => setWaMenuAnchor(null)}>
            <MenuItem onClick={() => { setWaMenuAnchor(null); startEmbeddedSignup(''); }}>
              <Box>
                <Typography sx={{ fontSize: '0.85rem', fontWeight: 600 }}>Número nuevo o de la API</Typography>
                <Typography sx={{ fontSize: '0.72rem', color: 'text.secondary' }}>
                  Dar de alta un número o migrar uno que ya usa la API de WhatsApp
                </Typography>
              </Box>
            </MenuItem>
            <MenuItem onClick={() => { setWaMenuAnchor(null); startEmbeddedSignup('whatsapp_business_app_onboarding'); }}>
              <Box>
                <Typography sx={{ fontSize: '0.85rem', fontWeight: 600 }}>Número de la app WhatsApp Business 📱</Typography>
                <Typography sx={{ fontSize: '0.72rem', color: 'text.secondary' }}>
                  El número sigue en el celular y también atiende el CRM (se empareja con QR)
                </Typography>
              </Box>
            </MenuItem>
          </Menu>
        </Stack>
      </Stack>

      {/* Webhook panel */}
      <Paper sx={{ p: 2, mb: 3, borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <Typography sx={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', mb: 1, fontWeight: 600 }}>Configuración del webhook (Meta Developers)</Typography>

        {/* Callback URL */}
        <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 0.5, mb: 0.3 }}>Callback URL</Typography>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
          <Typography sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace', color: '#E8A020', flexGrow: 1, wordBreak: 'break-all' }}>
            {WEBHOOK_URL}
          </Typography>
          <IconButton size="small" onClick={() => copyText(WEBHOOK_URL, 'Callback URL')}><CopyIcon sx={{ fontSize: 14 }} /></IconButton>
        </Stack>

        {/* Verify token (one per company) */}
        {companyVerifyToken && (
          <>
            <Typography sx={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 0.5, mb: 0.3 }}>Verify Token</Typography>
            <Stack direction="row" spacing={1} alignItems="center">
              <Typography sx={{ fontSize: '0.78rem', fontFamily: '"JetBrains Mono", monospace', color: '#34D399', flexGrow: 1, wordBreak: 'break-all' }}>
                {companyVerifyToken}
              </Typography>
              <IconButton size="small" onClick={() => copyText(companyVerifyToken, 'Verify Token')}><CopyIcon sx={{ fontSize: 14 }} /></IconButton>
            </Stack>
          </>
        )}

        <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.3)', mt: 1 }}>
          Una sola URL y un solo verify token para todos tus canales (WhatsApp, Instagram, Messenger). Se genera automáticamente al crear el primer canal.
        </Typography>
      </Paper>

      {/* Channels list */}
      {channels.length === 0 ? (
        <Paper sx={{ p: 4, textAlign: 'center', borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <Typography sx={{ color: 'rgba(255,255,255,0.4)', mb: 2 }}>No hay canales configurados</Typography>
          <Button variant="contained" startIcon={<BoltIcon />} onClick={openWizard}>Conectar con Meta</Button>
        </Paper>
      ) : (
        <Stack spacing={1.5}>
          {channels.map((ch, i) => {
            const m = meta(ch.channel_type);
            const test = testResults[ch.id];
            const d = diag[ch.id];
            return (
              <Paper
                key={ch.id}
                className={`anim-fade-up anim-fade-up-${i}`}
                sx={{
                  p: 2, borderRadius: '10px',
                  background: 'rgba(255,255,255,0.02)',
                  border: `1px solid ${ch.status === 'active' ? 'rgba(255,255,255,0.06)' : 'rgba(239,83,80,0.15)'}`,
                  transition: 'border-color 200ms ease',
                  '&:hover': { borderColor: `${m.color}33` },
                }}
              >
                <Stack direction="row" alignItems="center" spacing={2}>
                  {/* Icon */}
                  <Box sx={{
                    width: 40, height: 40, borderRadius: '10px',
                    background: `${m.color}18`, border: `1px solid ${m.color}30`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: '"Syne", sans-serif', fontWeight: 800, fontSize: '1rem', color: m.color,
                  }}>
                    {m.icon}
                  </Box>

                  {/* Info */}
                  <Box sx={{ flexGrow: 1 }}>
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography sx={{ fontWeight: 600, fontSize: '0.9rem', color: '#E8EBF2' }}>{ch.name}</Typography>
                      <Chip
                        size="small"
                        label={ch.status === 'active' ? 'Activo' : ch.status}
                        sx={{
                          height: 20, fontSize: '0.65rem', fontWeight: 600,
                          backgroundColor: ch.status === 'active' ? 'rgba(52,211,153,0.12)' : 'rgba(239,83,80,0.12)',
                          color: ch.status === 'active' ? '#34D399' : '#EF5350',
                        }}
                      />
                      {test && (
                        <Chip
                          size="small"
                          icon={test.ok ? <CheckIcon sx={{ fontSize: '12px !important' }} /> : <CancelIcon sx={{ fontSize: '12px !important' }} />}
                          label={test.ok ? 'Conectado' : (test.error === 'testing...' ? 'Verificando...' : 'Error')}
                          sx={{
                            height: 20, fontSize: '0.65rem',
                            backgroundColor: test.ok ? 'rgba(52,211,153,0.12)' : 'rgba(239,83,80,0.12)',
                            color: test.ok ? '#34D399' : '#EF5350',
                          }}
                        />
                      )}
                      {d && (
                        <Chip
                          size="small"
                          label={d.webhooks_ok && d.token_ok ? 'Recibe mensajes' : 'No recibe mensajes'}
                          sx={{
                            height: 20, fontSize: '0.65rem', fontWeight: 600,
                            backgroundColor: d.webhooks_ok && d.token_ok ? 'rgba(52,211,153,0.12)' : 'rgba(239,83,80,0.16)',
                            color: d.webhooks_ok && d.token_ok ? '#34D399' : '#EF5350',
                          }}
                        />
                      )}
                    </Stack>
                    <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', fontFamily: '"JetBrains Mono", monospace' }}>
                      {m.label} &middot;{' '}
                      <Box component="span" sx={{ color: 'rgba(255,255,255,0.65)', fontWeight: 600 }}>
                        {d?.display || ch.display || ch.external_id}
                      </Box>
                      {(d?.display || ch.display) && (
                        <Box component="span" sx={{ opacity: 0.5 }}> &middot; id {ch.external_id}</Box>
                      )}
                    </Typography>
                    {d?.problem && (
                      <Typography sx={{ fontSize: '0.72rem', color: '#EF5350', mt: 0.3 }}>
                        {d.problem}
                      </Typography>
                    )}
                  </Box>

                  {/* Verify token */}
                  {ch.verify_token && (
                    <Tooltip title="Copiar Verify Token">
                      <IconButton size="small" onClick={() => copyText(ch.verify_token, 'Verify Token')}>
                        <CopyIcon sx={{ fontSize: 14 }} />
                      </IconButton>
                    </Tooltip>
                  )}

                  {/* Actions */}
                  {d && !(d.webhooks_ok && d.token_ok) && (
                    <Button size="small" variant="contained" color="error" disabled={repairing === ch.id}
                      onClick={() => repairChannel(ch)}
                      sx={{ fontSize: '0.72rem', py: 0.2, textTransform: 'none' }}>
                      {repairing === ch.id ? <CircularProgress size={14} /> : 'Reparar'}
                    </Button>
                  )}
                  <Tooltip title="Probar conexión"><IconButton size="small" onClick={() => handleTest(ch)}><TestIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                  <Tooltip title="Editar"><IconButton size="small" onClick={() => openEdit(ch)}><EditIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                  {ch.status === 'active' ? (
                    <Tooltip title="Deshabilitar (reversible)">
                      <IconButton size="small" onClick={() => handleToggle(ch)}>
                        <CancelIcon sx={{ fontSize: 16, color: '#E8A020' }} />
                      </IconButton>
                    </Tooltip>
                  ) : (
                    <Tooltip title="Habilitar canal">
                      <IconButton size="small" onClick={() => handleToggle(ch)}>
                        <CheckIcon sx={{ fontSize: 16, color: '#34D399' }} />
                      </IconButton>
                    </Tooltip>
                  )}
                  <Tooltip title="Eliminar definitivamente">
                    <IconButton size="small" onClick={() => handleDelete(ch)}>
                      <DeleteIcon sx={{ fontSize: 16, color: 'rgba(239,83,80,0.6)' }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* Pixel de Meta: es una conexion mas con Meta, va junto a los canales */}
      <Paper sx={{ p: 2, mt: 3, borderRadius: '10px', background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.5 }}>
          <Typography sx={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.5)', fontWeight: 600 }}>Píxel de Meta</Typography>
          {pixel.verificacion?.ok && <Chip size="small" label="Verificado" sx={{ height: 20, fontSize: '0.65rem', bgcolor: 'rgba(52,211,153,0.14)', color: '#34D399' }} />}
        </Stack>
        <Typography sx={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.35)', mb: 2 }}>
          Cuando un lead pasa a una etapa de cierre en el Pipeline, el CRM le avisa al píxel que esa
          persona compró. Así las campañas aprenden a buscar gente parecida a la que realmente
          compra, y no solo a la que escribe.
        </Typography>

        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ alignItems: 'flex-start' }}>
          <TextField
            size="small" label="ID del píxel" value={pixelId}
            onChange={e => setPixelId(e.target.value.replace(/[^0-9]/g, ''))}
            sx={{ minWidth: 200 }}
          />
          <TextField
            size="small" label="Token propio (opcional)" type="password" value={pixelToken}
            onChange={e => setPixelToken(e.target.value)}
            placeholder={pixel.token_propio ? 'Ya hay uno cargado' : 'Se usa el de la conexión'}
            sx={{ minWidth: 220 }}
          />
          <Button variant="contained" disabled={pixelBusy} onClick={guardarPixel} sx={{ fontSize: '0.82rem' }}>Guardar</Button>
          <Button variant="outlined" disabled={pixelBusy} onClick={buscarPixeles} sx={{ fontSize: '0.82rem' }}>Buscar píxeles</Button>
        </Stack>

        {pixelOpciones.length > 0 && (
          <Box sx={{ mt: 2 }}>
            <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)' }}>
              Elegí el píxel de esta empresa. Mirá la cuenta publicitaria: el token puede ver píxeles de otras cuentas.
            </Typography>
            {pixelOpciones.map(p => (
              <Stack key={p.id} direction="row" alignItems="center" spacing={1} sx={{ py: 1, borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: '0.8rem', color: '#E8EBF2' }}>{p.name}</Typography>
                  <Typography sx={{ fontSize: '0.68rem', color: 'rgba(255,255,255,0.35)', fontFamily: '"JetBrains Mono", monospace' }}>
                    {p.cuenta} · {p.id}
                    {p.last_fired_time ? ` · último evento ${new Date(p.last_fired_time).toLocaleString('es-AR')}` : ' · sin eventos'}
                  </Typography>
                </Box>
                <Button size="small" onClick={() => setPixelId(p.id)} sx={{ fontSize: '0.75rem' }}>Usar este</Button>
              </Stack>
            ))}
          </Box>
        )}

        {pixel.pixel_id && (
          <Stack direction="row" spacing={1} sx={{ mt: 2, alignItems: 'center' }} flexWrap="wrap" useFlexGap>
            <TextField
              size="small" label="Código de prueba" value={pixelTestCode}
              onChange={e => setPixelTestCode(e.target.value)}
              helperText="Events Manager → Eventos de prueba (ej: TEST12345)"
              sx={{ minWidth: 200 }}
            />
            <Button disabled={pixelBusy || !pixelTestCode.trim()} onClick={probarPixel} sx={{ fontSize: '0.82rem' }}>
              Enviar evento de prueba
            </Button>
          </Stack>
        )}

        {pixel.verificacion && !pixel.verificacion.ok && (
          <Typography sx={{ fontSize: '0.75rem', color: '#FB923C', mt: 2 }}>{pixel.verificacion.detail}</Typography>
        )}
      </Paper>

      {/* Wizard "Conectar con Meta" */}
      <Dialog open={wizardOpen} onClose={() => !wizConnecting && setWizardOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700 }}>
          Conectar con Meta
        </DialogTitle>
        <DialogContent>
          {!wizAssets ? (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Typography sx={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.55)' }}>
                Pegá un access token de Meta (ideal: token de usuario del sistema, no vence) y detectamos
                automáticamente todos tus números de WhatsApp, cuentas de Instagram y páginas de Facebook.
                Sin buscar IDs a mano.
              </Typography>
              <TextField
                size="small" fullWidth autoFocus
                label="Access Token de Meta"
                type={wizShowToken ? 'text' : 'password'}
                value={wizToken}
                onChange={e => setWizToken(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') wizDiscover(); }}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton size="small" onClick={() => setWizShowToken(!wizShowToken)}>
                        {wizShowToken ? <VisibilityOff sx={{ fontSize: 16 }} /> : <Visibility sx={{ fontSize: 16 }} />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
                helperText="Business Manager → Configuración del negocio → Usuarios del sistema → Generar token"
              />
            </Stack>
          ) : (
            <Stack spacing={2} sx={{ mt: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Chip
                  size="small"
                  icon={<CheckIcon sx={{ fontSize: '13px !important' }} />}
                  label={`Token válido (${wizAssets.token_info.type === 'SYSTEM_USER' ? 'usuario del sistema' : wizAssets.token_info.type.toLowerCase()})`}
                  sx={{ backgroundColor: 'rgba(52,211,153,0.12)', color: '#34D399', fontWeight: 600 }}
                />
                <Chip
                  size="small"
                  label={wizAssets.token_info.never_expires ? 'No vence' : `Vence: ${new Date(wizAssets.token_info.expires_at * 1000).toLocaleDateString()}`}
                  sx={{
                    backgroundColor: wizAssets.token_info.never_expires ? 'rgba(255,255,255,0.06)' : 'rgba(232,160,32,0.12)',
                    color: wizAssets.token_info.never_expires ? 'rgba(255,255,255,0.5)' : '#E8A020',
                  }}
                />
              </Stack>

              {wizAssets.warnings.map((w, i) => (
                <Alert key={i} severity="warning" sx={{ py: 0, fontSize: '0.78rem' }}>{w}</Alert>
              ))}

              {wizAssets.token_info.foreign_app && (
                <Alert severity="warning" sx={{ fontSize: '0.78rem' }}>
                  Este token pertenece a <b>otra app de Meta</b> (id {wizAssets.token_info.app_id}), no a la del CRM.
                  Los mensajes entrantes van a llegar firmados por esa app: para que el CRM los acepte,
                  pegá el <b>App Secret</b> de esa app (developers.facebook.com → tu app → Configuración → Básica
                  → Clave secreta) y asegurate de que el webhook de esa app apunte a nuestra URL de Canales.
                  <TextField size="small" fullWidth sx={{ mt: 1 }} label="App Secret de esa app"
                    value={wizAppSecret} onChange={e => setWizAppSecret(e.target.value)} />
                </Alert>
              )}

              {([
                { type: 'whatsapp', title: 'WhatsApp', items: wizAssets.whatsapp.map(w => ({ id: w.id, primary: w.verified_name || w.display_phone_number, secondary: `${w.display_phone_number} · ${w.waba_name}`, already: w.already_connected })) },
                { type: 'instagram', title: 'Instagram', items: wizAssets.instagram.map(i2 => ({ id: i2.id, primary: `@${i2.username}`, secondary: `Página: ${i2.page_name}`, already: i2.already_connected })) },
                { type: 'messenger', title: 'Messenger', items: wizAssets.messenger.map(p => ({ id: p.id, primary: p.name, secondary: `Página ${p.id}`, already: p.already_connected })) },
              ] as const).map(group => group.items.length > 0 && (
                <Box key={group.type}>
                  <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: CHANNEL_META[group.type].color, textTransform: 'uppercase', letterSpacing: 0.5, mb: 0.5 }}>
                    {group.title}
                  </Typography>
                  <Stack spacing={0.5}>
                    {group.items.map(item => {
                      const key = `${group.type}:${item.id}`;
                      return (
                        <Paper
                          key={key}
                          onClick={() => !item.already && wizToggle(key)}
                          sx={{
                            p: 1, px: 1.5, borderRadius: '8px', display: 'flex', alignItems: 'center',
                            cursor: item.already ? 'default' : 'pointer',
                            background: 'rgba(255,255,255,0.02)',
                            border: `1px solid ${wizSelected.has(key) ? `${CHANNEL_META[group.type].color}55` : 'rgba(255,255,255,0.06)'}`,
                            opacity: item.already ? 0.55 : 1,
                            transition: 'border-color 150ms ease',
                          }}
                        >
                          <Checkbox size="small" checked={wizSelected.has(key)} disabled={item.already} sx={{ p: 0.5, mr: 1 }} />
                          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                            <Typography sx={{ fontSize: '0.85rem', fontWeight: 600, color: '#E8EBF2' }}>{item.primary}</Typography>
                            <Typography sx={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.35)', fontFamily: '"JetBrains Mono", monospace' }} noWrap>
                              {item.secondary}
                            </Typography>
                          </Box>
                          {item.already && (
                            <Chip size="small" label="Ya conectado" sx={{ height: 20, fontSize: '0.62rem', backgroundColor: 'rgba(52,211,153,0.12)', color: '#34D399' }} />
                          )}
                        </Paper>
                      );
                    })}
                  </Stack>
                </Box>
              ))}

              {wizAssets.whatsapp.length + wizAssets.instagram.length + wizAssets.messenger.length === 0 && (
                <Alert severity="info" sx={{ fontSize: '0.8rem' }}>
                  El token es válido pero no da acceso a ningún activo. Revisá que el usuario del sistema tenga activos asignados en Business Manager.
                </Alert>
              )}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWizardOpen(false)} disabled={wizConnecting}>Cancelar</Button>
          {wizAssets && (
            <Button onClick={() => { setWizAssets(null); setWizSelected(new Set()); }} disabled={wizConnecting}>
              Cambiar token
            </Button>
          )}
          {!wizAssets ? (
            <Button variant="contained" onClick={wizDiscover} disabled={wizDiscovering || !wizToken.trim()}>
              {wizDiscovering ? <CircularProgress size={18} /> : 'Detectar activos'}
            </Button>
          ) : (
            <Button variant="contained" onClick={wizConnect} disabled={wizConnecting || wizSelected.size === 0}>
              {wizConnecting ? <CircularProgress size={18} /> : `Conectar ${wizSelected.size || ''}`}
            </Button>
          )}
        </DialogActions>
      </Dialog>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontFamily: '"Syne", sans-serif', fontWeight: 700 }}>
          {editing ? 'Editar canal' : 'Agregar canal'}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {!editing && (
              <FormControl fullWidth size="small">
                <InputLabel>Tipo de canal</InputLabel>
                <Select value={formType} label="Tipo de canal" onChange={e => setFormType(e.target.value)}>
                  <MenuItem value="whatsapp">WhatsApp Cloud API</MenuItem>
                  <MenuItem value="instagram">Instagram DMs</MenuItem>
                  <MenuItem value="messenger">Facebook Messenger</MenuItem>
                </Select>
              </FormControl>
            )}

            <TextField
              size="small" fullWidth
              label="Nombre del canal"
              placeholder={meta(formType).label}
              value={formName}
              onChange={e => setFormName(e.target.value)}
              helperText="Nombre para identificar este canal (ej: WhatsApp Principal, IG Empresa)"
            />

            <TextField
              size="small" fullWidth required
              label={formType === 'whatsapp' ? 'Phone Number ID' : formType === 'instagram' ? 'IG Account ID' : 'Page ID'}
              value={formExternalId}
              onChange={e => setFormExternalId(e.target.value)}
              helperText={
                formType === 'whatsapp'
                  ? 'Lo encontrás en Meta Developers → WhatsApp → Configuración de API'
                  : formType === 'instagram'
                  ? 'ID de la cuenta profesional de Instagram'
                  : 'ID de la página de Facebook'
              }
            />

            <TextField
              size="small" fullWidth
              label="Access Token"
              type={showSecrets ? 'text' : 'password'}
              value={formToken}
              onChange={e => setFormToken(e.target.value)}
              helperText={editing ? 'Dejá en blanco para mantener el actual' : ''}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setShowSecrets(!showSecrets)}>
                      {showSecrets ? <VisibilityOff sx={{ fontSize: 16 }} /> : <Visibility sx={{ fontSize: 16 }} />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
            />

            {formType === 'whatsapp' && (
              <TextField
                size="small" fullWidth
                label="App Secret"
                type={showSecrets ? 'text' : 'password'}
                value={formAppSecret}
                onChange={e => setFormAppSecret(e.target.value)}
                helperText="Recomendado para verificar firmas de webhook"
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancelar</Button>
          <Button variant="contained" onClick={handleSave} disabled={saving || !formExternalId.trim()}>
            {saving ? <CircularProgress size={18} /> : editing ? 'Guardar' : 'Crear canal'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
};

export default Connections;
